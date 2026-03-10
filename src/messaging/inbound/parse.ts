/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Event parsing for inbound Feishu messages.
 *
 * Converts a raw FeishuMessageEvent into a normalised MessageContext.
 * All mention information is captured in `mentions: MentionInfo[]`;
 * downstream logic derives `mentionedBot` and non-bot targets from it.
 *
 * When `expandCtx` is provided, `cfg` and `accountId` are passed into
 * the converter context so that async converters (e.g. merge_forward)
 * can make API calls during parsing.
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import type { FeishuMessageEvent, MessageContext, MentionInfo } from '../types';
import { convertMessageContent, type ConvertContext } from '../converters/content-converter';
import { getUserNameCache } from './user-name-cache';
import { getLarkAccount } from '../../core/accounts';
import { LarkClient } from '../../core/lark-client';
import { larkLogger } from '../../core/lark-logger';
import { fetchCardContent, createFetchSubMessages, createParseResolveNames } from './parse-io';

const log = larkLogger('inbound/parse');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a raw Feishu message event into a normalised MessageContext.
 *
 * @param expandCtx  When provided, cfg/accountId are used to create
 *                   callbacks for async converters (e.g. merge_forward)
 *                   to fetch sub-messages and resolve sender names.
 */
export async function parseMessageEvent(
  event: FeishuMessageEvent,
  botOpenId?: string,
  expandCtx?: {
    /** account 级别的 ClawdbotConfig（channels.feishu 已替换为 per-account 合并后的配置） */
    cfg: ClawdbotConfig;
    accountId?: string;
  },
): Promise<MessageContext> {
  // 1. Build MentionInfo list from event mentions
  const mentionMap = new Map<string, MentionInfo>();
  const mentionList: MentionInfo[] = [];

  for (const m of event.message.mentions ?? []) {
    const openId = m.id?.open_id ?? '';
    if (!openId) continue;

    const info: MentionInfo = {
      key: m.key,
      openId,
      name: m.name,
      isBot: Boolean(botOpenId && openId === botOpenId),
    };
    mentionMap.set(m.key, info);
    mentionList.push(info);
  }

  // Build reverse map for O(1) openId lookup
  const mentionsByOpenId = new Map<string, MentionInfo>();
  for (const info of mentionList) {
    mentionsByOpenId.set(info.openId, info);
  }

  // 2. Convert content via registered converter
  const acctId = expandCtx?.accountId;

  // Create larkClient once when expandCtx is available (used for merge_forward & card fetch)
  const larkClient = expandCtx ? LarkClient.fromCfg(expandCtx.cfg, acctId) : undefined;

  // Build merge_forward callbacks when expandCtx is provided
  let fetchSubMessages: ConvertContext['fetchSubMessages'];
  let batchResolveNames: ConvertContext['batchResolveNames'];
  if (expandCtx) {
    const account = getLarkAccount(expandCtx.cfg, acctId);
    fetchSubMessages = createFetchSubMessages(larkClient!);
    batchResolveNames = createParseResolveNames(account);
  }

  // For interactive messages, fetch full v2 card content via API
  let effectiveContent = event.message.content;
  if (event.message.message_type === 'interactive' && expandCtx) {
    const fullContent = await fetchCardContent(event.message.message_id, larkClient!);
    if (fullContent) {
      effectiveContent = fullContent;
      log.info('replaced interactive content with full v2 card data');
    }
  }

  const convertCtx: ConvertContext = {
    mentions: mentionMap,
    mentionsByOpenId,
    messageId: event.message.message_id,
    botOpenId,
    cfg: expandCtx?.cfg,
    accountId: acctId,
    resolveUserName: acctId ? (openId) => getUserNameCache(acctId).get(openId) : undefined,
    fetchSubMessages,
    batchResolveNames,
    stripBotMentions: true,
  };
  const { content, resources } = await convertMessageContent(effectiveContent, event.message.message_type, convertCtx);

  const createTimeStr = event.message.create_time;
  const createTime = createTimeStr ? parseInt(createTimeStr, 10) : undefined;

  return {
    chatId: event.message.chat_id,
    messageId: event.message.message_id,
    senderId: event.sender.sender_id.open_id || '',
    chatType: event.message.chat_type,
    rootId: event.message.root_id || undefined,
    parentId: event.message.parent_id || undefined,
    threadId: event.message.thread_id || undefined,
    content,
    contentType: event.message.message_type,
    resources,
    mentions: mentionList,
    createTime: Number.isNaN(createTime) ? undefined : createTime,
    rawMessage:
      effectiveContent !== event.message.content ? { ...event.message, content: effectiveContent } : event.message,
    rawSender: event.sender,
  };
}
