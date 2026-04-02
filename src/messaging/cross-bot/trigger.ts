/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Cross-bot @mention support for Lark/Feishu channel plugin.
 *
 * Enables A bot to @mention B bot and trigger B bot's message handler.
 * Works around Feishu's limitation where bots cannot see other bot messages.
 */

import { LarkClient } from '../../core/lark-client';
import type { FeishuMessageEvent } from '../types';
import { larkLogger } from '../../core/lark-logger';

const log = larkLogger('cross-bot/trigger');

/** Prefix for synthetic message IDs to avoid collision with real messages. */
const SYNTHETIC_MESSAGE_ID_PREFIX = 'synthetic_om_';

/**
 * Check if an open_id belongs to a registered bot.
 */
export function isBotOpenId(openId: string): boolean {
  const accountId = LarkClient.getAccountIdByBotOpenId(openId);
  return accountId !== undefined;
}

/**
 * Parameters for triggering a cross-bot message.
 */
export interface TriggerBotToBotMessageParams {
  /** Sender (A bot) account ID. */
  senderAccountId: string;
  /** Sender bot's open_id. */
  senderBotOpenId: string;
  /** Target bot open IDs that were mentioned. */
  mentionedBotOpenIds: string[];
  /** Group chat ID. */
  chatId: string;
  /** Real Feishu message ID of the sender bot's message (used as reply target). */
  replyToMessageId?: string;
  /** Original message content (without @mentions). */
  content: string;
  /** Original message type. */
  messageType: string;
  /** Thread ID (optional). */
  threadId?: string;
  /** Root ID for topic groups (optional). */
  rootId?: string;
}

/**
 * Trigger cross-bot @message events.
 *
 * When A bot sends a message mentioning B bot, this function
 * triggers B bot's im.message.receive_v1 handler directly.
 */
export async function triggerBotToBotMessage(
  params: TriggerBotToBotMessageParams
): Promise<void> {
  const {
    senderAccountId,
    senderBotOpenId,
    mentionedBotOpenIds,
    chatId,
    replyToMessageId,
    content,
    messageType,
    threadId,
    rootId,
  } = params;

  log.info(
    `[跨Bot] 开始触发: senderAccountId=${senderAccountId}, senderBotOpenId=${senderBotOpenId}, mentionedBotOpenIds=${mentionedBotOpenIds.join(',')}, chatId=${chatId}`
  );

  for (const targetBotOpenId of mentionedBotOpenIds) {
    // Skip self-mentions
    if (targetBotOpenId === senderBotOpenId) {
      log.info(`[跨Bot] 跳过自提及: targetBotOpenId=${targetBotOpenId}`);
      continue;
    }

    const targetAccountId = LarkClient.getAccountIdByBotOpenId(targetBotOpenId);
    if (!targetAccountId) {
      log.warn(`bot ${targetBotOpenId} not found in registry`);
      continue;
    }

    // Get target bot's handlers
    const handlers = LarkClient.getBotHandlers(targetAccountId);
    if (!handlers || !handlers['im.message.receive_v1']) {
      log.warn(`no message handler found for account ${targetAccountId}`);
      continue;
    }

    log.info(
      `[跨Bot] 准备发给: targetAccountId=${targetAccountId}, targetBotOpenId=${targetBotOpenId}`
    );

    // Create synthetic message event
    const syntheticEvent = createSyntheticMessageEvent({
      senderBotOpenId,
      targetBotOpenId,
      chatId,
      replyToMessageId,
      content,
      messageType,
      threadId,
      rootId,
    });

    log.info(
      `triggering cross-bot message: ${senderBotOpenId} -> ${targetBotOpenId} in chat ${chatId}`
    );

    // Call target bot's handler directly
    try {
      await handlers['im.message.receive_v1'](syntheticEvent);
      log.info(`[跨Bot] 成功触发: ${senderBotOpenId} -> ${targetBotOpenId}`);
    } catch (err) {
      log.error(`cross-bot handler error: ${String(err)}`);
    }
  }
}

/**
 * Parameters for creating a synthetic message event.
 */
interface CreateSyntheticMessageEventParams {
  senderBotOpenId: string;
  targetBotOpenId: string;
  chatId: string;
  /** Real Feishu message ID to use (so target bot can reply to it). */
  replyToMessageId?: string;
  content: string;
  messageType: string;
  threadId?: string;
  rootId?: string;
}

/**
 * Create a synthetic FeishuMessageEvent that mimics a real WebSocket event.
 *
 * This allows handleMessageEvent to process message normally.
 */
function createSyntheticMessageEvent(
  params: CreateSyntheticMessageEventParams
): FeishuMessageEvent {
  const { senderBotOpenId, targetBotOpenId, chatId, replyToMessageId, content, messageType, threadId, rootId } =
    params;

  // Use real message ID if available (so target bot can reply to a real Feishu message),
  // otherwise fall back to a synthetic ID.
  const messageId = replyToMessageId
    ?? `${SYNTHETIC_MESSAGE_ID_PREFIX}${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 9)}`;

  return {
    sender: {
      sender_id: {
        open_id: senderBotOpenId,
      },
      sender_type: 'app', // Sender is an app (bot)
    },
    message: {
      message_id: messageId,
      chat_id: chatId,
      thread_id: threadId,
      root_id: rootId,
      chat_type: 'group',
      message_type: messageType,
      content,
      create_time: Date.now().toString(),
      update_time: Date.now().toString(),
      mentions: [
        {
          key: `@_user_${targetBotOpenId}`,
          id: { open_id: targetBotOpenId },
          name: 'Bot',
        },
      ],
    },
  };
}
