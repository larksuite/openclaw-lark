// SPDX-License-Identifier: MIT

/**
 * Standalone text and media delivery functions for the Lark/Feishu channel.
 *
 * These functions operate directly on the Lark SDK without depending on
 * {@link sendMessageFeishu} from `send.ts`. The outbound adapter delegates
 * to these for its `sendText` and `sendMedia` implementations.
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import type { FeishuSendResult } from '../types';
import { createAccountScopedConfig, getLarkAccount } from '../../core/accounts';
import { LarkClient } from '../../core/lark-client';
import { threadScopedKey } from '../../channel/chat-queue';
import { normalizeFeishuTarget, resolveReceiveIdType } from '../../core/targets';
import { parseFeishuCommentTarget } from '../../core/comment-target';
import { optimizeMarkdownStyle } from '../../card/markdown-style';
import { formatLarkError } from '../../core/api-error';
import { larkLogger } from '../../core/lark-logger';
import { getSentinelStore } from '../inbound/sentinel-store';
import { uploadAndSendMediaLark } from './media';
import { type NormalizeContext, type SentinelEntry, normalizeOutboundMentions } from './normalize-mentions';

const log = larkLogger('outbound/deliver');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a Feishu post-format content envelope from processed text.
 */
function buildPostContent(text: string): string {
  return JSON.stringify({
    zh_cn: {
      content: [[{ tag: 'md', text }]],
    },
  });
}

interface PreparedText {
  text: string;
  sentinels: SentinelEntry[];
  resolvedAccountId: string | undefined;
}

/**
 * Pre-processes text before Feishu delivery. Runs the full mention
 * normalizer (tag rewrite + plain `@Name` resolution + `@all` aliases),
 * markdown-table conversion, and Markdown style optimization.
 *
 * Falls back to the raw text on any normalizer failure so a parser bug
 * never blocks send. Sentinels collected during normalization are
 * returned for the caller to record after the send succeeds.
 */
async function prepareTextForLark(
  cfg: ClawdbotConfig,
  text: string,
  to: string,
  accountId?: string,
): Promise<PreparedText> {
  let processed = text;
  let sentinels: SentinelEntry[] = [];
  let resolvedAccountId: string | undefined = accountId;

  if (text?.trim()) {
    try {
      const account = getLarkAccount(cfg, accountId ?? undefined);
      const ctx: NormalizeContext = {
        chatId: to,
        account,
        log: (...args) => log.warn(args.map(String).join(' ')),
      };
      const r = await normalizeOutboundMentions(text, ctx);
      processed = r.normalizedText;
      sentinels = r.sentinels;
      resolvedAccountId = account.accountId;
    } catch (err) {
      log.warn(`normalizeOutboundMentions failed in prepareTextForLark, using raw text: ${String(err)}`);
    }
  }

  // Convert markdown tables to Feishu-compatible format using per-account
  // tableMode setting.
  try {
    const accountScopedCfg = createAccountScopedConfig(cfg, accountId);
    const runtime = LarkClient.runtime;
    if (runtime?.channel?.text?.convertMarkdownTables && runtime.channel.text.resolveMarkdownTableMode) {
      const tableMode = runtime.channel.text.resolveMarkdownTableMode({
        cfg: accountScopedCfg,
        channel: 'feishu',
      });
      processed = runtime.channel.text.convertMarkdownTables(processed, tableMode);
    }
  } catch {
    // Runtime not available -- use the text as-is.
  }

  return {
    text: optimizeMarkdownStyle(processed, 1),
    sentinels,
    resolvedAccountId,
  };
}

function recordSentinelsForChat(
  resolvedAccountId: string | undefined,
  to: string,
  threadId: string | undefined,
  sentinels: SentinelEntry[],
): void {
  if (!resolvedAccountId || sentinels.length === 0) return;
  getSentinelStore(resolvedAccountId).recordSentinels(threadScopedKey(to, threadId), sentinels);
}

/**
 * Unified IM message sender — handles both reply and create paths for any
 * `msg_type`.  Replaces the former `replyPostMessage`, `createPostMessage`,
 * `replyInteractiveMessage` and `createInteractiveMessage` helpers.
 */
async function sendImMessage(params: {
  client: ReturnType<typeof LarkClient.fromCfg>['sdk'];
  to: string;
  content: string;
  msgType: 'post' | 'interactive';
  replyToMessageId?: string;
  replyInThread?: boolean;
}): Promise<FeishuSendResult> {
  const { client, to, content, msgType, replyToMessageId, replyInThread } = params;

  // --- Reply path ---
  if (replyToMessageId) {
    log.info(`replying to message ${replyToMessageId} ` + `(msg_type=${msgType}, thread=${replyInThread ?? false})`);
    const response = await client.im.message.reply({
      path: { message_id: replyToMessageId },
      data: { content, msg_type: msgType, reply_in_thread: replyInThread },
    });

    const result: FeishuSendResult = {
      messageId: response?.data?.message_id ?? '',
      chatId: response?.data?.chat_id ?? '',
    };
    log.debug(`reply sent: messageId=${result.messageId}`);
    return result;
  }

  // --- Create path ---
  const target = normalizeFeishuTarget(to);
  if (!target) {
    throw new Error(
      `Cannot send message: "${to}" is not a valid target. ` + `Expected a chat_id (oc_*), open_id (ou_*), or user_id.`,
    );
  }

  const receiveIdType = resolveReceiveIdType(target);
  log.info(`creating message to ${target} (msg_type=${msgType})`);

  const response = await client.im.message.create({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params: { receive_id_type: receiveIdType as any },
    data: { receive_id: target, msg_type: msgType, content },
  });

  const result: FeishuSendResult = {
    messageId: response?.data?.message_id ?? '',
    chatId: response?.data?.chat_id ?? '',
  };
  log.debug(`message created: messageId=${result.messageId}`);
  return result;
}

/**
 * Detect whether a text string is a complete Feishu card JSON (v1, v2, or template).
 *
 * Returns the parsed card object if the text is valid card JSON, or
 * `undefined` if it is plain text. Detection is conservative — only
 * triggers when the **entire** trimmed text is a JSON object with
 * recognisable card structure markers.
 *
 * - **v2**: top-level `schema` equals `"2.0"`
 * - **v1**: has an `elements` array AND at least `config` or `header`
 * - **template**: `type` equals `"template"` with `data.template_id`
 * - **wrapped**: `msg_type` or `type` equals `"interactive"` with a nested `card` object
 */
function detectCardJson(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed)) {
      return undefined;
    }

    const obj = parsed as Record<string, unknown>;

    // v2 CardKit — must declare schema "2.0"
    if (obj.schema === '2.0') return obj;

    // v1 Message Card — must have elements[] AND (config OR header)
    if (Array.isArray(obj.elements) && (obj.config !== undefined || obj.header !== undefined)) {
      return obj;
    }

    // Template card — type: "template" with data.template_id
    if (
      obj.type === 'template' &&
      typeof obj.data === 'object' &&
      obj.data != null &&
      typeof (obj.data as Record<string, unknown>).template_id === 'string'
    ) {
      return obj;
    }

    // Wrapped card — AI sometimes wraps card JSON with msg_type/type: "interactive"
    if (
      (obj.msg_type === 'interactive' || obj.type === 'interactive') &&
      typeof obj.card === 'object' &&
      obj.card != null
    ) {
      return obj.card as Record<string, unknown>;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// sendTextLark
// ---------------------------------------------------------------------------

/**
 * Parameters for sending a text message via Feishu.
 */
export interface SendTextLarkParams {
  /** Plugin configuration. */
  cfg: ClawdbotConfig;
  /** Target identifier (chat_id, open_id, or user_id). */
  to: string;
  /** Message text content (supports Feishu markdown subset). */
  text: string;
  /** When set, the message is sent as a threaded reply. */
  replyToMessageId?: string;
  /** When true, the reply appears in the thread instead of main chat. */
  replyInThread?: boolean;
  /** Thread root id when the reply lives inside a thread; used for sentinel keying. */
  threadId?: string;
  /** Optional account identifier for multi-account setups. */
  accountId?: string;
}

/**
 * Send a text message to a Feishu chat or user.
 *
 * Standalone implementation that directly operates the Lark SDK.
 * The text is pre-processed (table conversion, style optimization)
 * and sent as a Feishu "post" message with markdown rendering.
 *
 * If the entire text is a valid Feishu card JSON string (v1 or v2),
 * it is automatically detected and routed to {@link sendCardLark}
 * instead of being sent as plain text.
 *
 * @param params - See {@link SendTextLarkParams}.
 * @returns The message ID and chat ID.
 * @throws {Error} When the target is invalid or the API call fails.
 *
 * @example
 * ```ts
 * const result = await sendTextLark({
 *   cfg,
 *   to: "oc_xxx",
 *   text: "Hello from Feishu",
 * });
 * ```
 */
export async function sendTextLark(params: SendTextLarkParams): Promise<FeishuSendResult> {
  const { cfg, to, text, replyToMessageId, replyInThread, accountId, threadId } = params;

  // Detect card JSON in text — route to card sending before text preprocessing.
  const card = detectCardJson(text);
  if (card) {
    const version = card.schema === '2.0' ? 'v2' : 'v1';
    log.info(`detected ${version} card JSON in text (target=${to}), routing to sendCardLark`);
    return sendCardLark({ cfg, to, card, replyToMessageId, replyInThread, accountId });
  }

  log.info(`sendTextLark: target=${to}, textLength=${text.length}`);
  const client = LarkClient.fromCfg(cfg, accountId).sdk;
  const prepared = await prepareTextForLark(cfg, text, to, accountId);
  const content = buildPostContent(prepared.text);

  const result = await sendImMessage({ client, to, content, msgType: 'post', replyToMessageId, replyInThread });
  recordSentinelsForChat(prepared.resolvedAccountId, to, threadId, prepared.sentinels);
  return result;
}

// ---------------------------------------------------------------------------
// sendCardLark
// ---------------------------------------------------------------------------

/**
 * Parameters for sending an interactive card message via Feishu.
 */
export interface SendCardLarkParams {
  /** Plugin configuration. */
  cfg: ClawdbotConfig;
  /** Target identifier (chat_id, open_id, or user_id). */
  to: string;
  /**
   * Complete card JSON object (v1 Message Card or v2 CardKit).
   *
   * - **v1**: top-level `config`, `header`, `elements`.
   * - **v2**: `schema: "2.0"`, `config`, `header`, `body.elements`.
   *
   * The Feishu server determines the version by the presence of
   * `schema: "2.0"`.
   */
  card: Record<string, unknown>;
  /** When set, the card is sent as a threaded reply. */
  replyToMessageId?: string;
  /** When true, the reply appears in the thread instead of main chat. */
  replyInThread?: boolean;
  /** Optional account identifier for multi-account setups. */
  accountId?: string;
}

/**
 * Send an interactive card message to a Feishu chat or user.
 *
 * Supports both v1 (Message Card) and v2 (CardKit) card formats.
 * The card JSON is serialised and sent as `msg_type: "interactive"`.
 *
 * @param params - See {@link SendCardLarkParams}.
 * @returns The message ID and chat ID.
 * @throws {Error} When the target is invalid or the API call fails.
 *
 * @example
 * ```ts
 * // v1 card
 * const result = await sendCardLark({
 *   cfg,
 *   to: "oc_xxx",
 *   card: {
 *     config: { wide_screen_mode: true },
 *     header: { title: { tag: "plain_text", content: "Hello" }, template: "blue" },
 *     elements: [{ tag: "div", text: { tag: "lark_md", content: "world" } }],
 *   },
 * });
 *
 * // v2 card
 * const result2 = await sendCardLark({
 *   cfg,
 *   to: "oc_xxx",
 *   card: {
 *     schema: "2.0",
 *     config: { wide_screen_mode: true },
 *     body: { elements: [{ tag: "markdown", content: "Hello **world**" }] },
 *   },
 * });
 * ```
 */
export async function sendCardLark(params: SendCardLarkParams): Promise<FeishuSendResult> {
  const { cfg, to, card, replyToMessageId, replyInThread, accountId } = params;

  const version = card.schema === '2.0' ? 'v2' : 'v1';
  log.info(`sendCardLark: target=${to}, cardVersion=${version}`);

  const client = LarkClient.fromCfg(cfg, accountId).sdk;
  const content = JSON.stringify(card);

  try {
    return await sendImMessage({ client, to, content, msgType: 'interactive', replyToMessageId, replyInThread });
  } catch (err) {
    const detail = formatLarkError(err);
    log.error(`sendCardLark failed: ${detail}`);

    throw new Error(
      `Card send failed: ${detail}\n\n` +
        `Troubleshooting:\n` +
        `- Do NOT use img/image elements with fabricated img_key values — Feishu rejects invalid keys.\n` +
        `- Do NOT put URLs in img_key — it must be a real image_key from uploadImage.\n` +
        `- Prefer text-only cards (markdown elements) which have 100% success rate.\n` +
        `- If you need images, send them as separate media messages, not inside cards.`,
      { cause: err },
    );
  }
}

// ---------------------------------------------------------------------------
// sendMediaLark
// ---------------------------------------------------------------------------

/**
 * Parameters for sending a single media message via Feishu.
 */
export interface SendMediaLarkParams {
  /** Plugin configuration. */
  cfg: ClawdbotConfig;
  /** Target identifier (chat_id, open_id, or user_id). */
  to: string;
  /** Media URL to upload and send. */
  mediaUrl: string;
  /** When set, the message is sent as a threaded reply. */
  replyToMessageId?: string;
  /** When true, the reply appears in the thread instead of main chat. */
  replyInThread?: boolean;
  /** Optional account identifier for multi-account setups. */
  accountId?: string;
  /** Allowed root directories for local file access (SSRF prevention). */
  mediaLocalRoots?: readonly string[];
}

/**
 * Send a single media message to a Feishu chat or user.
 *
 * Pure atomic operation — uploads the media and sends it. On upload
 * failure, falls back to sending the URL as a clickable text link.
 *
 * This function does **not** handle leading text or multi-media
 * orchestration; those concerns belong to the adapter's `sendMedia`
 * and `sendPayload` methods.
 *
 * @param params - See {@link SendMediaLarkParams}.
 * @returns The message ID and chat ID of the sent message.
 * @throws {Error} When the target is invalid or all send attempts fail.
 *
 * @example
 * ```ts
 * const result = await sendMediaLark({
 *   cfg,
 *   to: "oc_xxx",
 *   mediaUrl: "https://example.com/image.png",
 * });
 * ```
 */
export async function sendMediaLark(params: SendMediaLarkParams): Promise<FeishuSendResult> {
  const { cfg, to, mediaUrl, replyToMessageId, replyInThread, accountId, mediaLocalRoots } = params;

  log.info(`sendMediaLark: target=${to}, mediaUrl=${mediaUrl}`);

  try {
    const result = await uploadAndSendMediaLark({
      cfg,
      to,
      mediaUrl,
      replyToMessageId,
      replyInThread,
      accountId,
      mediaLocalRoots,
    });
    log.info(`media sent: messageId=${result.messageId}`);
    return { messageId: result.messageId, chatId: result.chatId };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error(`sendMediaLark failed for "${mediaUrl}": ${errMsg}`);

    // Fallback: send the URL as a clickable text link.
    log.info(`falling back to text link for "${mediaUrl}"`);
    const fallbackResult = await sendTextLark({
      cfg,
      to,
      text: `\u{1F4CE} ${mediaUrl}`,
      replyToMessageId,
      replyInThread,
      accountId,
    });

    return {
      ...fallbackResult,
      warning:
        `Media upload failed for "${mediaUrl}" (${errMsg}). ` +
        `A text link was sent instead. The user may need to open the link manually.`,
    };
  }
}

// ---------------------------------------------------------------------------
// sendCommentReplyLark
// ---------------------------------------------------------------------------

/**
 * Parameters for sending a reply to a Drive comment thread.
 */
export interface SendCommentReplyLarkParams {
  /** Plugin configuration. */
  cfg: ClawdbotConfig;
  /**
   * Target in comment format: `comment:<fileType>:<fileToken>:<commentId>`.
   * Parsed via `parseFeishuCommentTarget`.
   */
  to: string;
  /** Reply text content. */
  text: string;
  /** Optional account identifier for multi-account setups. */
  accountId?: string;
}

/**
 * Send a text message to a Feishu Drive comment surface.
 *
 * Parses the comment target from `to`, then chooses one of two delivery
 * strategies:
 * - `reply`        → reply in the existing comment thread
 * - `create_whole` → create a new whole-document comment
 *
 * Returns a synthetic FeishuSendResult (no IM messageId).
 *
 * @throws {Error} When the target is not a valid comment target or API fails.
 */
export async function sendCommentReplyLark(params: SendCommentReplyLarkParams): Promise<FeishuSendResult> {
  const { cfg, to, text, accountId } = params;

  const target = parseFeishuCommentTarget(to);
  if (!target) {
    throw new Error(`Not a valid comment target: "${to}"`);
  }

  log.info(
    `sendCommentReplyLark: mode=${target.deliveryMode}, comment=${target.commentId}, textLength=${text.length}`,
  );

  const client = LarkClient.fromCfg(cfg, accountId);
  const elements = [{ type: 'text_run', text_run: { text } }];

  if (target.deliveryMode === 'create_whole') {
    try {
      await (client.sdk as any).drive.v1.fileComment.create({
        path: { file_token: target.fileToken },
        params: {
          file_type: target.fileType,
          user_id_type: 'open_id',
        },
        data: {
          reply_list: {
            replies: [
              {
                content: {
                  elements,
                },
              },
            ],
          },
        },
      });

      log.info(`whole comment created successfully`);
      return {
        messageId: `comment-create:${target.commentId}`,
        chatId: to,
      };
    } catch (err) {
      const detail = formatLarkError(err);
      log.error(`sendCommentReplyLark failed to create whole comment: ${detail}`);
      throw new Error(`Comment create failed: ${detail}`, { cause: err });
    }
  }

  // sdk.request defaults to tenant_access_token (bot identity).
  // Dual payload format: try content.elements first, fallback to reply_elements.
  const url = `/open-apis/drive/v1/files/${target.fileToken}/comments/${target.commentId}/replies`;
  const queryParams = { file_type: target.fileType, user_id_type: 'open_id' };

  try {
    await (client.sdk as any).request({
      method: 'POST',
      url,
      params: queryParams,
      data: { content: { elements } },
    });

    log.info(`comment reply sent successfully`);
    return {
      messageId: `comment-reply:${target.commentId}`,
      chatId: to,
    };
  } catch (firstErr) {
    // Fallback: some API versions use reply_elements format
    try {
      await (client.sdk as any).request({
        method: 'POST',
        url,
        params: queryParams,
        data: { reply_elements: elements },
      });

      log.info(`comment reply sent successfully (reply_elements fallback)`);
      return {
        messageId: `comment-reply:${target.commentId}`,
        chatId: to,
      };
    } catch (secondErr) {
      const detail = formatLarkError(firstErr);
      log.error(`sendCommentReplyLark failed: ${detail}`);
      throw new Error(`Comment reply failed: ${detail}`, { cause: secondErr });
    }
  }
}
