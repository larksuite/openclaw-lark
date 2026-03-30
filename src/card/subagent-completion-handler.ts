/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Dedicated handler for subagent completion merges.
 *
 * Isolates the "merge subagent result into main streaming card" logic that
 * previously lived inline in `outbound.ts sendText()`.  This module owns
 * the card-update flow and all phase transitions for the CardEntry state
 * machine.
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import { larkLogger } from '../core/lark-logger';
import { normalizeFeishuTarget } from '../core/targets';
import { STREAMING_ELEMENT_ID, buildCardContent, toCardKit2 } from './builder';
import {
  type CardEntry,
  buildConversationKey,
  consumeCompletedCard,
  registerCompletedCard,
} from './card-registry';
import { setCardStreamingMode, streamCardContent, updateCardKitCard } from './cardkit';
import { buildMarkdownCard, updateCardFeishu } from '../messaging/outbound/send';

const log = larkLogger('card/subagent-completion-handler');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SubagentCompletionResult =
  | { status: 'merged'; messageId: string; chatId: string }
  | { status: 'fallback' };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Try to merge a subagent completion text into the existing main streaming card.
 *
 * Returns `{ status: 'merged' }` when the card was updated (or buffered for
 * later merging while the main card is still streaming).
 * Returns `{ status: 'fallback' }` when no suitable card was found or the card
 * is already in a terminal phase — the caller should fall back to standalone delivery.
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

  const existing = consumeCompletedCard(key);
  if (!existing) {
    log.info('handleSubagentCompletion: no card entry found', { key });
    return { status: 'fallback' };
  }

  // Terminal phases — late completions go standalone
  if (existing.phase === 'completed' || existing.phase === 'aborted' || existing.phase === 'error') {
    log.info('handleSubagentCompletion: card in terminal phase, falling back', {
      phase: existing.phase,
      messageId: existing.messageId,
    });
    return { status: 'fallback' };
  }

  // Main card is still streaming — buffer the completion for later
  if (existing.phase === 'main_streaming') {
    log.info('handleSubagentCompletion: main card still streaming, buffering completion', {
      key,
      completionId,
    });
    const updated: CardEntry = {
      ...existing,
      bufferedCompletions: [
        ...existing.bufferedCompletions,
        { text, completionId, arrivedAt: Date.now() },
      ],
    };
    registerCompletedCard({
      context: { to: chatId, accountId, threadId },
      messageId: updated.messageId,
      cardKitCardId: updated.cardKitCardId,
      cardKitSequence: updated.cardKitSequence,
      completedText: updated.completedText,
      originalCompletedText: updated.originalCompletedText,
      streamingOpen: updated.streamingOpen,
      startedAt: updated.startedAt,
      footer: updated.footer,
      phase: updated.phase,
      activeSubagentCount: updated.activeSubagentCount,
      bufferedCompletions: updated.bufferedCompletions,
      appliedCompletionIds: updated.appliedCompletionIds,
    });
    return { status: 'merged', messageId: existing.messageId, chatId };
  }

  // phase === 'main_done_waiting_subagents' — perform the actual merge
  return mergeIntoCard({ cfg, chatId, accountId, threadId, existing, text, completionId });
}

/**
 * Flush buffered completions that arrived while the main card was still streaming.
 * Called from reply-dispatcher.ts `onIdle()` after the main reply completes.
 */
export async function flushBufferedCompletions(params: {
  entry: CardEntry;
  cfg: ClawdbotConfig;
  chatId: string;
  accountId?: string;
  threadId?: string;
}): Promise<void> {
  const { entry, cfg, chatId, accountId, threadId } = params;
  if (entry.bufferedCompletions.length === 0) return;

  log.info('flushing buffered completions', {
    count: entry.bufferedCompletions.length,
    messageId: entry.messageId,
  });

  // Apply each buffered completion in order
  let current = entry;
  for (const buffered of entry.bufferedCompletions) {
    const result = await mergeIntoCard({
      cfg,
      chatId,
      accountId,
      threadId,
      existing: current,
      text: buffered.text,
      completionId: buffered.completionId,
      // After a buffer flush we re-register with empty bufferedCompletions —
      // the next iteration picks up the updated entry from the registry.
      skipReRegister: false,
    });
    if (result.status === 'fallback') {
      log.warn('flushed completion fell back to standalone', { completionId: buffered.completionId });
      break;
    }
    // Re-fetch the updated entry for the next iteration
    const key = buildConversationKey({ to: chatId, accountId, threadId });
    const next = consumeCompletedCard(key);
    if (!next) break;
    current = next;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function mergeIntoCard(params: {
  cfg: ClawdbotConfig;
  chatId: string;
  accountId?: string;
  threadId?: string;
  existing: CardEntry;
  text: string;
  completionId?: string;
  skipReRegister?: boolean;
}): Promise<SubagentCompletionResult> {
  const { cfg, chatId, accountId, threadId, existing, text, completionId } = params;

  // Dedup check
  if (completionId && existing.appliedCompletionIds.includes(completionId)) {
    log.info('mergeIntoCard: duplicate completionId, skipping', { completionId });
    // Re-register unchanged so caller can continue
    reRegisterEntry(existing, chatId, accountId, threadId);
    return { status: 'merged', messageId: existing.messageId, chatId };
  }

  // Three-way text merge (preserves the original logic from outbound.ts)
  const origText = existing.originalCompletedText;
  let mergedText: string;
  if (text.startsWith(existing.completedText)) {
    mergedText = text;
  } else if (text.startsWith(origText)) {
    const newContent = text.slice(origText.length).trim();
    mergedText = newContent ? existing.completedText + '\n' + newContent : existing.completedText;
  } else {
    mergedText = existing.completedText + '\n' + text;
  }

  const elapsedMs = Date.now() - existing.startedAt;

  log.info('mergeIntoCard: merging completion', {
    messageId: existing.messageId,
    streamingOpen: existing.streamingOpen,
    elapsedMs,
    completionId,
  });

  try {
    let nextSeq = existing.cardKitSequence;

    if (existing.streamingOpen && existing.cardKitCardId) {
      // 1. Push merged text via streaming API
      nextSeq += 1;
      await streamCardContent({
        cfg,
        cardId: existing.cardKitCardId,
        elementId: STREAMING_ELEMENT_ID,
        content: mergedText,
        sequence: nextSeq,
        accountId,
      });
      log.info('mergeIntoCard: streamed merged content', { seq: nextSeq });

      // 2. Close streaming mode
      nextSeq += 1;
      await setCardStreamingMode({
        cfg,
        cardId: existing.cardKitCardId,
        streamingMode: false,
        sequence: nextSeq,
        accountId,
      });

      // 3. Final card.update with footer
      nextSeq += 1;
      await updateCardKitCard({
        cfg,
        cardId: existing.cardKitCardId,
        card: toCardKit2(buildCardContent('complete', { text: mergedText, elapsedMs, footer: existing.footer })),
        sequence: nextSeq,
        accountId,
      });
      log.info('mergeIntoCard: finalized card', { seq: nextSeq, elapsedMs });
    } else if (existing.cardKitCardId) {
      // Non-streaming merge: direct card.update
      nextSeq += 1;
      await updateCardKitCard({
        cfg,
        cardId: existing.cardKitCardId,
        card: toCardKit2(buildCardContent('complete', { text: mergedText, elapsedMs, footer: existing.footer })),
        sequence: nextSeq,
        accountId,
      });
    } else {
      // Legacy IM patch fallback
      await updateCardFeishu({
        cfg,
        messageId: existing.messageId,
        card: buildMarkdownCard(mergedText),
        accountId,
      });
    }

    // Build updated entry
    const appliedCompletionIds = completionId
      ? [...existing.appliedCompletionIds, completionId]
      : existing.appliedCompletionIds;

    const updatedEntry: CardEntry = {
      ...existing,
      cardKitSequence: nextSeq,
      completedText: mergedText,
      streamingOpen: false,
      appliedCompletionIds,
      bufferedCompletions: [],
    };

    if (!params.skipReRegister) {
      reRegisterEntry(updatedEntry, chatId, accountId, threadId);
    }

    return { status: 'merged', messageId: existing.messageId, chatId };
  } catch (err) {
    log.warn('mergeIntoCard: card merge failed', { error: String(err) });
    return { status: 'fallback' };
  }
}

function reRegisterEntry(
  entry: CardEntry,
  chatId: string,
  accountId: string | undefined,
  threadId: string | undefined,
): void {
  registerCompletedCard({
    context: { to: chatId, accountId, threadId },
    messageId: entry.messageId,
    cardKitCardId: entry.cardKitCardId,
    cardKitSequence: entry.cardKitSequence,
    completedText: entry.completedText,
    originalCompletedText: entry.originalCompletedText,
    streamingOpen: entry.streamingOpen,
    startedAt: entry.startedAt,
    footer: entry.footer,
    phase: entry.phase,
    activeSubagentCount: entry.activeSubagentCount,
    bufferedCompletions: entry.bufferedCompletions,
    appliedCompletionIds: entry.appliedCompletionIds,
  });
}
