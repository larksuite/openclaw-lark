/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Tracks active subagent runs per conversation so the streaming card can show
 * "处理中..." instead of "已完成" while subagents are still running.
 *
 * Each subagent is tagged with a `dispatchId` so that runs from different
 * dispatch rounds (e.g. two requests in the same DM) don't interfere with
 * each other.  When a new dispatch starts, the old dispatch's subagents are
 * orphaned and will be ignored on completion.
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import { larkLogger } from '../core/lark-logger';
import { buildMarkdownCard, updateCardFeishu } from '../messaging/outbound/send';
import { buildConversationKey, getCompletedCard, removeCompletedCard, updateCompletedCard } from './card-registry';
import { buildCardContent, toCardKit2 } from './builder';
import { setCardStreamingMode, updateCardKitCard } from './cardkit';
import { resolveFooterSessionMetrics } from './footer-metrics';

const log = larkLogger('card/subagent-tracker');

interface ActiveRun {
  to: string;
  accountId?: string;
  threadId?: string;
  dispatchId?: string;
}

/** Active subagent runs keyed by runId → conversation + dispatch context. */
const activeRuns = new Map<string, ActiveRun>();

/** Per-conversation active subagent count. Key: conversationKey. */
const chatCounts = new Map<string, number>();

/** Per-dispatch active subagent count. Key: dispatchId. */
const dispatchCounts = new Map<string, number>();

/** Per-conversation current dispatchId. */
const currentDispatchIds = new Map<string, string>();

/** Per-conversation main agent sessionKey (for footer metrics). */
const currentSessionKeys = new Map<string, string>();

// ---------------------------------------------------------------------------
// Spawn / end tracking
// ---------------------------------------------------------------------------

/**
 * Record a subagent spawn for a conversation.
 */
export function trackSubagentSpawned(params: {
  runId: string;
  to: string;
  accountId?: string;
  threadId?: string;
}): void {
  const { runId, to, accountId, threadId } = params;
  const key = buildConversationKey({ to, accountId, threadId });

  const dispatchId = currentDispatchIds.get(key);
  activeRuns.set(runId, { to, accountId, threadId, dispatchId });

  chatCounts.set(key, (chatCounts.get(key) ?? 0) + 1);
  if (dispatchId) {
    dispatchCounts.set(dispatchId, (dispatchCounts.get(dispatchId) ?? 0) + 1);
  }

  // Clear early-finish flag — a new subagent just spawned.
  const entry = getCompletedCard(key);
  if (entry?.allSubagentsDone) {
    updateCompletedCard(key, { allSubagentsDone: false });
  }

  log.info('subagent spawned', { runId, to, count: chatCounts.get(key), dispatchId });
}

export interface SubagentEndedResult {
  allDone: boolean;
  conversationContext?: { to: string; accountId?: string; threadId?: string };
  dispatchId?: string;
}

/**
 * Record a subagent end and return whether all subagents for this
 * conversation are now complete.
 */
export function trackSubagentEnded(runId: string): SubagentEndedResult {
  const entry = activeRuns.get(runId);
  if (!entry) return { allDone: false };

  activeRuns.delete(runId);

  // Decrement per-dispatch count
  if (entry.dispatchId) {
    const dc = (dispatchCounts.get(entry.dispatchId) ?? 1) - 1;
    if (dc <= 0) dispatchCounts.delete(entry.dispatchId);
    else dispatchCounts.set(entry.dispatchId, dc);
  }

  // Decrement per-conversation count
  const key = buildConversationKey({ to: entry.to, accountId: entry.accountId, threadId: entry.threadId });
  const prev = chatCounts.get(key) ?? 1;

  if (prev <= 1) {
    chatCounts.delete(key);
    log.info('subagent ended (all done)', { runId, to: entry.to, remaining: 0, dispatchId: entry.dispatchId });
    return { allDone: true, conversationContext: entry, dispatchId: entry.dispatchId };
  }

  chatCounts.set(key, prev - 1);
  log.info('subagent ended', { runId, to: entry.to, remaining: prev - 1, dispatchId: entry.dispatchId });
  return { allDone: false };
}

// ---------------------------------------------------------------------------
// Per-conversation state (dispatchId, sessionKey)
// ---------------------------------------------------------------------------

/**
 * Set the current dispatchId for a conversation.
 */
export function setCurrentDispatchId(
  to: string,
  accountId: string | undefined,
  threadId: string | undefined,
  dispatchId: string,
): void {
  const key = buildConversationKey({ to, accountId, threadId });
  currentDispatchIds.set(key, dispatchId);
}

/**
 * Set the main agent's sessionKey for a conversation.
 */
export function setCurrentSessionKey(
  to: string,
  accountId: string | undefined,
  threadId: string | undefined,
  sessionKey: string,
): void {
  const key = buildConversationKey({ to, accountId, threadId });
  currentSessionKeys.set(key, sessionKey);
}

/**
 * Return the main agent's sessionKey for a conversation, if any.
 */
export function getCurrentSessionKey(
  to: string,
  accountId: string | undefined,
  threadId: string | undefined,
): string | undefined {
  const key = buildConversationKey({ to, accountId, threadId });
  return currentSessionKeys.get(key);
}

// ---------------------------------------------------------------------------
// Eviction (cross-dispatch isolation)
// ---------------------------------------------------------------------------

/**
 * Evict all subagent runs belonging to an old dispatchId for a conversation.
 * Also clears stale pendingCompletions.
 */
export function evictSubagentsForDispatch(
  to: string,
  accountId: string | undefined,
  threadId: string | undefined,
  oldDispatchId: string,
): void {
  const key = buildConversationKey({ to, accountId, threadId });

  let evictedCount = 0;
  for (const [runId, run] of activeRuns) {
    if (run.dispatchId === oldDispatchId) {
      activeRuns.delete(runId);
      evictedCount++;
    }
  }

  if (evictedCount > 0) {
    const prev = chatCounts.get(key) ?? 0;
    const next = Math.max(0, prev - evictedCount);
    if (next <= 0) chatCounts.delete(key);
    else chatCounts.set(key, next);

    dispatchCounts.delete(oldDispatchId);
    log.info('evicted orphaned subagents', { key, oldDispatchId, evictedCount, remaining: next });
  }

  const entry = getCompletedCard(key);
  if (entry && entry.pendingCompletions.length > 0) {
    updateCompletedCard(key, { pendingCompletions: [] });
    log.info('cleared stale pendingCompletions after evict', { key, cleared: entry.pendingCompletions.length });
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Check whether a conversation has any active subagent runs.
 */
export function hasActiveSubagents(to: string, accountId?: string, threadId?: string): boolean {
  const key = buildConversationKey({ to, accountId, threadId });
  return (chatCounts.get(key) ?? 0) > 0;
}

/**
 * Check whether there is at least one active subagent run tagged with the
 * given dispatchId.  O(1) via per-dispatch counter.
 */
export function hasActiveRunsForDispatch(
  _to: string,
  _accountId: string | undefined,
  _threadId: string | undefined,
  dispatchId: string,
): boolean {
  return (dispatchCounts.get(dispatchId) ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Card finalization
// ---------------------------------------------------------------------------

/**
 * Finalize the streaming card for a conversation after all subagents have
 * ended.
 *
 * If the card is still in `streaming` phase (all subagents finished before
 * the main agent's onIdle), sets `allSubagentsDone=true` so that
 * reply-dispatcher.onIdle() can flush pending completions and finalize.
 */
export async function finalizeCardAfterSubagents(params: {
  cfg: ClawdbotConfig;
  to: string;
  accountId?: string;
  threadId?: string;
  expectedDispatchId?: string;
}): Promise<void> {
  const { cfg, to, accountId, threadId, expectedDispatchId } = params;
  const key = buildConversationKey({ to, accountId, threadId });

  const entry = getCompletedCard(key);
  if (!entry) {
    log.info('finalizeCardAfterSubagents: no card entry, skipping', { key });
    return;
  }

  if (expectedDispatchId && entry.dispatchId !== expectedDispatchId) {
    log.info('finalizeCardAfterSubagents: dispatchId mismatch, skipping', {
      key,
      expected: expectedDispatchId,
      actual: entry.dispatchId,
    });
    return;
  }

  if (entry.phase === 'streaming') {
    log.info('finalizeCardAfterSubagents: card still streaming, marking allSubagentsDone', { key });
    updateCompletedCard(key, { allSubagentsDone: true });
    return;
  }

  if (entry.phase !== 'waiting_subagents') {
    log.info('finalizeCardAfterSubagents: card not in waiting phase, skipping', { key, phase: entry.phase });
    removeCompletedCard(key);
    return;
  }

  await doFinalize(cfg, key, entry, accountId);
}

/**
 * Unconditionally finalize a card entry: close streaming, send final update,
 * clean up per-conversation state.
 */
export async function doFinalize(
  cfg: ClawdbotConfig,
  key: string,
  entry: NonNullable<ReturnType<typeof getCompletedCard>>,
  accountId?: string,
): Promise<void> {
  const elapsedMs = Date.now() - entry.startedAt;

  const footerNeedsMetrics =
    entry.footer &&
    (entry.footer.tokens !== false ||
      entry.footer.cache !== false ||
      entry.footer.context !== false ||
      entry.footer.model !== false);
  const footerMetrics =
    footerNeedsMetrics && entry.sessionKey
      ? await resolveFooterSessionMetrics({ cfg, sessionKey: entry.sessionKey })
      : undefined;

  log.info('doFinalize: closing streaming + finalizing', {
    key,
    messageId: entry.messageId,
    dispatchId: entry.dispatchId,
    elapsedMs,
  });

  try {
    let nextSeq = entry.cardKitSequence;

    if (entry.cardKitCardId) {
      if (entry.streamingOpen) {
        nextSeq += 1;
        await setCardStreamingMode({
          cfg,
          cardId: entry.cardKitCardId,
          streamingMode: false,
          sequence: nextSeq,
          accountId,
        });
      }

      nextSeq += 1;
      await updateCardKitCard({
        cfg,
        cardId: entry.cardKitCardId,
        card: toCardKit2(
          buildCardContent('complete', {
            text: entry.completedText,
            elapsedMs,
            footer: entry.footer,
            footerMetrics,
          }),
        ),
        sequence: nextSeq,
        accountId,
      });
    } else {
      await updateCardFeishu({
        cfg,
        messageId: entry.messageId,
        card: buildMarkdownCard(entry.completedText),
        accountId,
      });
    }

    updateCompletedCard(key, { phase: 'completed', streamingOpen: false });
  } catch (err) {
    log.warn('doFinalize: failed', { error: String(err) });
  }

  // Clean up per-conversation state
  removeCompletedCard(key);
  currentDispatchIds.delete(key);
  currentSessionKeys.delete(key);
}
