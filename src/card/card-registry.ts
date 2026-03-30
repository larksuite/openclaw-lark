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

export interface CardEntry {
  /** The IM message ID of the completed streaming card. */
  messageId: string;
  /** The CardKit card ID (if available, for CardKit v2 updates). */
  cardKitCardId: string | null;
  /** Current CardKit sequence number (for ordering updates). */
  cardKitSequence: number;
  /** The completed display text shown in the card (accumulates with merges). */
  completedText: string;
  /** The original streaming card text (never changes, used for dedup). */
  originalCompletedText: string;
  /** Whether the CardKit streaming mode is still open (needs closing on merge). */
  streamingOpen: boolean;
  /** Dispatch start time (for calculating elapsed time in footer). */
  startedAt: number;
  /** Footer config (status/elapsed visibility). */
  footer?: { status?: boolean; elapsed?: boolean };
  /** Timestamp of registration. */
  registeredAt: number;
  /** Thread ID this card belongs to (conversation scope). */
  threadId?: string;
  /** Explicit lifecycle phase of the card entry. */
  phase: 'main_streaming' | 'main_done_waiting_subagents' | 'completed' | 'aborted' | 'error';
  /** Number of subagents that are still running and expected to merge. */
  activeSubagentCount: number;
  /** Completions that arrived while the main card was still streaming. */
  bufferedCompletions: Array<{ text: string; completionId?: string; arrivedAt: number }>;
  /** IDs of completions already applied (for dedup). */
  appliedCompletionIds: string[];
}

const entries = new Map<string, CardEntry>();

/**
 * Register a completed streaming card so outbound deliveries can update it.
 */
export function registerCompletedCard(params: {
  context: { to: string; accountId?: string; threadId?: string };
  messageId: string;
  cardKitCardId: string | null;
  cardKitSequence: number;
  completedText: string;
  originalCompletedText?: string;
  streamingOpen?: boolean;
  startedAt?: number;
  footer?: { status?: boolean; elapsed?: boolean };
  phase?: CardEntry['phase'];
  activeSubagentCount?: number;
  bufferedCompletions?: CardEntry['bufferedCompletions'];
  appliedCompletionIds?: string[];
}): void {
  const key = buildConversationKey(params.context);
  entries.set(key, {
    messageId: params.messageId,
    cardKitCardId: params.cardKitCardId,
    cardKitSequence: params.cardKitSequence,
    completedText: params.completedText,
    originalCompletedText: params.originalCompletedText ?? params.completedText,
    streamingOpen: params.streamingOpen ?? false,
    startedAt: params.startedAt ?? Date.now(),
    footer: params.footer,
    registeredAt: Date.now(),
    threadId: params.context.threadId,
    phase: params.phase ?? 'main_done_waiting_subagents',
    activeSubagentCount: params.activeSubagentCount ?? 0,
    bufferedCompletions: params.bufferedCompletions ?? [],
    appliedCompletionIds: params.appliedCompletionIds ?? [],
  });
  log.info('registered completed card', { key, messageId: params.messageId, phase: params.phase ?? 'main_done_waiting_subagents' });
}

/**
 * Consume (take and remove) the last completed card for a conversation key.
 * Returns `undefined` if no card is registered or the entry has expired.
 */
export function consumeCompletedCard(key: string): CardEntry | undefined {
  const entry = entries.get(key);

  if (!entry) return undefined;

  entries.delete(key);

  if (Date.now() - entry.registeredAt > TTL_MS) {
    log.info('card entry expired, discarding', { key });
    return undefined;
  }

  log.info('consumed completed card', { key, messageId: entry.messageId });
  return entry;
}

/**
 * Remove a completed card entry without returning it.
 * Used to clean up stale entries when all subagents have ended.
 */
export function removeCompletedCard(key: string): void {
  if (entries.delete(key)) {
    log.info('removed stale card entry', { key });
  }
}
