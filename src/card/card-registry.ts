/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Tracks the last completed streaming card per conversation so that subsequent
 * outbound deliveries (e.g. subagent announce results) can UPDATE the
 * existing card instead of sending a new message.
 *
 * This avoids the confusing UX where the first card shows "已完成" but
 * a second card appears later with the actual subagent result.
 */

import { larkLogger } from '../core/lark-logger';

const log = larkLogger('card/registry');

/** Max age before an entry is considered stale and ignored (5 min). */
const TTL_MS = 5 * 60 * 1000;

/**
 * Build a conversation-scoped registry key that includes threadId so that
 * replies in different threads of the same chat are tracked independently.
 */
export function buildConversationKey(ctx: { to: string; accountId?: string; threadId?: string }): string {
  return `feishu|${ctx.to}|${ctx.accountId ?? ''}|${ctx.threadId ?? ''}`;
}

export type CardPhase =
  | 'streaming' // Main agent is streaming its reply
  | 'waiting_subagents' // Main reply done, subagents still running
  | 'merging' // Currently merging a subagent result
  | 'completed' // All done
  | 'aborted'; // Abnormally terminated

export interface CardEntry {
  /** The IM message ID of the completed streaming card. */
  messageId: string;
  /** The CardKit card ID (if available, for CardKit v2 updates). */
  cardKitCardId: string | null;
  /** Current CardKit sequence number (for ordering updates). */
  cardKitSequence: number;
  /** The completed display text shown in the card (accumulates with merges). */
  completedText: string;
  /** Whether the CardKit streaming mode is still open (needs closing on merge). */
  streamingOpen: boolean;
  /** Dispatch start time (for calculating elapsed time in footer). */
  startedAt: number;
  /** Footer config (controls which metrics are displayed). */
  footer?: {
    status?: boolean;
    elapsed?: boolean;
    tokens?: boolean;
    cache?: boolean;
    context?: boolean;
    model?: boolean;
  };
  /** Timestamp of registration. */
  registeredAt: number;
  /** Explicit lifecycle phase of the card entry. */
  phase: CardPhase;
  /** IDs of completions already applied (for dedup). */
  appliedCompletionIds: string[];
  /**
   * Completions that arrived while the card was still in `streaming` phase.
   * Flushed by reply-dispatcher.onIdle() once the phase transitions to
   * `waiting_subagents`.
   */
  pendingCompletions: Array<{ text: string; completionId?: string }>;
  /**
   * Set to true by `finalizeCardAfterSubagents` when all subagents ended
   * while the card was still in `streaming` phase.  `reply-dispatcher.onIdle()`
   * checks this to know it should flush pending completions and finalize
   * immediately (instead of waiting for more subagent_ended events).
   */
  allSubagentsDone?: boolean;
  /** Session key for footer metrics lookup at finalization time. */
  sessionKey?: string;
  /**
   * Unique ID for this dispatch round.  Used to scope subagent tracking —
   * only subagents that carry this dispatchId are allowed to merge/finalize
   * against this card.  Prevents cross-dispatch contamination when a second
   * request arrives while the first dispatch's subagents are still running.
   */
  dispatchId: string;
}

const entries = new Map<string, CardEntry>();

/** Monotonic counter for generating dispatchIds. */
let dispatchCounter = 0;

/** Generate a unique dispatch ID for a new dispatch round. */
export function generateDispatchId(): string {
  return `d-${++dispatchCounter}-${Date.now()}`;
}

/**
 * Register (or overwrite) a streaming card entry for a conversation.
 *
 * If there is an existing non-terminal entry for this conversation, it is
 * evicted (logged as superseded).  The caller should also reset the subagent
 * tracker for the conversation when this happens.
 *
 * @returns `{ evicted: true, oldDispatchId }` when a stale entry was
 *   replaced, so the caller can clean up orphaned subagent tracking.
 */
export function registerCompletedCard(params: {
  context: { to: string; accountId?: string; threadId?: string };
  messageId: string;
  cardKitCardId: string | null;
  cardKitSequence: number;
  completedText: string;
  streamingOpen?: boolean;
  startedAt?: number;
  footer?: {
    status?: boolean;
    elapsed?: boolean;
    tokens?: boolean;
    cache?: boolean;
    context?: boolean;
    model?: boolean;
  };
  phase?: CardPhase;
  appliedCompletionIds?: string[];
  pendingCompletions?: CardEntry['pendingCompletions'];
  sessionKey?: string;
  dispatchId: string;
}): { evicted: boolean; oldDispatchId?: string } {
  const key = buildConversationKey(params.context);

  // Check for a stale entry being superseded
  const existing = entries.get(key);
  let evicted = false;
  let oldDispatchId: string | undefined;
  if (existing && existing.phase !== 'completed' && existing.phase !== 'aborted') {
    if (existing.dispatchId !== params.dispatchId) {
      log.warn('evicting stale card entry (superseded by new dispatch)', {
        key,
        oldMessageId: existing.messageId,
        oldPhase: existing.phase,
        oldDispatchId: existing.dispatchId,
        newDispatchId: params.dispatchId,
      });
      evicted = true;
      oldDispatchId = existing.dispatchId;
    }
  }

  entries.set(key, {
    messageId: params.messageId,
    cardKitCardId: params.cardKitCardId,
    cardKitSequence: params.cardKitSequence,
    completedText: params.completedText,
    streamingOpen: params.streamingOpen ?? false,
    startedAt: params.startedAt ?? Date.now(),
    footer: params.footer,
    registeredAt: Date.now(),
    phase: params.phase ?? 'waiting_subagents',
    appliedCompletionIds: params.appliedCompletionIds ?? [],
    pendingCompletions: params.pendingCompletions ?? [],
    sessionKey: params.sessionKey,
    dispatchId: params.dispatchId,
  });
  log.info('registered card', {
    key,
    messageId: params.messageId,
    phase: params.phase ?? 'waiting_subagents',
    dispatchId: params.dispatchId,
  });
  return { evicted, oldDispatchId };
}

/**
 * Read the card entry for a conversation key WITHOUT removing it.
 * Returns `undefined` if no entry exists or it has expired.
 */
export function getCompletedCard(key: string): CardEntry | undefined {
  const entry = entries.get(key);
  if (!entry) return undefined;

  if (Date.now() - entry.registeredAt > TTL_MS) {
    log.info('card entry expired, discarding', { key });
    entries.delete(key);
    return undefined;
  }

  return entry;
}

/**
 * Update specific fields of an existing card entry.
 * No-op if the entry does not exist.
 */
export function updateCompletedCard(key: string, updates: Partial<CardEntry>): void {
  const entry = entries.get(key);
  if (!entry) return;
  Object.assign(entry, updates, { registeredAt: Date.now() });
}

/**
 * Remove a card entry.
 */
export function removeCompletedCard(key: string): void {
  if (entries.delete(key)) {
    log.info('removed card entry', { key });
  }
}

/**
 * Try to acquire a merge lock on the card entry.
 * Returns the entry if the lock was acquired, `undefined` otherwise.
 *
 * Sets `phase` to `'merging'` while the caller performs the merge.
 * Caller MUST call `releaseMergeLock()` when done.
 */
export function acquireMergeLock(key: string): CardEntry | undefined {
  const entry = getCompletedCard(key);
  if (!entry) return undefined;

  // Only allow merging from waiting_subagents phase
  if (entry.phase !== 'waiting_subagents') {
    log.info('acquireMergeLock: rejected, phase is not waiting_subagents', { key, phase: entry.phase });
    return undefined;
  }

  updateCompletedCard(key, { phase: 'merging' });
  return entry;
}

/**
 * Release the merge lock and apply updated state.
 */
export function releaseMergeLock(key: string, updates: Partial<CardEntry>): void {
  updateCompletedCard(key, { ...updates, phase: updates.phase ?? 'waiting_subagents' });
}
