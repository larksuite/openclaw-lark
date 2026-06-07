import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import type { ChannelOutboundAdapter } from 'openclaw/plugin-sdk/channel-send-result';
import { LarkClient } from '../../core/lark-client';
import { larkLogger } from '../../core/lark-logger';
import { parseFeishuRouteTarget } from '../../core/targets';
import { isCommentTarget } from '../../core/comment-target';
import { isSyntheticTarget } from '../../core/synthetic-target';
import type { FeishuSendResult } from '../types';
import { sendCardLark, sendCommentReplyLark, sendMediaLark, sendTextLark } from './deliver';

const log = larkLogger('outbound/outbound');

interface FeishuChannelData {
  card?: Record<string, unknown>;
}

interface FeishuSendContext {
  cfg: ClawdbotConfig;
  to: string;
  replyToMessageId?: string;
  replyInThread: boolean;
  threadId?: string;
  accountId?: string;
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
    threadId: explicitThreadId,
    accountId: params.accountId ?? undefined,
  };
}

export const feishuOutbound: ChannelOutboundAdapter = {
  deliveryMode: 'direct',

  chunker: (text, limit) => LarkClient.runtime.channel.text.chunkMarkdownText(text, limit),

  chunkerMode: 'markdown',

  textChunkLimit: 15000,

  sendText: async ({ cfg, to, text, accountId, replyToId, threadId }) => {
    log.info(`sendText: target=${to}, textLength=${text.length}`);

    if (isSyntheticTarget(to)) {
      log.debug(`sendText: synthetic target ${to}, dropping outbound IM send`);
      return { channel: 'feishu', messageId: '', chatId: to };
    }

    if (isCommentTarget(to)) {
      log.info(`sendText: detected comment target, routing through Drive comment API`);
      const result = await sendCommentReplyLark({ cfg, to, text, accountId: accountId ?? undefined });
      return { channel: 'feishu', ...result };
    }

    const ctx = resolveFeishuSendContext({ cfg, to, accountId, replyToId, threadId });
    const result = await sendTextLark({ ...ctx, to: ctx.to, text });
    return { channel: 'feishu', ...result };
  },

  sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, accountId, replyToId, threadId }) => {
    log.info(`sendMedia: target=${to}, ` + `hasText=${Boolean(text?.trim())}, mediaUrl=${mediaUrl ?? '(none)'}`);

    if (isSyntheticTarget(to)) {
      log.debug(`sendMedia: synthetic target ${to}, dropping outbound IM send`);
      return { channel: 'feishu', messageId: '', chatId: to };
    }

    if (isCommentTarget(to)) {
      log.info(`sendMedia: detected comment target, routing through Drive comment API`);
      const parts: string[] = [];
      if (text?.trim()) parts.push(text.trim());
      if (mediaUrl) parts.push(`📎 ${mediaUrl}`);
      const combinedText = parts.join('\n') || '(media)';
      const result = await sendCommentReplyLark({ cfg, to, text: combinedText, accountId: accountId ?? undefined });
      return { channel: 'feishu', ...result };
    }

    const ctx = resolveFeishuSendContext({ cfg, to, accountId, replyToId, threadId });

    // If this is a TTS voice file, send it ONLY and return immediately.
    if (mediaUrl && mediaUrl.includes("/.openclaw/media/outbound/voice-")) {
        log.info(`sendMedia: prioritized local TTS voice file: ${mediaUrl}`);
        const result = await sendMediaLark({ ...ctx, to: ctx.to, mediaUrl, mediaLocalRoots });
        return {
            channel: "feishu",
            messageId: result.messageId,
            chatId: result.chatId,
        };
    }

    let captionResult: { messageId: string; chatId: string; warning?: string } | undefined;
    if (text?.trim()) {
      captionResult = await sendTextLark({ ...ctx, to: ctx.to, text });
    }

    if (!mediaUrl) {
      log.info('sendMedia: no mediaUrl provided, falling back to text-only');
      if (captionResult) {
        return { channel: 'feishu', ...captionResult };
      }
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
    if (isSyntheticTarget(to)) {
      log.debug(`sendPayload: synthetic target ${to}, dropping outbound IM send`);
      return { channel: 'feishu', messageId: '', chatId: to };
    }

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

    // Priority handling for TTS voice files in payload.
    const voiceUrl = mediaUrls.find(url => url.includes("/.openclaw/media/outbound/voice-"));
    if (voiceUrl) {
        log.info(`sendPayload: prioritized local TTS voice file: ${voiceUrl}`);
        const result = await sendMediaLark({ ...ctx, to: ctx.to, mediaUrl: voiceUrl, mediaLocalRoots });
        return {
            channel: "feishu",
            messageId: result.messageId,
            chatId: result.chatId,
        };
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
