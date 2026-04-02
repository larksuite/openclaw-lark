/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Dedicated handler for subagent completion merges.
 *
 * Merges subagent result text into the main streaming card WITHOUT
 * closing streaming or finalizing.  Card finalization is handled by
 * the subagent tracker once ALL subagents have ended.
 *
 * Key invariants:
 * - `streaming` phase: completions are stored in `pendingCompletions` on the
 *   CardEntry and replayed when the reply-dispatcher transitions to
 *   `waiting_subagents` (via `flushPendingCompletions`).
 * - `waiting_subagents` phase: completions are merged immediately.
 * - `merging` phase: completions are queued behind the in-flight merge and
 *   the caller blocks until the queued merge resolves (returning the real
 *   result, not an optimistic `merged`).
 * - dispatchId is verified against the card entry so that completions from
 *   a superseded dispatch are rejected.
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import { larkLogger } from '../core/lark-logger';
import { normalizeFeishuTarget } from '../core/targets';
import {
  acquireMergeLock,
  buildConversationKey,
  getCompletedCard,
  releaseMergeLock,
  updateCompletedCard,
} from './card-registry';
import { STREAMING_ELEMENT_ID } from './builder';
import { streamCardContent } from './cardkit';
import { hasActiveRunsForDispatch } from './subagent-tracker';

const log = larkLogger('card/subagent-completion-handler');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SubagentCompletionResult =
  | { status: 'merged'; messageId: string; chatId: string }
  | { status: 'buffered'; messageId: string; chatId: string }
  | { status: 'fallback' };

// ---------------------------------------------------------------------------
// Merge queue — serialises concurrent subagent completions per conversation.
// ---------------------------------------------------------------------------

const mergeQueues = new Map<string, Promise<void>>();

function enqueueMerge(key: string, fn: () => Promise<void>): Promise<void> {
  const prev = mergeQueues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  mergeQueues.set(key, next);
  next.finally(() => {
    if (mergeQueues.get(key) === next) mergeQueues.delete(key);
  });
  return next;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Try to merge a subagent completion text into the existing main streaming
 * card.  The card remains in streaming mode — it is NOT finalized here.
 * Finalization happens in `trackSubagentEnded()` when the last subagent ends.
 */
export async function handleSubagentCompletion(params: {
  cfg: ClawdbotConfig;
  to: string;
  accountId?: string;
  threadId?: string;
  text: string;
  completionId?: string;
}): Promise<SubagentCompletionResult> {
  const { cfg, to, accountId, threadId, text, completionId } = params;
  const chatId = normalizeFeishuTarget(to) ?? to;
  const key = buildConversationKey({ to: chatId, accountId, threadId });

  const existing = getCompletedCard(key);
  if (!existing) {
    log.info('handleSubagentCompletion: no card entry found', { key });
    return { status: 'fallback' };
  }

  // Terminal phases — late completions go standalone
  if (existing.phase === 'completed' || existing.phase === 'aborted') {
    log.info('handleSubagentCompletion: card in terminal phase, falling back', {
      phase: existing.phase,
      messageId: existing.messageId,
    });
    return { status: 'fallback' };
  }

  // ---- Per-completion dispatch isolation ----
  // The SDK does not pass a runId with sendText, so we cannot directly verify
  // which subagent produced this completion.  Instead we check: does the
  // tracker still have at least one activeRun tagged with the card's
  // dispatchId?  If not, all subagents for this dispatch have either been
  // evicted (new dispatch started) or already ended — this sendText is stale.
  if (existing.dispatchId && !hasActiveRunsForDispatch(chatId, accountId, threadId, existing.dispatchId)) {
    log.info('handleSubagentCompletion: no active runs for card dispatchId, likely stale — falling back', {
      key,
      cardDispatchId: existing.dispatchId,
    });
    return { status: 'fallback' };
  }

  // ---- P1 fix: real buffering for streaming phase ----
  // Store the completion on the CardEntry so it survives until onIdle flushes.
  if (existing.phase === 'streaming') {
    log.info('handleSubagentCompletion: main card still streaming, buffering on entry', { key, completionId });
    const pending = [...existing.pendingCompletions, { text, completionId }];
    updateCompletedCard(key, { pendingCompletions: pending });
    return { status: 'buffered', messageId: existing.messageId, chatId };
  }

  // ---- P2 fix: queue and wait for real result ----
  // For both `merging` and `waiting_subagents`, we enqueue and wait for the
  // actual merge result instead of returning an optimistic `merged`.
  let result: SubagentCompletionResult = { status: 'fallback' };
  await enqueueMerge(key, async () => {
    result = await mergeIntoCard({ cfg, chatId, accountId, threadId, key, text, completionId });
  });
  return result;
}

export interface FlushResult {
  /** Items that failed to merge and should be delivered standalone. */
  failed: Array<{ text: string; completionId?: string }>;
}

/**
 * Flush completions that were buffered while the main card was still streaming.
 * Called from reply-dispatcher.onIdle() after phase transitions to
 * `waiting_subagents`.
 *
 * Returns any items that failed to merge so the caller can deliver them as
 * standalone messages (preventing silent data loss).
 */
export async function flushPendingCompletions(params: {
  cfg: ClawdbotConfig;
  chatId: string;
  accountId?: string;
  threadId?: string;
}): Promise<FlushResult> {
  const { cfg, chatId, accountId, threadId } = params;
  const key = buildConversationKey({ to: chatId, accountId, threadId });

  const entry = getCompletedCard(key);
  if (!entry || entry.pendingCompletions.length === 0) return { failed: [] };

  log.info('flushPendingCompletions: flushing', { key, count: entry.pendingCompletions.length });

  const pending = [...entry.pendingCompletions];
  updateCompletedCard(key, { pendingCompletions: [] });

  const failed: FlushResult['failed'] = [];

  for (const item of pending) {
    let itemResult: SubagentCompletionResult = { status: 'fallback' };
    await enqueueMerge(key, async () => {
      itemResult = await mergeIntoCard({
        cfg,
        chatId,
        accountId,
        threadId,
        key,
        text: item.text,
        completionId: item.completionId,
      });
    });
    if (itemResult.status === 'fallback') {
      failed.push(item);
    }
  }

  if (failed.length > 0) {
    log.warn('flushPendingCompletions: some items failed', { key, failedCount: failed.length });
  }

  return { failed };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Push subagent text into the card.  Only updates the streaming content —
 * does NOT close streaming mode or send a final card.update.
 */
async function mergeIntoCard(params: {
  cfg: ClawdbotConfig;
  chatId: string;
  accountId?: string;
  threadId?: string;
  key: string;
  text: string;
  completionId?: string;
}): Promise<SubagentCompletionResult> {
  const { cfg, chatId, accountId, key, text, completionId } = params;

  const existing = acquireMergeLock(key);
  if (!existing) {
    log.info('mergeIntoCard: could not acquire lock', { key });
    return { status: 'fallback' };
  }

  // Dedup check
  if (completionId && existing.appliedCompletionIds.includes(completionId)) {
    log.info('mergeIntoCard: duplicate completionId, skipping', { completionId });
    releaseMergeLock(key, { phase: 'waiting_subagents' });
    return { status: 'merged', messageId: existing.messageId, chatId };
  }

  const mergedText = existing.completedText ? existing.completedText + '\n\n' + text : text;

  log.info('mergeIntoCard: pushing content (no finalize)', {
    messageId: existing.messageId,
    completionId,
  });

  try {
    let nextSeq = existing.cardKitSequence;

    if (existing.cardKitCardId && existing.streamingOpen) {
      // Push merged text — card stays in streaming mode
      nextSeq += 1;
      await streamCardContent({
        cfg,
        cardId: existing.cardKitCardId,
        elementId: STREAMING_ELEMENT_ID,
        content: mergedText,
        sequence: nextSeq,
        accountId,
      });
    }
    // If not streaming or no cardKitCardId, we just update registry text.
    // The finalization step (in trackSubagentEnded) will handle the final
    // card.update or legacy IM patch.

    const appliedCompletionIds = completionId
      ? [...existing.appliedCompletionIds, completionId]
      : existing.appliedCompletionIds;

    releaseMergeLock(key, {
      cardKitSequence: nextSeq,
      completedText: mergedText,
      streamingOpen: existing.streamingOpen,
      appliedCompletionIds,
      phase: 'waiting_subagents',
    });

    return { status: 'merged', messageId: existing.messageId, chatId };
  } catch (err) {
    log.warn('mergeIntoCard: content push failed', { error: String(err) });
    releaseMergeLock(key, { phase: 'waiting_subagents' });
    return { status: 'fallback' };
  }
}
