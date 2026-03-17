/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Reaction event handler for the Lark/Feishu channel plugin.
 *
 * Handles `im.message.reaction.created_v1` events by building a
 * {@link MessageContext} directly and dispatching to the agent via
 * {@link dispatchToAgent}, bypassing the full 7-stage message pipeline.
 *
 * Controlled by `reactionNotifications` (default: "own"):
 *   - `"off"`  — reaction events are silently ignored.
 *   - `"own"`  — only reactions on the bot's own messages are dispatched.
 *   - `"all"`  — reactions on any message in the chat are dispatched.
 */

import * as crypto from 'node:crypto';
import type { ClawdbotConfig, RuntimeEnv, HistoryEntry } from 'openclaw/plugin-sdk';
import { DEFAULT_GROUP_HISTORY_LIMIT } from 'openclaw/plugin-sdk';
import type { FeishuReactionCreatedEvent } from '../types';
import type { MessageContext } from '../types';
import { getLarkAccount } from '../../core/accounts';
import { getMessageFeishu, type FeishuMessageInfo } from '../shared/message-lookup';
import { isThreadCapableGroup, getChatTypeFeishu } from '../../core/chat-info-cache';
import { resolveUserName } from './user-name-cache';
import { dispatchToAgent } from './dispatch';
import { resolveFeishuGroupConfig } from './policy';
import { larkLogger } from '../../core/lark-logger';

const logger = larkLogger('inbound/reaction-handler');

const REACTION_VERIFY_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------------------
// Pre-resolved reaction context
// ---------------------------------------------------------------------------

export interface ReactionContext {
  /** Real chatId (from message API, or `p2p:${operatorOpenId}` fallback). */
  chatId: string;
  /** Resolved chat type. */
  chatType: 'p2p' | 'group';
  /** Thread ID from the fetched message, if any. */
  threadId?: string;
  /** Whether the chat is thread-capable (topic or thread-mode group). */
  threadCapable?: boolean;
  /** Fetched message info used to build the synthetic event. */
  msg: FeishuMessageInfo;
}

/**
 * Pre-resolve reaction context before enqueuing.
 *
 * Performs account config checks, safety filters, API fetch of the
 * original message, ownership verification, chat type resolution, and
 * thread-capable detection.  Returns `null` when the reaction should
 * be skipped (mode off, safety filter, timeout, ownership mismatch,
 * thread-capable group with threadSession enabled).
 *
 * This function is intentionally separated so that the caller
 * (event-handlers.ts) can resolve the real chatId *before* enqueuing,
 * ensuring the reaction shares the same queue key as normal messages
 * for the same chat.
 */
export async function resolveReactionContext(params: {
  cfg: ClawdbotConfig;
  event: FeishuReactionCreatedEvent;
  botOpenId?: string;
  runtime?: RuntimeEnv;
  accountId?: string;
}): Promise<ReactionContext | null> {
  const { cfg, event, botOpenId, runtime, accountId } = params;
  const log = runtime?.log ?? ((...args: unknown[]) => logger.info(args.map(String).join(' ')));

  const account = getLarkAccount(cfg, accountId);
  const reactionMode = account.config?.reactionNotifications ?? 'own';

  if (reactionMode === 'off') {
    return null;
  }

  const emojiType = event.reaction_type?.emoji_type;
  const messageId = event.message_id;
  const operatorOpenId = event.user_id?.open_id ?? '';

  if (!emojiType || !messageId || !operatorOpenId) {
    return null;
  }

  // ---- Safety filters (aligned with official) ----
  if (event.operator_type === 'app' || operatorOpenId === botOpenId) {
    log(`feishu[${accountId}]: ignoring app/self reaction on ${messageId}`);
    return null;
  }

  if (emojiType === 'Typing') {
    return null;
  }

  // "own" mode requires botOpenId to verify message ownership
  if (reactionMode === 'own' && !botOpenId) {
    log(`feishu[${accountId}]: bot open_id unavailable, skipping reaction on ${messageId}`);
    return null;
  }

  // ---- Fetch original message with timeout (fail-closed) ----
  const msg = await Promise.race([
    getMessageFeishu({ cfg, messageId, accountId }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), REACTION_VERIFY_TIMEOUT_MS)),
  ]).catch(() => null);

  if (!msg) {
    log(`feishu[${accountId}]: reacted message ${messageId} not found or timed out, skipping`);
    return null;
  }

  // mget API returns app_id (cli_xxx) as sender.id for bot messages.
  const isBotMessage = msg.senderType === 'app' && msg.senderId === account.appId;
  const isOtherBotMessage = msg.senderType === 'app' && account.appId && msg.senderId !== account.appId;

  // 'own': only react to this bot's messages; 'all': also skip other bots' messages.
  if ((reactionMode === 'own' && !isBotMessage) || (reactionMode === 'all' && isOtherBotMessage)) {
    log(`feishu[${accountId}]: reaction on ${isOtherBotMessage ? 'other bot' : 'non-bot'} message ${messageId}, skipping`);
    return null;
  }

  // ---- Resolve effective chatId ----
  const rawChatId = event.chat_id?.trim() || msg.chatId?.trim() || '';
  const effectiveChatId = rawChatId || `p2p:${operatorOpenId}`;

  // ---- Resolve chat type ----
  // im.message.reaction.created_v1 does NOT include chat_id or chat_type
  // (confirmed from Feishu docs). The message GET API returns chat_id but
  // NOT chat_type. So we must determine chat_type via im.chat.get.
  //
  // Determine chat type: event payload → fetched message → im.chat.get API.
  // The first two sources are almost always empty for reaction events, so
  // getChatTypeFeishu is the primary path.
  let chatType: 'p2p' | 'group' =
    event.chat_type === 'group'
      ? 'group'
      : event.chat_type === 'p2p' || event.chat_type === 'private'
        ? 'p2p'
        : msg.chatType === 'group' || msg.chatType === 'p2p'
          ? (msg.chatType as 'p2p' | 'group')
          : 'p2p'; // tentative default, overridden below when chatId is available

  // When we have a real chat_id (from event or message API), query the
  // authoritative chat type via im.chat.get. This is the only reliable
  // source for reaction events.
  if (rawChatId && chatType === 'p2p' && !event.chat_type && !msg.chatType) {
    try {
      chatType = await getChatTypeFeishu({ cfg, chatId: rawChatId, accountId });
    } catch {
      // getChatTypeFeishu already logs errors and defaults to "p2p"
    }
  }

  // ---- Thread session: skip for thread-capable groups ----
  // The mget API does not return thread_id, so we cannot route the
  // synthetic event to the correct thread session. Skip reaction handling
  // only for thread-capable groups (topic / thread-mode); p2p and regular
  // groups are unaffected since they have no threads.
  let threadCapable = false;
  const threadSessionEnabled = account.config?.threadSession === true;
  if (rawChatId && chatType === 'group') {
    threadCapable = await isThreadCapableGroup({ cfg, chatId: rawChatId, accountId });
    if (threadSessionEnabled && threadCapable) {
      log(`feishu[${accountId}]: reaction on thread-capable group ${rawChatId}, skipping (threadSession enabled)`);
      return null;
    }
  }

  return {
    chatId: effectiveChatId,
    chatType,
    threadId: msg.threadId,
    threadCapable,
    msg,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function handleFeishuReaction(params: {
  cfg: ClawdbotConfig;
  event: FeishuReactionCreatedEvent;
  botOpenId?: string;
  runtime?: RuntimeEnv;
  chatHistories?: Map<string, HistoryEntry[]>;
  accountId?: string;
  /** Pre-resolved context from resolveReactionContext(). */
  preResolved: ReactionContext;
}): Promise<void> {
  const { cfg, event, runtime, chatHistories, accountId, preResolved } = params;
  const log = runtime?.log ?? ((...args: unknown[]) => logger.info(args.map(String).join(' ')));
  const error = runtime?.error ?? ((...args: unknown[]) => logger.error(args.map(String).join(' ')));

  const emojiType = event.reaction_type?.emoji_type!;
  const messageId = event.message_id;
  const operatorOpenId = event.user_id?.open_id ?? '';

  // ---- Step A: Account resolution + accountScopedCfg ----
  const account = getLarkAccount(cfg, accountId);
  const accountFeishuCfg = account.config;
  const accountScopedCfg: ClawdbotConfig = {
    ...cfg,
    channels: { ...cfg.channels, feishu: accountFeishuCfg },
  };

  // ---- Step B: Build MessageContext directly ----
  const excerpt =
    preResolved.msg.content.length > 200 ? preResolved.msg.content.slice(0, 200) + '…' : preResolved.msg.content;
  const syntheticText = excerpt
    ? `[reacted with ${emojiType} to message ${messageId}: "${excerpt}"]`
    : `[reacted with ${emojiType} to message ${messageId}]`;
  const syntheticMessageId = `${messageId}:reaction:${emojiType}:${crypto.randomUUID()}`;

  let ctx: MessageContext = {
    chatId: preResolved.chatId,
    messageId: syntheticMessageId,
    senderId: operatorOpenId,
    chatType: preResolved.chatType,
    content: syntheticText,
    contentType: 'text',
    resources: [],
    mentions: [],
    threadId: preResolved.threadId,
    rawMessage: {
      message_id: syntheticMessageId,
      chat_id: preResolved.chatId,
      chat_type: preResolved.chatType,
      message_type: 'text',
      content: JSON.stringify({ text: syntheticText }),
      create_time: event.action_time ?? String(Date.now()),
      thread_id: preResolved.threadId,
    },
    rawSender: {
      sender_id: {
        open_id: operatorOpenId,
        user_id: event.user_id?.user_id,
        union_id: event.user_id?.union_id,
      },
      sender_type: 'user',
    },
  };

  // ---- Step C: Sender name resolution ----
  const senderResult = await resolveUserName({ account, openId: operatorOpenId, log });
  if (senderResult.name) {
    ctx = { ...ctx, senderName: senderResult.name };
  }

  log(
    `feishu[${accountId}]: reaction "${emojiType}" by ${operatorOpenId} on ${messageId} (chatId=${preResolved.chatId}, chatType=${preResolved.chatType}${preResolved.threadId ? `, thread=${preResolved.threadId}` : ''}), dispatching to AI`,
  );
  logger.info(`reaction "${emojiType}" by ${operatorOpenId} on ${messageId} (chatType=${preResolved.chatType})`);

  // ---- Step D: Group config resolution ----
  const isGroup = ctx.chatType === 'group';
  const groupConfig = isGroup ? resolveFeishuGroupConfig({ cfg: accountFeishuCfg, groupId: ctx.chatId }) : undefined;
  const defaultGroupConfig = isGroup ? accountFeishuCfg?.groups?.['*'] : undefined;

  const historyLimit = Math.max(
    0,
    accountFeishuCfg?.historyLimit ?? accountScopedCfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
  );

  // ---- Step E: Dispatch directly to agent ----
  try {
    await dispatchToAgent({
      ctx,
      permissionError: undefined,
      mediaPayload: {},
      quotedContent: undefined,
      account,
      accountScopedCfg,
      runtime,
      chatHistories,
      historyLimit,
      replyToMessageId: messageId,
      commandAuthorized: false,
      groupConfig,
      defaultGroupConfig,
      skipTyping: true,
    });
  } catch (err) {
    error(`feishu[${accountId}]: error dispatching reaction event: ${String(err)}`);
  }
}
