/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Content converter for Feishu messages.
 *
 * Each message type (text, post, image, etc.) has a dedicated converter
 * function that parses raw JSON content into an AI-friendly text
 * representation plus a list of resource descriptors.
 *
 * This module is a general-purpose message parsing utility — usable
 * from inbound handling, outbound formatting, and skills.
 */

import type { MentionInfo } from '../types';
import { converters } from './index';
import { escapeRegExp } from './utils';
import type { ApiMessageItem, ConvertContext, ConvertResult } from './types';
import { getUserNameCache } from '../inbound/user-name-cache';

// Re-export types for convenience
export type { ApiMessageItem, ConvertContext, ConvertResult, ContentConverterFn } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 从 mention 的 id 字段提取 open_id（兼容事件推送的对象格式和 API 响应的字符串格式） */
export function extractMentionOpenId(id: unknown): string {
  if (typeof id === 'string') return id;
  if (id != null && typeof id === 'object' && 'open_id' in id) {
    const openId = (id as Record<string, unknown>).open_id;
    return typeof openId === 'string' ? openId : '';
  }
  return '';
}

// ---------------------------------------------------------------------------
// Convert
// ---------------------------------------------------------------------------

/**
 * Convert raw message content using the converter for the given message
 * type. Falls back to the "unknown" converter for unrecognised types.
 *
 * Returns a Promise because some converters (e.g. merge_forward) perform
 * async operations. Synchronous converters are awaited transparently.
 */
export async function convertMessageContent(
  raw: string,
  messageType: string,
  ctx: ConvertContext,
): Promise<ConvertResult> {
  const fn = converters.get(messageType) ?? converters.get('unknown');
  if (!fn) {
    return { content: raw, resources: [] };
  }
  return fn(raw, ctx);
}

// ---------------------------------------------------------------------------
// ConvertContext from API item
// ---------------------------------------------------------------------------

/**
 * Build a {@link ConvertContext} from a raw Feishu API message item.
 *
 * Extracts the `mentions` array that the IM API returns on each message
 * item and maps it into the key→MentionInfo / openId→MentionInfo
 * structures the converter system expects.
 */
export function buildConvertContextFromItem(
  item: ApiMessageItem,
  fallbackMessageId: string,
  accountId?: string,
): ConvertContext {
  const mentions = new Map<string, MentionInfo>();
  const mentionsByOpenId = new Map<string, MentionInfo>();

  for (const m of item.mentions ?? []) {
    const openId: string = extractMentionOpenId(m.id);
    if (!openId) continue;

    const info: MentionInfo = {
      key: m.key,
      openId,
      name: m.name ?? '',
      isBot: false,
    };
    mentions.set(m.key, info);
    mentionsByOpenId.set(openId, info);
  }

  return {
    mentions,
    mentionsByOpenId,
    messageId: item.message_id ?? fallbackMessageId,
    accountId,
    resolveUserName: accountId ? (openId) => getUserNameCache(accountId).get(openId) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Mention resolution helper
// ---------------------------------------------------------------------------

/**
 * Resolve mention placeholders in text.
 *
 * - Bot mentions: remove the placeholder key and any preceding `@botName`
 *   entirely (with trailing whitespace).
 * - Non-bot mentions: replace the placeholder key with readable `@name`.
 */
export function resolveMentions(text: string, ctx: ConvertContext): string {
  if (ctx.mentions.size === 0) return text;

  let result = text;
  for (const [key, info] of ctx.mentions) {
    if (info.isBot && ctx.stripBotMentions) {
      // 仅在事件推送场景才删除 bot mention
      result = result.replace(new RegExp(`@${escapeRegExp(info.name)}\\s*`, 'g'), '').trim();
      result = result.replace(new RegExp(escapeRegExp(key) + '\\s*', 'g'), '').trim();
    } else {
      result = result.replace(new RegExp(escapeRegExp(key), 'g'), `@${info.name}`);
    }
  }
  return result;
}
