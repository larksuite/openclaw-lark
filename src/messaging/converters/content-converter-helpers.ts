/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Shared helper functions for Feishu content converters.
 */

import type { MentionInfo } from '../types';
import { getUserNameCache } from '../inbound/user-name-cache';
import { escapeRegExp } from './utils';
import type { ApiMessageItem, ConvertContext } from './types';

/** 从 mention 的 id 字段提取 open_id（兼容事件推送的对象格式和 API 响应的字符串格式） */
export function extractMentionOpenId(id: unknown): string {
  if (typeof id === 'string') return id;
  if (id != null && typeof id === 'object' && 'open_id' in id) {
    const openId = (id as Record<string, unknown>).open_id;
    return typeof openId === 'string' ? openId : '';
  }
  return '';
}

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

/**
 * Resolve mention placeholders in text.
 *
 * - Bot self-mention + stripBotMentions: leading-only strip. When the
 *   self-mention sits at the very start of the message, drop it (the
 *   `WasMentioned` envelope field already tells the agent "this message
 *   was addressed to you", so the anchor is redundant). When it appears
 *   mid-text, render it as plain `@Name` so the surrounding context still
 *   reads naturally without leaving an inline anchor the LLM might echo
 *   back into its reply.
 * - Non-bot mentions: replace the placeholder key with readable `@name`.
 */
export function resolveMentions(text: string, ctx: ConvertContext): string {
  if (ctx.mentions.size === 0) return text;

  let result = text;
  for (const [key, info] of ctx.mentions) {
    if (info.isBot && ctx.stripBotMentions) {
      result = result.replace(new RegExp(escapeRegExp(key), 'g'), `@${info.name}`);
      const leadingPattern = new RegExp(
        `^\\s*@${escapeRegExp(info.name)}[\\s,，:：]*`,
      );
      result = result.replace(leadingPattern, '').trimStart();
    } else {
      result = result.replace(new RegExp(escapeRegExp(key), 'g'), `@${info.name}`);
    }
  }
  return result;
}
