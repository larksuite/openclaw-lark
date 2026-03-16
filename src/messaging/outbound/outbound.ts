// SPDX-License-Identifier: MIT

/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Outbound message adapter for the Lark/Feishu channel plugin.
 *
 * Exposes a `ChannelOutboundAdapter` that the OpenClaw core uses to deliver
 * agent-generated replies back to Feishu chats. The adapter translates SDK
 * parameters and delegates to standalone sending functions.
 */

import type { ChannelOutboundAdapter, ClawdbotConfig } from 'openclaw/plugin-sdk';
import type { FeishuSendResult } from '../types';
import { LarkClient } from '../../core/lark-client';
import { sendTextLark, sendMediaLark, sendCardLark } from './deliver';
import { updateCardFeishu, buildMarkdownCard } from './send';
import { getLarkAccount } from '../../core/accounts';
import { consumeCompletedCard, registerCompletedCard } from '../../card/card-registry';
import { buildCardContent, toCardKit2 } from '../../card/builder';
import { updateCardKitCard, setCardStreamingMode, streamCardContent } from '../../card/cardkit';
import { STREAMING_ELEMENT_ID } from '../../card/builder';
import { normalizeFeishuTarget } from '../../core/targets';
import { hasActiveSubagents } from '../../card/subagent-tracker';
import { larkLogger } from '../../core/lark-logger';
import { parseFeishuRouteTarget } from '../../core/targets';

const log = larkLogger('outbound/outbound');

// ---------------------------------------------------------------------------
// channelData.feishu contract
// ---------------------------------------------------------------------------

/**
 * Channel-specific payload for Feishu, carried in `ReplyPayload.channelData.feishu`.
 *
 * Callers (skills, tools, programmatic code) populate this structure to send
 * Feishu-native content that the standard text/media path cannot express.
 *
 * Both card v1 (Message Card) and v2 (CardKit) formats are supported.
 * The Feishu server distinguishes the version by the presence of `schema: "2.0"`.
 *
 * @example
 * ```ts
 * // --- v1 Message Card (default) ---
 * const v1Reply: ReplyPayload = {
 *   channelData: {
 *     feishu: {
 *       card: {
 *         config: { wide_screen_mode: true },
 *         header: {
 *           title: { tag: "plain_text", content: "Task Created" },
 *           template: "green",
 *         },
 *         elements: [
 *           { tag: "div", text: { tag: "lark_md", content: "**Title:** Fix login bug" } },
 *           { tag: "action", actions: [
 *             { tag: "button", text: { tag: "plain_text", content: "View" }, type: "primary", url: "https://..." },
 *           ]},
 *         ],
 *       },
 *     },
 *   },
 * };
 *
 * // --- v2 CardKit ---
 * const v2Reply: ReplyPayload = {
 *   channelData: {
 *     feishu: {
 *       card: {
 *         schema: "2.0",
 *         config: { wide_screen_mode: true },
 *         header: {
 *           title: { tag: "plain_text", content: "Task Created" },
 *           template: "green",
 *         },
 *         body: {
 *           elements: [
 *             { tag: "markdown", content: "**Title:** Fix login bug" },
 *           ],
 *         },
 *       },
 *     },
 *   },
 * };
 * ```
 */
export interface FeishuChannelData {
  /**
   * A complete Feishu interactive card JSON object (v1 or v2).
   *
   * The card is sent as-is via `msg_type: "interactive"`. The Feishu server
   * uses the presence of `schema: "2.0"` to determine the card version.
   *
   * **v1 (Message Card)** — default when no `schema` field is present.
   * Top-level fields: `config`, `header`, `elements`.
   * Element tags: `div`, `action`, `button`, `button_group`, `note`,
   * `img`, `hr`, `column_set`, `markdown` (limited), `lark_md` (in div.text).
   *
   * **v2 (CardKit)** — activated by `schema: "2.0"`.
   * Top-level fields: `schema`, `config`, `header`, `body.elements`.
   * Element tags: `markdown`, `plain_text`, `hr`, `collapsible_panel`,
   * `column_set`, `table`, `image`, `button`, `select_static`, `overflow`.
   * Not supported in v2: `action`, `button_group`, `note`, `div` + `lark_md`.
   *
   * @see https://open.larkoffice.com/document/feishu-cards/card-json-v2-structure (v2)
   * @see https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-components (v1)
   */
  card?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Shared context resolution
// ---------------------------------------------------------------------------

/**
 * Common send context extracted from outbound adapter parameters.
 */
interface FeishuSendContext {
  cfg: ClawdbotConfig;
  to: string;
  replyToMessageId?: string;
  replyInThread: boolean;
  accountId?: string;
}

/**
 * Map adapter-level parameters to internal send context.
 *
 * Mirrors the pattern used by Telegram (`resolveTelegramSendContext`) and
 * Slack (`sendSlackOutboundMessage`) to centralise parameter mapping.
 */
function resolveFeishuSendContext(params: {
  cfg: ClawdbotConfig;
  to: string;
  accountId?: string | null;
  replyToId?: string | null;
  threadId?: string | number | null;
}): FeishuSendContext {
  const routeTarget = parseFeishuRouteTarget(params.to);
  const explicitThreadId =
    params.threadId != null && String(params.threadId).trim() !== '' ? String(params.threadId).trim() : undefined;
  const explicitReplyToId = params.replyToId?.trim() || undefined;
  const replyToMessageId = explicitReplyToId ?? routeTarget.replyToMessageId;
  const replyInThread = Boolean(explicitThreadId ?? routeTarget.threadId);

  if (!explicitReplyToId && routeTarget.replyToMessageId) {
    log.info('resolved reply target from encoded originating route');
  }

  return {
    cfg: params.cfg,
    to: routeTarget.target,
    replyToMessageId,
    replyInThread,
    accountId: params.accountId ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const feishuOutbound: ChannelOutboundAdapter = {
  deliveryMode: 'direct',

  chunker: (text, limit) => LarkClient.runtime.channel.text.chunkMarkdownText(text, limit),

  chunkerMode: 'markdown',

  textChunkLimit: 15000,

  sendText: async ({ cfg, to, text, accountId, replyToId, threadId }) => {
    log.info(`sendText: target=${to}, textLength=${text.length}`);
    const ctx = resolveFeishuSendContext({ cfg, to, accountId, replyToId, threadId });
    const account = getLarkAccount(cfg, accountId);

    // When subagent merge is enabled, try to update the existing
    // streaming card instead of sending a new message.
    if (account.config?.subagent?.mergeToMain !== false) {
      // Registry uses bare chatId (oc_...), but `to` has prefix (chat:oc_...).
      const chatId = normalizeFeishuTarget(to) ?? to;
      const existing = consumeCompletedCard(chatId, ctx.accountId);

      if (existing) {
        // Accumulate subagent results into the existing card text.
        // Use originalCompletedText (the initial streaming card text) to detect
        // when the SDK sends an accumulated announce that already contains it.
        const origText = existing.originalCompletedText;
        let mergedText: string;
        if (text.startsWith(existing.completedText)) {
          // Announce already includes all accumulated text — use as-is
          mergedText = text;
        } else if (text.startsWith(origText)) {
          // SDK sent full response (origText + subagent results).
          // Strip the original prefix to get only the new content,
          // then append to the current accumulated text.
          const newContent = text.slice(origText.length).trim();
          mergedText = newContent
            ? existing.completedText + '\n' + newContent
            : existing.completedText;
        } else {
          // Independent subagent result — append to existing card
          mergedText = existing.completedText + '\n' + text;
        }

        const elapsedMs = Date.now() - existing.startedAt;
        log.info('sendText: merging into existing card', {
          messageId: existing.messageId,
          streamingOpen: existing.streamingOpen,
          elapsedMs,
        });

        try {
          let nextSeq = existing.cardKitSequence;

          if (existing.streamingOpen && existing.cardKitCardId) {
            // --- Streaming merge: stream content → close → finalize ---
            // 1. Push merged text via streaming API (CardKit auto-diffs for animation)
            nextSeq += 1;
            await streamCardContent({
              cfg,
              cardId: existing.cardKitCardId,
              elementId: STREAMING_ELEMENT_ID,
              content: mergedText,
              sequence: nextSeq,
              accountId: ctx.accountId,
            });
            log.info('sendText: streamed merged content', { seq: nextSeq });

            // 2. Close streaming mode
            nextSeq += 1;
            await setCardStreamingMode({
              cfg,
              cardId: existing.cardKitCardId,
              streamingMode: false,
              sequence: nextSeq,
              accountId: ctx.accountId,
            });

            // 3. Final card.update with footer
            nextSeq += 1;
            await updateCardKitCard({
              cfg,
              cardId: existing.cardKitCardId,
              card: toCardKit2(buildCardContent('complete', { text: mergedText, elapsedMs, footer: existing.footer })),
              sequence: nextSeq,
              accountId: ctx.accountId,
            });
            log.info('sendText: finalized card', { seq: nextSeq, elapsedMs });
          } else if (existing.cardKitCardId) {
            // --- Non-streaming merge: direct card.update ---
            nextSeq += 1;
            await updateCardKitCard({
              cfg,
              cardId: existing.cardKitCardId,
              card: toCardKit2(buildCardContent('complete', { text: mergedText, elapsedMs, footer: existing.footer })),
              sequence: nextSeq,
              accountId: ctx.accountId,
            });
          } else {
            // --- Legacy IM patch fallback ---
            await updateCardFeishu({
              cfg,
              messageId: existing.messageId,
              card: buildMarkdownCard(mergedText),
              accountId: ctx.accountId,
            });
          }

          // Re-register for subsequent merges. Streaming is now closed,
          // so next merge will use the non-streaming card.update path.
          // removeCompletedCard() in trackSubagentEnded cleans up when
          // all subagents finish, preventing stale entry issues.
          if (hasActiveSubagents(chatId, ctx.accountId)) {
            registerCompletedCard({
              chatId,
              accountId: ctx.accountId,
              messageId: existing.messageId,
              cardKitCardId: existing.cardKitCardId,
              cardKitSequence: nextSeq,
              completedText: mergedText,
              originalCompletedText: origText,
              startedAt: existing.startedAt,
              footer: existing.footer,
              streamingOpen: false,
            });
          }

          return { channel: 'feishu', messageId: existing.messageId, chatId };
        } catch (err) {
          log.warn('sendText: card merge failed, falling back', { error: String(err) });
        }
      }
    }

    // When deliveryType is 'card', send as a standalone card even without
    // an existing card to merge into (e.g. when the main agent produced no
    // streaming card reply and only spawned subAgents).
    if (account.config?.subagent?.deliveryType === 'card') {
      const card = buildMarkdownCard(text);
      const result = await sendCardLark({ ...ctx, to: ctx.to, card });
      return { channel: 'feishu', ...result };
    }

    const result = await sendTextLark({ ...ctx, to: ctx.to, text });
    return { channel: 'feishu', ...result };
  },

  sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, accountId, replyToId, threadId }) => {
    log.info(`sendMedia: target=${to}, ` + `hasText=${Boolean(text?.trim())}, mediaUrl=${mediaUrl ?? '(none)'}`);
    const ctx = resolveFeishuSendContext({ cfg, to, accountId, replyToId, threadId });

    // Feishu media messages do not support inline captions — send text first.
    if (text?.trim()) {
      await sendTextLark({ ...ctx, to: ctx.to, text });
    }

    // No mediaUrl — text-only fallback.
    if (!mediaUrl) {
      log.info('sendMedia: no mediaUrl provided, falling back to text-only');
      const result = await sendTextLark({ ...ctx, to: ctx.to, text: text ?? '' });
      return { channel: 'feishu', ...result };
    }

    const result = await sendMediaLark({ ...ctx, to: ctx.to, mediaUrl, mediaLocalRoots });
    return {
      channel: 'feishu',
      messageId: result.messageId,
      chatId: result.chatId,
      ...(result.warning ? { meta: { warnings: [result.warning] } } : {}),
    };
  },

  sendPayload: async ({ cfg, to, payload, mediaLocalRoots, accountId, replyToId, threadId }) => {
    const ctx = resolveFeishuSendContext({ cfg, to, accountId, replyToId, threadId });

    // --- channelData.feishu: card message support ---
    const feishuData = payload.channelData?.feishu as FeishuChannelData | undefined;

    // --- Resolve text + media from payload ---
    const text = payload.text ?? '';
    const mediaUrls = payload.mediaUrls?.length ? payload.mediaUrls : payload.mediaUrl ? [payload.mediaUrl] : [];

    log.info(
      `sendPayload: target=${to}, ` +
        `textLength=${text.length}, mediaCount=${mediaUrls.length}, ` +
        `hasCard=${Boolean(feishuData?.card)}`,
    );

    // --- channelData.feishu.card: card message path ---
    // Feishu card messages are standalone (msg_type="interactive"), so
    // text and media must be sent as separate messages around the card.
    if (feishuData?.card) {
      if (text.trim()) {
        await sendTextLark({ ...ctx, to: ctx.to, text });
      }

      const cardResult = await sendCardLark({ ...ctx, to: ctx.to, card: feishuData.card });

      const warnings: string[] = [];
      for (const mediaUrl of mediaUrls) {
        const mediaResult = await sendMediaLark({ ...ctx, to: ctx.to, mediaUrl, mediaLocalRoots });
        if (mediaResult.warning) {
          warnings.push(mediaResult.warning);
        }
      }

      return {
        channel: 'feishu',
        messageId: cardResult.messageId,
        chatId: cardResult.chatId,
        ...(warnings.length > 0 ? { meta: { warnings } } : {}),
      };
    }

    // --- Standard text + media orchestration (no card) ---

    // No media: text-only
    if (mediaUrls.length === 0) {
      const result = await sendTextLark({ ...ctx, to: ctx.to, text });
      return { channel: 'feishu', ...result };
    }

    // Has media: send leading text, then loop media URLs
    if (text.trim()) {
      await sendTextLark({ ...ctx, to: ctx.to, text });
    }

    const warnings: string[] = [];
    let lastResult: FeishuSendResult | undefined;
    for (const mediaUrl of mediaUrls) {
      lastResult = await sendMediaLark({ ...ctx, to: ctx.to, mediaUrl, mediaLocalRoots });
      if (lastResult.warning) {
        warnings.push(lastResult.warning);
      }
    }

    return {
      channel: 'feishu',
      ...(lastResult ?? { messageId: '', chatId: '' }),
      ...(warnings.length > 0 ? { meta: { warnings } } : {}),
    };
  },
};
