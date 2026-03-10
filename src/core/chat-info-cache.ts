/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Account-scoped LRU cache for Feishu group/chat metadata.
 *
 * Caches the result of `im.chat.get` (chat_mode, group_message_type, etc.)
 * to avoid repeated OAPI calls for every inbound message.
 *
 * Key fields cached:
 * - `chat_mode`: "group" | "topic" | "p2p"
 * - `group_message_type`: "chat" | "thread" (only for chat_mode=group)
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import { LarkClient } from './lark-client';
import { larkLogger } from './lark-logger';

const log = larkLogger('core/chat-info-cache');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatInfo {
  chatMode: 'group' | 'topic' | 'p2p';
  groupMessageType?: 'chat' | 'thread';
}

// ---------------------------------------------------------------------------
// Cache implementation
// ---------------------------------------------------------------------------

const DEFAULT_MAX_SIZE = 500;
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

interface CacheEntry {
  info: ChatInfo;
  expireAt: number;
}

class ChatInfoCache {
  private map = new Map<string, CacheEntry>();
  private maxSize: number;
  private ttlMs: number;

  constructor(maxSize = DEFAULT_MAX_SIZE, ttlMs = DEFAULT_TTL_MS) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(chatId: string): ChatInfo | undefined {
    const entry = this.map.get(chatId);
    if (!entry) return undefined;
    if (entry.expireAt <= Date.now()) {
      this.map.delete(chatId);
      return undefined;
    }
    // LRU refresh
    this.map.delete(chatId);
    this.map.set(chatId, entry);
    return entry.info;
  }

  set(chatId: string, info: ChatInfo): void {
    this.map.delete(chatId);
    this.map.set(chatId, { info, expireAt: Date.now() + this.ttlMs });
    this.evict();
  }

  clear(): void {
    this.map.clear();
  }

  private evict(): void {
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}

// ---------------------------------------------------------------------------
// Account-scoped singleton registry
// ---------------------------------------------------------------------------

const registry = new Map<string, ChatInfoCache>();

function getChatInfoCache(accountId: string): ChatInfoCache {
  let c = registry.get(accountId);
  if (!c) {
    c = new ChatInfoCache();
    registry.set(accountId, c);
  }
  return c;
}

/** Clear chat-info caches (called from LarkClient.clearCache). */
export function clearChatInfoCache(accountId?: string): void {
  if (accountId !== undefined) {
    registry.get(accountId)?.clear();
    registry.delete(accountId);
  } else {
    for (const c of registry.values()) c.clear();
    registry.clear();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Determine whether a group supports thread sessions.
 *
 * Returns `true` when the group is a topic group (`chat_mode=topic`) or
 * a normal group with thread message mode (`group_message_type=thread`).
 *
 * Results are cached per-account with a 1-hour TTL to minimise OAPI calls.
 */
export async function isThreadCapableGroup(params: {
  cfg: ClawdbotConfig;
  chatId: string;
  accountId?: string;
}): Promise<boolean> {
  const { cfg, chatId, accountId } = params;
  const info = await getChatInfo({ cfg, chatId, accountId });
  if (!info) return false;
  return info.chatMode === 'topic' || info.groupMessageType === 'thread';
}

/**
 * Fetch (or read from cache) the chat metadata for a given chat ID.
 *
 * Returns `undefined` when the API call fails (best-effort).
 */
export async function getChatInfo(params: {
  cfg: ClawdbotConfig;
  chatId: string;
  accountId?: string;
}): Promise<ChatInfo | undefined> {
  const { cfg, chatId, accountId } = params;
  const effectiveAccountId = accountId ?? 'default';
  const cache = getChatInfoCache(effectiveAccountId);

  const cached = cache.get(chatId);
  if (cached) return cached;

  try {
    const sdk = LarkClient.fromCfg(cfg, accountId).sdk;
    const response = await sdk.im.chat.get({
      path: { chat_id: chatId },
    });

    const data = response?.data as Record<string, unknown> | undefined;
    const chatMode = (data?.chat_mode as string) ?? 'group';
    const groupMessageType = data?.group_message_type as string | undefined;

    const info: ChatInfo = {
      chatMode: chatMode as ChatInfo['chatMode'],
      groupMessageType: groupMessageType as ChatInfo['groupMessageType'],
    };

    cache.set(chatId, info);
    log.info(`resolved ${chatId} → chat_mode=${chatMode}, group_message_type=${groupMessageType ?? 'N/A'}`);
    return info;
  } catch (err) {
    log.error(`failed to get chat info for ${chatId}: ${String(err)}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// getChatTypeFeishu
// ---------------------------------------------------------------------------

/**
 * Determine the chat type (p2p or group) for a given chat ID.
 *
 * Delegates to the shared {@link getChatInfo} cache (account-scoped LRU with
 * 1-hour TTL) so that chat metadata is fetched at most once across all
 * call-sites (dispatch, reaction handler, etc.).
 *
 * Falls back to "p2p" if the API call fails.
 */
export async function getChatTypeFeishu(params: {
  cfg: ClawdbotConfig;
  chatId: string;
  accountId?: string;
}): Promise<'p2p' | 'group'> {
  const { cfg, chatId, accountId } = params;
  const info = await getChatInfo({ cfg, chatId, accountId });
  if (!info) return 'p2p';
  return info.chatMode === 'group' || info.chatMode === 'topic' ? 'group' : 'p2p';
}
