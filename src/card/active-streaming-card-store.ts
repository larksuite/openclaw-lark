/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Process-local registry for active Feishu streaming cards.
 *
 * The shared message tool can deliver a final text reply through the channel
 * action path while an inbound turn already owns a streaming card. This bridge
 * routes same-session, same-target text-only sends back into that card instead
 * of posting a separate message and leaving the card stale.
 */

import type { ChannelThreadingToolContext } from 'openclaw/plugin-sdk/channel-contract';
import type { StreamingCardController } from './streaming-card-controller';

interface ActiveStreamingCard {
  accountId?: string;
  chatId: string;
  controller: StreamingCardController;
}

interface RegisterActiveStreamingCardParams {
  sessionKey?: string | null;
  accountId?: string | null;
  chatId: string;
  controller: StreamingCardController;
}

interface DeliverTextToActiveStreamingCardParams {
  sessionKey?: string | null;
  accountId?: string | null;
  to?: string;
  text: string;
  card?: unknown;
  mediaUrl?: string;
  toolContext?: ChannelThreadingToolContext;
}

const activeCards = new Map<string, ActiveStreamingCard>();

export function registerActiveStreamingCard(params: RegisterActiveStreamingCardParams): () => void {
  const sessionKey = normalizeKey(params.sessionKey);
  if (!sessionKey) return () => {};

  activeCards.set(sessionKey, {
    accountId: params.accountId ?? undefined,
    chatId: params.chatId,
    controller: params.controller,
  });

  return () => unregisterActiveStreamingCard(params.sessionKey, params.controller);
}

export function unregisterActiveStreamingCard(
  sessionKey?: string | null,
  controller?: StreamingCardController,
): void {
  const key = normalizeKey(sessionKey);
  if (!key) return;
  const active = activeCards.get(key);
  if (!active) return;
  if (controller && active.controller !== controller) return;
  activeCards.delete(key);
}

export async function deliverTextToActiveStreamingCard(params: DeliverTextToActiveStreamingCardParams): Promise<{
  ok: true;
  messageId: string;
  chatId: string;
  routedViaStreamingCard: true;
} | null> {
  const key = normalizeKey(params.sessionKey);
  if (!key || !params.text.trim()) return null;
  if (params.card || params.mediaUrl) return null;

  const active = activeCards.get(key);
  if (!active) return null;
  if (params.accountId && active.accountId && params.accountId !== active.accountId) return null;
  if (!isCurrentTurnTarget(params.to, active.chatId, params.toolContext?.currentChannelId)) return null;

  await active.controller.onDeliver({ text: params.text });
  const messageId = active.controller.cardMessageId;
  if (!messageId) return null;

  return {
    ok: true,
    messageId,
    chatId: active.chatId,
    routedViaStreamingCard: true,
  };
}

function isCurrentTurnTarget(to: string | undefined, activeChatId: string, currentChannelId: string | undefined): boolean {
  const normalizedTo = normalizeTarget(to);
  if (!normalizedTo) return true;
  return normalizedTo === normalizeTarget(activeChatId) || normalizedTo === normalizeTarget(currentChannelId);
}

function normalizeKey(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeTarget(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .replace(/^(?:user|chat|group|open_id|open-chat-id):/i, '')
    .toLowerCase();
}
