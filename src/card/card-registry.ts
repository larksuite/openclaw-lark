/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Tracks the last completed streaming card per chat so that subsequent
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
}

const entries = new Map<string, CardEntry>();

function buildKey(chatId: string, accountId?: string): string {
  return accountId ? `${accountId}:${chatId}` : chatId;
}

/**
 * Register a completed streaming card so outbound deliveries can update it.
 */
export function registerCompletedCard(params: {
  chatId: string;
  accountId?: string;
  messageId: string;
  cardKitCardId: string | null;
  cardKitSequence: number;
  completedText: string;
  originalCompletedText?: string;
  streamingOpen?: boolean;
  startedAt?: number;
  footer?: { status?: boolean; elapsed?: boolean };
}): void {
  const key = buildKey(params.chatId, params.accountId);
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
  });
  log.info('registered completed card', { key, messageId: params.messageId });
}

/**
 * Consume (take and remove) the last completed card for a chat.
 * Returns `undefined` if no card is registered or the entry has expired.
 */
export function consumeCompletedCard(chatId: string, accountId?: string): CardEntry | undefined {
  // Try exact key first, then fallback to alternative key format.
  // Registration uses accountId from reply-dispatcher (e.g. "default"),
  // but outbound sendText may receive undefined accountId from the SDK.
  const key = buildKey(chatId, accountId);
  const fallbackKey = accountId ? chatId : undefined;

  let matchedKey = key;
  let entry = entries.get(key);

  if (!entry && fallbackKey) {
    entry = entries.get(fallbackKey);
    if (entry) matchedKey = fallbackKey;
  }

  // If still not found, scan for any entry ending with `:${chatId}`
  if (!entry) {
    for (const [k, v] of entries) {
      if (k === chatId || k.endsWith(`:${chatId}`)) {
        entry = v;
        matchedKey = k;
        break;
      }
    }
  }

  if (!entry) return undefined;

  entries.delete(matchedKey);

  if (Date.now() - entry.registeredAt > TTL_MS) {
    log.info('card entry expired, discarding', { key: matchedKey });
    return undefined;
  }

  log.info('consumed completed card', { key: matchedKey, messageId: entry.messageId });
  return entry;
}

/**
 * Remove a completed card entry without returning it.
 * Used to clean up stale entries when all subagents have ended.
 */
export function removeCompletedCard(chatId: string, accountId?: string): void {
  const key = buildKey(chatId, accountId);
  if (entries.delete(key)) {
    log.info('removed stale card entry', { key });
  }
}
