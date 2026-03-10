/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Message sending for the Lark/Feishu channel plugin.
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import type { FeishuSendResult } from '../types';
import { LarkClient } from '../../core/lark-client';
import { normalizeFeishuTarget, normalizeMessageId, resolveReceiveIdType } from '../../core/targets';
import { runWithMessageUnavailableGuard } from '../../core/message-unavailable';
import type { MentionInfo } from '../types';
import { optimizeMarkdownStyle } from '../../card/markdown-style';
import { buildMentionedMessage, buildMentionedCardContent } from '../inbound/mention';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Parameters for sending a text / post message.
 */
export interface SendFeishuMessageParams {
  cfg: ClawdbotConfig;
  /** Target identifier (chat_id, open_id, or user_id). */
  to: string;
  /** Message text content (supports Feishu markdown subset). */
  text: string;
  /** When set, the message is sent as a threaded reply. */
  replyToMessageId?: string;
  /** Optional mention targets to prepend to the message. */
  mentions?: MentionInfo[];
  /** Optional account identifier for multi-account setups. */
  accountId?: string;
  /** When true, the reply appears in the thread instead of main chat. */
  replyInThread?: boolean;
}

/**
 * Parameters for sending an interactive card message.
 */
export interface SendFeishuCardParams {
  cfg: ClawdbotConfig;
  /** Target identifier (chat_id, open_id, or user_id). */
  to: string;
  /** The full interactive card JSON payload. */
  card: Record<string, unknown>;
  /** When set, the card is sent as a threaded reply. */
  replyToMessageId?: string;
  /** Optional account identifier for multi-account setups. */
  accountId?: string;
  /** When true, the reply appears in the thread instead of main chat. */
  replyInThread?: boolean;
}

// ---------------------------------------------------------------------------
// sendMessageFeishu
// ---------------------------------------------------------------------------

/**
 * Send a text message (rendered as a Feishu "post" with markdown support)
 * to a chat or user.
 *
 * The message text is wrapped in Feishu's post format using the `md` tag
 * for rich rendering. If `replyToMessageId` is provided, the message is
 * sent as a threaded reply; otherwise it is sent as a new message using
 * the appropriate `receive_id_type`.
 *
 * Markdown tables in the text are automatically converted to the format
 * supported by Feishu via the runtime's table converter when available.
 *
 * @param params - See {@link SendFeishuMessageParams}.
 * @returns The send result containing the new message ID.
 */
export async function sendMessageFeishu(params: SendFeishuMessageParams): Promise<FeishuSendResult> {
  const { cfg, to, text, replyToMessageId, mentions, accountId, replyInThread } = params;

  const client = LarkClient.fromCfg(cfg, accountId).sdk;

  // Apply mention prefix if targets are provided.
  let messageText = text;
  if (mentions && mentions.length > 0) {
    messageText = buildMentionedMessage(mentions, messageText);
  }

  // Convert markdown tables to Feishu-compatible format if the runtime
  // provides a converter.
  try {
    const runtime = LarkClient.runtime;
    if (runtime?.channel?.text?.convertMarkdownTables) {
      messageText = runtime.channel.text.convertMarkdownTables(messageText, 'bullets');
    }
  } catch {
    // Runtime not available -- use the text as-is.
  }

  // Apply Markdown style optimization.
  messageText = optimizeMarkdownStyle(messageText, 1);

  // Build the post-format content envelope.
  const contentPayload = JSON.stringify({
    zh_cn: {
      content: [[{ tag: 'md', text: messageText }]],
    },
  });

  if (replyToMessageId) {
    // Send as a threaded reply.
    // 规范化 message_id，处理合成 ID（如 "om_xxx:auth-complete"）
    const normalizedId = normalizeMessageId(replyToMessageId);
    const response = await runWithMessageUnavailableGuard({
      messageId: normalizedId,
      operation: 'im.message.reply(post)',
      fn: () =>
        client.im.message.reply({
          path: {
            message_id: normalizedId!,
          },
          data: {
            content: contentPayload,
            msg_type: 'post',
            reply_in_thread: replyInThread,
          },
        }),
    });

    return {
      messageId: response?.data?.message_id ?? '',
      chatId: response?.data?.chat_id ?? '',
    };
  }

  // Send as a new message.
  const target = normalizeFeishuTarget(to);
  if (!target) {
    throw new Error(`[feishu-send] Invalid target: "${to}"`);
  }

  const receiveIdType = resolveReceiveIdType(target);

  const response = await client.im.message.create({
    params: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      receive_id_type: receiveIdType as any,
    },
    data: {
      receive_id: target,
      msg_type: 'post',
      content: contentPayload,
    },
  });

  return {
    messageId: response?.data?.message_id ?? '',
    chatId: response?.data?.chat_id ?? '',
  };
}

// ---------------------------------------------------------------------------
// sendCardFeishu
// ---------------------------------------------------------------------------

/**
 * Send an interactive card message to a chat or user.
 *
 * @param params - See {@link SendFeishuCardParams}.
 * @returns The send result containing the new message ID.
 */
export async function sendCardFeishu(params: SendFeishuCardParams): Promise<FeishuSendResult> {
  const { cfg, to, card, replyToMessageId, accountId, replyInThread } = params;

  const client = LarkClient.fromCfg(cfg, accountId).sdk;

  const contentPayload = JSON.stringify(card);

  if (replyToMessageId) {
    // 规范化 message_id，处理合成 ID（如 "om_xxx:auth-complete"）
    const normalizedId = normalizeMessageId(replyToMessageId);
    const response = await runWithMessageUnavailableGuard({
      messageId: normalizedId,
      operation: 'im.message.reply(interactive)',
      fn: () =>
        client.im.message.reply({
          path: {
            message_id: normalizedId!,
          },
          data: {
            content: contentPayload,
            msg_type: 'interactive',
            reply_in_thread: replyInThread,
          },
        }),
    });

    return {
      messageId: response?.data?.message_id ?? '',
      chatId: response?.data?.chat_id ?? '',
    };
  }

  const target = normalizeFeishuTarget(to);
  if (!target) {
    throw new Error(`[feishu-send] Invalid target: "${to}"`);
  }

  const receiveIdType = resolveReceiveIdType(target);

  const response = await client.im.message.create({
    params: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      receive_id_type: receiveIdType as any,
    },
    data: {
      receive_id: target,
      msg_type: 'interactive',
      content: contentPayload,
    },
  });

  return {
    messageId: response?.data?.message_id ?? '',
    chatId: response?.data?.chat_id ?? '',
  };
}

// ---------------------------------------------------------------------------
// updateCardFeishu
// ---------------------------------------------------------------------------

/**
 * Update (PATCH) the content of an existing interactive card message.
 *
 * Only messages originally sent by the bot can be updated. The card
 * must have been created with `"update_multi": true` in its config if
 * all recipients should see the update.
 *
 * @param params.cfg       - Plugin configuration.
 * @param params.messageId - The card message ID to update.
 * @param params.card      - The new card content.
 * @param params.accountId - Optional account identifier.
 */
export async function updateCardFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  card: Record<string, unknown>;
  accountId?: string;
}): Promise<void> {
  const { cfg, messageId, card, accountId } = params;

  const client = LarkClient.fromCfg(cfg, accountId).sdk;

  await runWithMessageUnavailableGuard({
    messageId,
    operation: 'im.message.patch(interactive)',
    fn: () =>
      client.im.message.patch({
        path: {
          message_id: messageId,
        },
        data: {
          content: JSON.stringify(card),
        },
      }),
  });
}

// ---------------------------------------------------------------------------
// buildMarkdownCard
// ---------------------------------------------------------------------------

/**
 * Build a simple Feishu Interactive Message Card containing a single
 * markdown element.
 *
 * This is a convenience wrapper for the most common card layout: a
 * wide-screen card with one markdown block.
 *
 * @param text - The markdown text to render in the card.
 * @returns A card JSON object ready to be sent via {@link sendCardFeishu}.
 */
export function buildMarkdownCard(text: string): Record<string, unknown> {
  const optimizedText = optimizeMarkdownStyle(text);

  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: optimizedText,
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// sendMarkdownCardFeishu
// ---------------------------------------------------------------------------

/**
 * Build a markdown card and send it in one step.
 *
 * If mention targets are provided, they are prepended to the markdown
 * content using the card mention syntax.
 *
 * @param params.cfg              - Plugin configuration.
 * @param params.to               - Target identifier.
 * @param params.text             - Markdown content for the card.
 * @param params.replyToMessageId - Optional message ID for threaded reply.
 * @param params.mentions         - Optional mention targets.
 * @param params.accountId        - Optional account identifier.
 * @returns The send result containing the new message ID.
 */
export async function sendMarkdownCardFeishu(params: {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  replyToMessageId?: string;
  mentions?: MentionInfo[];
  accountId?: string;
  replyInThread?: boolean;
}): Promise<FeishuSendResult> {
  const { cfg, to, text, replyToMessageId, mentions, accountId, replyInThread } = params;

  let cardText = text;
  if (mentions && mentions.length > 0) {
    cardText = buildMentionedCardContent(mentions, cardText);
  }

  const card = buildMarkdownCard(cardText);

  return sendCardFeishu({
    cfg,
    to,
    card,
    replyToMessageId,
    replyInThread,
    accountId,
  });
}

// ---------------------------------------------------------------------------
// editMessageFeishu
// ---------------------------------------------------------------------------

/**
 * Edit the content of an existing message.
 *
 * Updates the message body via the IM message update API. Only
 * messages sent by the bot can be edited.
 *
 * @param params.cfg       - Plugin configuration.
 * @param params.messageId - The message ID to edit.
 * @param params.text      - The new message text.
 * @param params.accountId - Optional account identifier.
 */
export async function editMessageFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  text: string;
  accountId?: string;
}): Promise<void> {
  const { cfg, messageId, text, accountId } = params;

  const client = LarkClient.fromCfg(cfg, accountId).sdk;

  const optimizedText = optimizeMarkdownStyle(text);

  const contentPayload = JSON.stringify({
    zh_cn: {
      content: [[{ tag: 'md', text: optimizedText }]],
    },
  });

  await runWithMessageUnavailableGuard({
    messageId,
    operation: 'im.message.update(post)',
    fn: () =>
      client.im.message.update({
        path: {
          message_id: messageId,
        },
        data: {
          content: contentPayload,
          msg_type: 'post',
        },
      }),
  });
}
