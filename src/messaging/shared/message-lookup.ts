/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Message fetching for the Lark/Feishu channel plugin.
 *
 * Shared between inbound (reaction handler, enrich) and outbound modules.
 * Extracted from `outbound/fetch.ts` to eliminate inbound→outbound
 * dependency inversion.
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import { convertMessageContent, buildConvertContextFromItem } from '../converters/content-converter';
import { LarkClient } from '../../core/lark-client';
import { larkLogger } from '../../core/lark-logger';

const log = larkLogger('shared/message-lookup');
import { getUserNameCache, createBatchResolveNames } from '../inbound/user-name-cache';
import { getLarkAccount } from '../../core/accounts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Normalised information about a Feishu message, returned by
 * {@link getMessageFeishu}.
 */
export interface FeishuMessageInfo {
  /** Unique Feishu message ID. */
  messageId: string;
  /** Chat ID where the message lives. */
  chatId: string;
  /** Chat type ("p2p" or "group"), when available in the API response. */
  chatType?: string;
  /** Open ID of the sender (if available). */
  senderId?: string;
  /** Display name of the sender (resolved from user-name cache). */
  senderName?: string;
  /** Feishu sender type: "user" for human users, "app" for bots/apps. */
  senderType?: string;
  /** The parsed text / content of the message. */
  content: string;
  /** Feishu content type indicator (text, post, image, interactive, ...). */
  contentType: string;
  /** Unix-millisecond timestamp of when the message was created. */
  createTime?: number;
  /** Thread ID if the message belongs to a thread (omt_xxx format). */
  threadId?: string;
}

// ---------------------------------------------------------------------------
// getMessageFeishu
// ---------------------------------------------------------------------------

/**
 * Retrieve a single message by its ID from the Feishu IM API.
 *
 * Returns a normalised {@link FeishuMessageInfo} object, or `null` if the
 * message cannot be found or the API returns an error.
 *
 * @param params.cfg       - Plugin configuration with Feishu credentials.
 * @param params.messageId - The message ID to fetch.
 * @param params.accountId - Optional account identifier for multi-account setups.
 */
export async function getMessageFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  accountId?: string;
  /** When true, merge_forward content is recursively expanded via API. */
  expandForward?: boolean;
}): Promise<FeishuMessageInfo | null> {
  const { cfg, messageId, accountId, expandForward } = params;

  const larkClient = LarkClient.fromCfg(cfg, accountId);
  const sdk = larkClient.sdk;

  try {
    const requestOpts = {
      method: 'GET',
      url: `/open-apis/im/v1/messages/mget`,
      params: {
        message_ids: messageId,
        user_id_type: 'open_id',
        card_msg_content_type: 'raw_card_content',
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await (sdk as any).request(requestOpts);

    const items = response?.data?.items;
    if (!items || items.length === 0) {
      log.info(`getMessageFeishu: no items returned for ${messageId}`);
      return null;
    }

    const expandCtx = expandForward
      ? {
          cfg,
          accountId,
          fetchSubMessages: async (msgId: string) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const res = await (larkClient.sdk as any).request({
              method: 'GET',
              url: `/open-apis/im/v1/messages/${msgId}`,
              params: { user_id_type: 'open_id', card_msg_content_type: 'raw_card_content' },
            });
            if (res?.code !== 0) {
              throw new Error(`API error: code=${res?.code} msg=${res?.msg}`);
            }
            return res?.data?.items ?? [];
          },
          batchResolveNames: createBatchResolveNames(getLarkAccount(cfg, accountId), (...args: unknown[]) =>
            log.info(args.map(String).join(' ')),
          ),
        }
      : undefined;
    return await parseMessageItem(items[0], messageId, expandCtx);
  } catch (error) {
    log.error(`get message failed (${messageId}): ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a single message item from the Feishu IM API response into a
 * normalised {@link FeishuMessageInfo}.
 *
 * Content parsing is delegated to the shared converter system so that
 * every message-type mapping is defined in exactly one place.
 */
async function parseMessageItem(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  msg: any,
  fallbackMessageId: string,
  expandCtx?: {
    cfg: ClawdbotConfig;
    accountId?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetchSubMessages?: (messageId: string) => Promise<any[]>;
    batchResolveNames?: (openIds: string[]) => Promise<void>;
  },
): Promise<FeishuMessageInfo> {
  const msgType: string = msg.msg_type ?? 'text';
  const rawContent: string = msg.body?.content ?? '{}';
  const messageId = msg.message_id ?? fallbackMessageId;

  const acctId = expandCtx?.accountId;
  const ctx = {
    ...buildConvertContextFromItem(msg, fallbackMessageId, acctId),
    cfg: expandCtx?.cfg,
    accountId: acctId,
    fetchSubMessages: expandCtx?.fetchSubMessages,
    batchResolveNames: expandCtx?.batchResolveNames,
  };
  const { content } = await convertMessageContent(rawContent, msgType, ctx);

  const senderId: string | undefined = msg.sender?.id ?? undefined;
  const senderType: string | undefined = msg.sender?.sender_type ?? undefined;
  const senderName = senderId && acctId ? getUserNameCache(acctId).get(senderId) : undefined;

  return {
    messageId,
    chatId: msg.chat_id ?? '',
    chatType: msg.chat_type ?? undefined,
    senderId,
    senderName,
    senderType,
    content,
    contentType: msgType,
    createTime: msg.create_time ? parseInt(String(msg.create_time), 10) : undefined,
    threadId: msg.thread_id || undefined,
  };
}
