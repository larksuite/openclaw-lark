/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Message sending for the Lark/Feishu channel plugin.
 */

import type { ClawdbotConfig, RuntimeEnv } from 'openclaw/plugin-sdk';
import type { HistoryEntry } from 'openclaw/plugin-sdk/reply-history';
import type { FeishuSendResult, MentionInfo, MessageContext } from '../types';
import type { FeishuGroupConfig, LarkAccount } from '../../core/types';
import { createAccountScopedConfig, getLarkAccount, getDefaultLarkAccountId } from '../../core/accounts';
import { LarkClient } from '../../core/lark-client';
import { normalizeFeishuTarget, normalizeMessageId, resolveReceiveIdType } from '../../core/targets';
import { runWithMessageUnavailableGuard } from '../../core/message-unavailable';
import { optimizeMarkdownStyle } from '../../card/markdown-style';
import { buildMentionedCardContent, buildMentionedMessage } from '../inbound/mention';
import { resolveFeishuGroupConfig } from '../inbound/policy';
import { dispatchToAgent } from '../inbound/dispatch';
import { larkLogger } from '../../core/lark-logger';

const log = larkLogger('outbound/send');

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
  /**
   * Optional multi-locale texts for i18n post messages.
   * When provided, builds a multi-locale post structure (e.g. { zh_cn: ..., en_us: ... })
   * and the `text` field is ignored. Feishu client auto-selects locale based on user language.
   */
  i18nTexts?: Record<string, string>;
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
// A2A Cross-Bot Helper Functions
// ---------------------------------------------------------------------------

interface BotMentionInfo {
  openId: string;
  name: string;
  key: string;
  isBot: boolean;
  accountId: string;
}

function extractBotMentionsFromText(
  text: string | undefined,
  botOpenIdToAccountId: Record<string, string> | undefined,
): BotMentionInfo[] {
  if (!text || !botOpenIdToAccountId) return [];

  const atPattern = /<at user_id="([^"]+)">([^<]*)<\/at>/g;
  const mentions: BotMentionInfo[] = [];
  let match;

  while ((match = atPattern.exec(text)) !== null) {
    const openId = match[1]!;
    const name = match[2] || openId;
    const accountId = botOpenIdToAccountId[openId];

    if (accountId) {
      mentions.push({
        openId,
        name,
        key: `<at user_id="${openId}">${name}</at>`,
        isBot: true,
        accountId,
      });
    }
  }

  return mentions;
}

async function notifyOtherBotsOfMention(params: {
  mentions: BotMentionInfo[];
  text: string | undefined;
  accountId: string | undefined;
  chatId: string | undefined;
  cfg: ClawdbotConfig;
  createdMessageId: string | undefined;
}): Promise<void> {
  const { mentions, text, accountId, chatId, cfg, createdMessageId } = params;

  log.info(
    `[A2A-CROSS-BOT] notifyOtherBotsOfMention: accountId=${accountId}, chatId=${chatId}, mentionsCount=${mentions?.length}, createdMessageId=${createdMessageId}`,
  );

  if (!mentions || mentions.length === 0) {
    log.info('[A2A-CROSS-BOT] no mentions, returning');
    return;
  }

  const botOpenIdToAccountId = cfg?.channels?.feishu?.botOpenIdToAccountId;
  log.info(`[A2A-CROSS-BOT] botOpenIdToAccountId=${JSON.stringify(botOpenIdToAccountId)}`);

  if (!botOpenIdToAccountId) {
    log.info('[A2A-CROSS-BOT] no botOpenIdToAccountId mapping');
    return;
  }

  const senderAccount = getLarkAccount(cfg, accountId);
  const senderClient = LarkClient.fromCfg(cfg, accountId);
  const senderBotOpenId = senderClient.botOpenId;
  const senderBotName = senderClient.botName;
  log.info(`[A2A-CROSS-BOT] senderBotOpenId=${senderBotOpenId}, senderBotName=${senderBotName}, senderAccount=${senderAccount?.accountId}`);

  const senderAccountFeishuCfg = senderAccount?.config;
  const groupConfig = resolveFeishuGroupConfig({ cfg: senderAccountFeishuCfg!, groupId: chatId! });
  const defaultGroupConfig = senderAccountFeishuCfg?.groups?.['*'];

  for (const mention of mentions) {
    const mentionOpenId = mention.openId;
    const targetAccountId = botOpenIdToAccountId[mentionOpenId];
    log.info(`[A2A-CROSS-BOT] mentionOpenId=${mentionOpenId}, targetAccountId=${targetAccountId}`);

    if (!targetAccountId || targetAccountId === accountId) {
      log.info('[A2A-CROSS-BOT] skip: no mapping or self');
      continue;
    }

    try {
      const targetAccount = getLarkAccount(cfg, targetAccountId);
      const targetClient = LarkClient.fromCfg(cfg, targetAccountId);
      const targetBotName = targetClient.botName;
      log.info(`[A2A-CROSS-BOT] targetAccount: ${targetAccount?.accountId} ${targetBotName}`);

      const targetAccountFeishuCfg = targetAccount?.config;
      const targetAccountScopedCfg: ClawdbotConfig = {
        ...cfg,
        channels: { ...cfg.channels, feishu: targetAccountFeishuCfg! },
      };

      const syntheticMentions: MentionInfo[] = mentions.map((m) => ({
        openId: m.openId,
        name: m.name,
        key: m.key,
        isBot: true,
      }));

      const fakeCtx: MessageContext = {
        messageId: `crossbot-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        chatId: chatId || '',
        content: text || '',
        senderId: senderBotOpenId || 'crossbot-sender',
        senderName: senderBotName || 'Cross-Bot',
        chatType: 'group',
        mentions: syntheticMentions,
        mentionAll: false,
        threadId: createdMessageId || undefined,
        rootId: createdMessageId || undefined,
        parentId: createdMessageId || undefined,
        contentType: 'text',
        resources: [],
        rawMessage: {
          message_id: `crossbot-${Date.now()}`,
          chat_id: chatId || '',
          chat_type: 'group',
          message_type: 'text',
          content: text || '',
        },
        rawSender: {
          sender_id: { open_id: senderBotOpenId },
          sender_type: 'bot',
        },
      };

      const safeRuntime: RuntimeEnv = {
        log: (...args: unknown[]) => log.info(args.join(' ')),
        error: (...args: unknown[]) => log.error(args.join(' ')),
        exit: (code?: number) => process.exit(code ?? 0),
      };

      await dispatchToAgent({
        ctx: fakeCtx,
        account: targetAccount!,
        accountScopedCfg: targetAccountScopedCfg,
        runtime: safeRuntime,
        chatHistories: new Map<string, HistoryEntry[]>(),
        quotedContent: undefined,
        mediaPayload: {},
        permissionError: undefined,
        replyToMessageId: createdMessageId || undefined,
        botOpenId: senderBotOpenId,
        historyLimit: 10,
        skipTyping: false,
        commandAuthorized: true,
        groupConfig,
        defaultGroupConfig,
      });

      log.info(`[A2A-CROSS-BOT] notified ${targetAccountId} (openId=${mentionOpenId})`);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      log.error(`[A2A-CROSS-BOT] failed to notify ${targetAccountId}: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// sendMessageFeishu
// ---------------------------------------------------------------------------

/**
 * Resolve the configured markdown table mode for Feishu and convert tables if
 * the runtime converter is available.
 *
 * @param cfg - Plugin configuration
 * @param text - Raw markdown text
 * @param accountId - Optional account identifier for multi-account setups
 * @returns Converted text, or the original text when runtime helpers are unavailable
 */
function convertMarkdownTablesForFeishu(cfg: ClawdbotConfig, text: string, accountId?: string): string {
  try {
    const accountScopedCfg = createAccountScopedConfig(cfg, accountId);
    const runtime = LarkClient.runtime;
    if (runtime?.channel?.text?.convertMarkdownTables && runtime.channel.text.resolveMarkdownTableMode) {
      const tableMode = runtime.channel.text.resolveMarkdownTableMode({
        cfg: accountScopedCfg,
        channel: 'feishu',
      });
      return runtime.channel.text.convertMarkdownTables(text, tableMode);
    }
  } catch {
    // Runtime not available -- use the text as-is.
  }

  return text;
}

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
  const { cfg, to, text, replyToMessageId, mentions, accountId, replyInThread, i18nTexts } = params;

  const client = LarkClient.fromCfg(cfg, accountId).sdk;

  // Build the post-format content envelope.
  let contentPayload: string;

  if (i18nTexts && Object.keys(i18nTexts).length > 0) {
    // Multi-locale post: build each locale's content independently.
    const postBody: Record<string, { content: Array<Array<{ tag: string; text: string }>> }> = {};
    for (const [locale, localeText] of Object.entries(i18nTexts)) {
      let processed = localeText;

      // Apply mention prefix if targets are provided.
      if (mentions && mentions.length > 0) {
        processed = buildMentionedMessage(mentions, processed);
      }

      // Convert markdown tables to Feishu-compatible format.
      processed = convertMarkdownTablesForFeishu(cfg, processed, accountId);

      // Apply Markdown style optimization.
      processed = optimizeMarkdownStyle(processed, 1);

      postBody[locale] = {
        content: [[{ tag: 'md', text: processed }]],
      };
    }
    contentPayload = JSON.stringify(postBody);
  } else {
    // Single-locale (zh_cn) post: original behavior.
    let messageText = text;

    // Apply mention prefix if targets are provided.
    if (mentions && mentions.length > 0) {
      messageText = buildMentionedMessage(mentions, messageText);
    }

    // Convert markdown tables to Feishu-compatible format.
    messageText = convertMarkdownTablesForFeishu(cfg, messageText, accountId);

    // Apply Markdown style optimization.
    messageText = optimizeMarkdownStyle(messageText, 1);

    contentPayload = JSON.stringify({
      zh_cn: {
        content: [[{ tag: 'md', text: messageText }]],
      },
    });
  }

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

  const result: FeishuSendResult = {
    messageId: response?.data?.message_id ?? '',
    chatId: response?.data?.chat_id ?? '',
  };

  const botOpenIdToAccountId = cfg?.channels?.feishu?.botOpenIdToAccountId;
  log.info(
    `[A2A-CROSS-BOT] sendMessageFeishu: botOpenIdToAccountId exists=${!!botOpenIdToAccountId}, text=${String(text)?.substring?.(0, 50)}`,
  );

  if (botOpenIdToAccountId) {
    const textParsedMentions = extractBotMentionsFromText(text, botOpenIdToAccountId);
    log.info(
      `[A2A-CROSS-BOT] textParsedMentions count=${textParsedMentions.length}, accountIds=${textParsedMentions.map((m) => m.accountId).join(',')}`,
    );

    if (textParsedMentions.length > 0) {
      log.info(
        `[A2A-CROSS-BOT] sendMessageFeishu: found ${textParsedMentions.length} bot mentions, triggering notify for each`,
      );

      const allMentionsMap = new Map<string, BotMentionInfo>();
      if (mentions && mentions.length > 0) {
        for (const m of mentions) {
          const oid = m.openId;
          if (oid) allMentionsMap.set(oid, { openId: m.openId, name: m.name, key: m.key, isBot: true, accountId: '' });
        }
      }
      for (const m of textParsedMentions) {
        const oid = m.openId;
        if (oid) allMentionsMap.set(oid, m);
      }
      const allMentions = Array.from(allMentionsMap.values());

      log.info(
        `[A2A-CROSS-BOT] sendMessageFeishu: explicit mentions=${mentions?.length}, text-parsed=${textParsedMentions.length}, total=${allMentions.length}`,
      );

      setImmediate(() => {
        notifyOtherBotsOfMention({
          mentions: allMentions,
          text,
          accountId,
          chatId: target,
          cfg,
          createdMessageId: result.messageId,
        }).catch((e) => log.error(`[A2A-CROSS-BOT] notify error: ${String(e)}`));
      });
    }
  }

  return result;
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

/**
 * Build an i18n-aware Feishu Interactive Message Card containing a single
 * markdown element with per-locale content.
 *
 * Uses the CardKit v2 `i18n_content` field so the Feishu client
 * auto-selects the locale matching the user's language setting.
 *
 * @param i18nTexts - A map of locale to markdown text (e.g. { zh_cn: '...', en_us: '...' }).
 * @returns A card JSON object ready to be sent via {@link sendCardFeishu}.
 */
export function buildI18nMarkdownCard(i18nTexts: Record<string, string>): Record<string, unknown> {
  const locales = Object.keys(i18nTexts);

  // Determine fallback content (prefer en_us, then first available locale).
  const fallbackLocale = locales.includes('en_us') ? 'en_us' : locales[0]!;
  const fallbackText = optimizeMarkdownStyle(i18nTexts[fallbackLocale]!);

  // Build i18n_content with optimized text for each locale.
  const i18nContent: Record<string, string> = {};
  for (const [locale, text] of Object.entries(i18nTexts)) {
    i18nContent[locale] = optimizeMarkdownStyle(text);
  }

  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: fallbackText,
          i18n_content: i18nContent,
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

  const convertedText = convertMarkdownTablesForFeishu(cfg, text, accountId);
  // Use cardVersion=1 consistent with sendMessageFeishu post path.
  const optimizedText = optimizeMarkdownStyle(convertedText, 1);

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
