/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Reply dispatcher factory for the Lark/Feishu channel plugin.
 *
 * Thin factory function that:
 * 1. Resolves account, reply mode, and typing indicator config
 * 2. In streaming mode, delegates to StreamingCardController
 * 3. In static mode, delivers via sendMessageFeishu / sendMarkdownCardFeishu
 * 4. Assembles and returns FeishuReplyDispatcherResult
 */

import { createReplyPrefixContext, createTypingCallbacks } from 'openclaw/plugin-sdk/channel-runtime';
import { logTypingFailure } from 'openclaw/plugin-sdk/channel-feedback';
import type { ReplyPayload } from 'openclaw/plugin-sdk';
import { createAccountScopedConfig, getLarkAccount } from '../core/accounts';
import { resolveFooterConfig } from '../core/footer-config';
import { LarkClient } from '../core/lark-client';
import { larkLogger } from '../core/lark-logger';
import { sendMediaLark } from '../messaging/outbound/deliver';
import { sendMarkdownCardFeishu, sendMessageFeishu } from '../messaging/outbound/send';
import { extractAtMentionsFromText } from '../messaging/inbound/mention';
import { type TypingIndicatorState, addTypingIndicator, removeTypingIndicator } from '../messaging/outbound/typing';
import { isCardTableLimitError } from './card-error';
import type { CreateFeishuReplyDispatcherParams, FeishuReplyDispatcherResult } from './reply-dispatcher-types';
import { expandAutoMode, resolveReplyMode, shouldUseCard } from './reply-mode';
import { StreamingCardController } from './streaming-card-controller';
import { UnavailableGuard } from './unavailable-guard';

const log = larkLogger('card/reply-dispatcher');

// Re-export the params type for backward compatibility with dispatch.ts
export type { CreateFeishuReplyDispatcherParams } from './reply-dispatcher-types';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createFeishuReplyDispatcher(params: CreateFeishuReplyDispatcherParams): FeishuReplyDispatcherResult {
  const core = LarkClient.runtime;
  const { cfg, agentId, sessionKey, chatId, replyToMessageId, accountId, replyInThread } = params;

  // Resolve account so we can read per-account config (e.g. replyMode)
  const account = getLarkAccount(cfg, accountId);
  const feishuCfg = account.config;
  // accountScopedCfg 用于需要 account-level 覆盖的配置项（如 tableMode）
  const accountScopedCfg = createAccountScopedConfig(cfg, account.accountId);

  const prefixContext = createReplyPrefixContext({ cfg, agentId });

  // ---- Reply mode resolution ----
  const chatType = params.chatType;
  const effectiveReplyMode = resolveReplyMode({ feishuCfg, chatType });
  const replyMode = expandAutoMode({
    mode: effectiveReplyMode,
    streaming: feishuCfg?.streaming,
    chatType,
  });
  const useStreamingCards = replyMode === 'streaming';

  // ---- Block streaming for static mode ----
  const enableBlockStreaming = feishuCfg?.blockStreaming === true && !useStreamingCards;

  const resolvedFooter = resolveFooterConfig(feishuCfg?.footer);

  log.info('reply mode resolved', {
    effectiveReplyMode,
    replyMode,
    chatType,
  });
  log.info('footer config resolved', {
    accountId: account.accountId,
    sessionKey,
    chatType,
    useStreamingCards,
    rawFooter: feishuCfg?.footer ?? null,
    resolvedFooter,
  });

  // ---- Chunk & render settings (static mode only) ----
  const textChunkLimit = core.channel.text.resolveTextChunkLimit(cfg, 'feishu', accountId, { fallbackLimit: 4000 });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, 'feishu');
  // 使用 accountScopedCfg 以支持 per-account tableMode 覆盖
  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg: accountScopedCfg,
    channel: 'feishu',
  });

  // ---- Streaming card controller (instantiated only when needed) ----
  const controller = useStreamingCards
    ? new StreamingCardController({
        cfg,
        sessionKey,
        accountId,
        chatId,
        replyToMessageId,
        replyInThread,
        resolvedFooter,
      })
    : null;

  // ---- Static mode unavailable guard ----
  // In streaming mode the controller owns its own guard; in static mode
  // we still need unavailable-message detection for typing and deliver.
  let staticAborted = false;
  const staticGuard = controller
    ? null
    : new UnavailableGuard({
        replyToMessageId,
        getCardMessageId: () => null,
        onTerminate: () => {
          staticAborted = true;
        },
      });

  const shouldSkip = (source: string): boolean => {
    if (controller) return controller.shouldSkipForUnavailable(source);
    return staticGuard?.shouldSkip(source) ?? false;
  };

  const isTerminated = (): boolean => {
    if (controller) return controller.isTerminated;
    return staticGuard?.isTerminated ?? false;
  };

  // ---- Typing indicator (reaction-based) ----
  let typingState: TypingIndicatorState | null = null;
  let typingStopped = false;

  const typingCallbacks = createTypingCallbacks({
    keepaliveIntervalMs: 0,
    start: async () => {
      if (shouldSkip('typing.start.precheck')) return;
      if (!replyToMessageId || typingStopped || params.skipTyping) return;
      if (typingState?.reactionId) return;

      typingState = await addTypingIndicator({
        cfg,
        messageId: replyToMessageId,
        accountId,
      });
      if (shouldSkip('typing.start.postcheck')) return;

      if (typingStopped && typingState) {
        await removeTypingIndicator({ cfg, state: typingState, accountId });
        typingState = null;
        log.info('removed typing indicator (raced with stop)');
        return;
      }
      log.info('added typing indicator reaction');
    },
    stop: async () => {
      typingStopped = true;
      if (!typingState) return;
      await removeTypingIndicator({ cfg, state: typingState, accountId });
      typingState = null;
      log.info('removed typing indicator reaction');
    },
    onStartError: (err) => {
      logTypingFailure({
        log: (message) => log.warn(message),
        channel: 'feishu',
        action: 'start',
        error: err,
      });
    },
    onStopError: (err) => {
      logTypingFailure({
        log: (message) => log.warn(message),
        channel: 'feishu',
        action: 'stop',
        error: err,
      });
    },
  });

  // ---- dispatchFullyComplete flag (static mode) ----
  let dispatchFullyComplete = false;

  // ---- Build dispatcher ----
  const { dispatcher, replyOptions, markDispatchIdle } = core.channel.reply.createReplyDispatcherWithTyping({
    responsePrefix: prefixContext.responsePrefix,
    responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
    humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),

    onReplyStart: async () => {
      if (shouldSkip('onReplyStart')) return;
      await typingCallbacks.onReplyStart?.();
    },

    deliver: async (payload: ReplyPayload) => {
      log.debug('deliver called', {
        textPreview: payload.text?.slice(0, 100),
      });

      if (shouldSkip('deliver.entry')) return;

      // ---- Abort guard ----
      // Only check aborted (not isTerminalPhase) so that
      // creation_failed can still fallthrough to static delivery.
      if (staticAborted || controller?.isTerminated || controller?.isAborted) {
        log.debug('deliver: skipped (aborted)');
        return;
      }

      // ---- Post-dispatch guard ----
      if (dispatchFullyComplete) {
        log.debug('deliver: skipped (dispatch already complete)');
        return;
      }

      // 提取文本和媒体 URL
      const text = payload.text ?? '';
      const payloadMediaUrls = payload.mediaUrls?.length
        ? payload.mediaUrls
        : payload.mediaUrl
          ? [payload.mediaUrl]
          : [];

      // 提取文本中的 <at> 标签为 MentionInfo[]，用于跨 Bot 触发
      const extractedMentions = extractAtMentionsFromText(text);
      if (extractedMentions.length > 0) {
        log.info('deliver: extracted inline mentions from text', {
          count: extractedMentions.length,
          openIds: extractedMentions.map((m) => m.openId),
        });
      }

      if (!text.trim() && payloadMediaUrls.length === 0) {
        log.debug('deliver: empty text and no media, skipping');
        return;
      }

      // ---- Streaming card mode ----
      if (controller) {
        await controller.ensureCardCreated();
        if (controller.isTerminated) return;

        if (controller.cardMessageId) {
          await controller.onDeliver(payload);
          return;
        }
        // Card creation failed — fall through to static delivery
        log.warn('deliver: card creation failed, falling back to static delivery');
      }

      // ---- Static text delivery ----
      if (text.trim()) {
        if (shouldUseCard(text)) {
          const chunks = core.channel.text.chunkTextWithMode(text, textChunkLimit, chunkMode);
          log.info('deliver: sending card chunks', {
            count: chunks.length,
            chatId,
          });
          // Runtime fallback: shouldUseCard() 通过但 API 仍拒绝（表格数超限）
          let cardTableLimitHit = false;
          for (const chunk of chunks) {
            if (cardTableLimitHit) {
              // 已触发降级，后续 chunk 直接走纯文本
              try {
                await sendMessageFeishu({
                  cfg,
                  to: chatId,
                  text: chunk,
                  replyToMessageId,
                  replyInThread,
                  accountId,
                  mentions: extractedMentions.length > 0 ? extractedMentions : undefined,
                });
              } catch (fallbackErr) {
                if (staticGuard?.terminate('deliver.textFallback', fallbackErr)) return;
                throw fallbackErr;
              }
              continue;
            }
            try {
              await sendMarkdownCardFeishu({
                cfg,
                to: chatId,
                text: chunk,
                replyToMessageId,
                replyInThread,
                accountId,
                mentions: extractedMentions.length > 0 ? extractedMentions : undefined,
              });
            } catch (err) {
              if (staticGuard?.terminate('deliver.cardChunk', err)) return;
              // 卡片表格数超出飞书限制 — 降级为纯文本
              if (isCardTableLimitError(err)) {
                log.warn('card table limit exceeded (230099/11310), falling back to text', { chatId });
                cardTableLimitHit = true;
                try {
                  await sendMessageFeishu({
                    cfg,
                    to: chatId,
                    text: chunk,
                    replyToMessageId,
                    replyInThread,
                    accountId,
                    mentions: extractedMentions.length > 0 ? extractedMentions : undefined,
                  });
                } catch (fallbackErr) {
                  if (staticGuard?.terminate('deliver.textFallback', fallbackErr)) return;
                  throw fallbackErr;
                }
                continue;
              }
              throw err;
            }
          }
        } else {
          const converted = core.channel.text.convertMarkdownTables(text, tableMode);
          const chunks = core.channel.text.chunkTextWithMode(converted, textChunkLimit, chunkMode);
          log.info('deliver: sending text chunks', {
            count: chunks.length,
            chatId,
          });
          for (const chunk of chunks) {
            try {
              await sendMessageFeishu({
                cfg,
                to: chatId,
                text: chunk,
                replyToMessageId,
                replyInThread,
                accountId,
                mentions: extractedMentions.length > 0 ? extractedMentions : undefined,
              });
            } catch (err) {
              if (staticGuard?.terminate('deliver.textChunk', err)) return;
              throw err;
            }
          }
        }
      }

      // ---- Static media delivery ----
      for (const mediaUrl of payloadMediaUrls) {
        if (!mediaUrl?.trim()) continue;
        try {
          log.info('deliver: sending media via static path', {
            mediaUrl: mediaUrl.slice(0, 80),
          });
          await sendMediaLark({
            cfg,
            to: chatId,
            mediaUrl,
            accountId,
            replyToMessageId,
            replyInThread,
          });
        } catch (mediaErr) {
          if (staticGuard?.terminate('deliver.media', mediaErr)) return;
          log.error('deliver: static media send failed', {
            error: String(mediaErr),
          });
        }
      }
    },

    onError: async (err, info) => {
      if (controller) {
        if (controller.terminateIfUnavailable('onError', err)) {
          typingCallbacks.onIdle?.();
          return;
        }
        await controller.onError(err, info);
        typingCallbacks.onIdle?.();
        return;
      }

      // Static mode error handling
      if (staticGuard?.terminate('onError', err)) {
        typingCallbacks.onIdle?.();
        return;
      }
      log.error(`${info.kind} reply failed`, { error: String(err) });
      typingCallbacks.onIdle?.();
    },

    onIdle: async () => {
      if (isTerminated() || shouldSkip('onIdle')) {
        typingCallbacks.onIdle?.();
        return;
      }

      if (!dispatchFullyComplete) {
        typingCallbacks.onIdle?.();
        return;
      }

      if (controller) {
        await controller.onIdle();
      }

      typingCallbacks.onIdle?.();
    },

    onCleanup: async () => {
      typingCallbacks.onCleanup?.();
    },
  });

  // ---- Abort card (delegates to controller or no-op for static) ----
  const abortCard = controller ? () => controller.abortCard() : async () => {};

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
      disableBlockStreaming: !enableBlockStreaming,
      ...(controller
        ? {
            onReasoningStream: (payload: ReplyPayload) => controller.onReasoningStream(payload),
            onPartialReply: (payload: ReplyPayload) => controller.onPartialReply(payload),
          }
        : {}),
    },
    markDispatchIdle,
    markFullyComplete: () => {
      dispatchFullyComplete = true;
      controller?.markFullyComplete();
    },
    abortCard,
  };
}
