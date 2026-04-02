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

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import type { ChannelOutboundAdapter } from 'openclaw/plugin-sdk/channel-send-result';
import type { FeishuSendResult } from '../types';
import { LarkClient } from '../../core/lark-client';
import { getLarkAccount } from '../../core/accounts';
import { parseFeishuRouteTarget } from '../../core/targets';
import { larkLogger } from '../../core/lark-logger';
import { buildMarkdownCard } from './send';
import { sendCardLark, sendMediaLark, sendTextLark } from './deliver';
import { tryMergeToMainCard } from './subagent-delivery';

const log = larkLogger('outbound/outbound');

// ---------------------------------------------------------------------------
// channelData.feishu contract
// ---------------------------------------------------------------------------

/**
 * Channel-specific payload for Feishu, carried in `ReplyPayload.channelData.feishu`.
 */
export interface FeishuChannelData {
  /**
   * A complete Feishu interactive card JSON object (v1 or v2).
   *
   * The card is sent as-is via `msg_type: "interactive"`. The Feishu server
   * uses the presence of `schema: "2.0"` to determine the card version.
   */
  card?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Shared context resolution
// ---------------------------------------------------------------------------

interface FeishuSendContext {
  cfg: ClawdbotConfig;
  to: string;
  replyToMessageId?: string;
  replyInThread: boolean;
  accountId?: string;
  threadId?: string;
}

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
    threadId: explicitThreadId,
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

    // ---- SubAgent merge pre-check ----
    // Only activates when mergeToMain is enabled AND an active streaming
    // card exists for this conversation.  On merge failure with delivery='card',
    // subagent-delivery handles the standalone card with footer internally.
    const merged = await tryMergeToMainCard({
      cfg,
      to,
      text,
      accountId: ctx.accountId,
      threadId: ctx.threadId,
      replyToMessageId: ctx.replyToMessageId,
      replyInThread: ctx.replyInThread,
    });
    if (merged) return merged;

    // ---- Normal delivery based on account delivery mode ----
    const account = getLarkAccount(cfg, accountId);
    const delivery = account.config?.delivery ?? 'text';

    if (delivery === 'card') {
      const card = buildMarkdownCard(text);
      const result = await sendCardLark({ ...ctx, to: ctx.to, card });
      return { channel: 'feishu', ...result };
    }

    // Default: plain text message
    const result = await sendTextLark({ ...ctx, to: ctx.to, text });
    return { channel: 'feishu', ...result };
  },

  sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, accountId, replyToId, threadId }) => {
    log.info(`sendMedia: target=${to}, ` + `hasText=${Boolean(text?.trim())}, mediaUrl=${mediaUrl ?? '(none)'}`);
    const ctx = resolveFeishuSendContext({ cfg, to, accountId, replyToId, threadId });

    if (text?.trim()) {
      await sendTextLark({ ...ctx, to: ctx.to, text });
    }

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

    const feishuData = payload.channelData?.feishu as FeishuChannelData | undefined;
    const text = payload.text ?? '';
    const mediaUrls = payload.mediaUrls?.length ? payload.mediaUrls : payload.mediaUrl ? [payload.mediaUrl] : [];

    log.info(
      `sendPayload: target=${to}, ` +
        `textLength=${text.length}, mediaCount=${mediaUrls.length}, ` +
        `hasCard=${Boolean(feishuData?.card)}`,
    );

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

    if (mediaUrls.length === 0) {
      const result = await sendTextLark({ ...ctx, to: ctx.to, text });
      return { channel: 'feishu', ...result };
    }

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
