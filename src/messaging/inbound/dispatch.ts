/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Agent dispatch for inbound Feishu messages.
 *
 * Builds the agent envelope, prepends chat history context, and
 * dispatches through the appropriate reply path (system command
 * vs. normal streaming/static flow).
 *
 * Implementation details are split across focused modules:
 * - dispatch-context.ts  — DispatchContext type, route/session/event
 * - dispatch-builders.ts — pure payload/body/envelope construction
 * - dispatch-commands.ts — system command & permission notification
 */

import type { ClawdbotConfig, RuntimeEnv  } from 'openclaw/plugin-sdk';
import type { HistoryEntry } from 'openclaw/plugin-sdk/reply-history';
import { clearHistoryEntriesIfEnabled } from 'openclaw/plugin-sdk/reply-history';
import type { MessageContext } from '../types';
import type { FeishuGroupConfig, LarkAccount  } from '../../core/types';
import { larkLogger } from '../../core/lark-logger';
import { ticketElapsed } from '../../core/lark-ticket';
import { createFeishuReplyDispatcher } from '../../card/reply-dispatcher';
import {
  buildQueueKey,
  registerActiveDispatcher,
  threadScopedKey,
  unregisterActiveDispatcher,
} from '../../channel/chat-queue';
import { resolveToolUseDisplayConfig } from '../../card/tool-use-config';
import { clearToolUseTraceRun, startToolUseTraceRun } from '../../card/tool-use-trace-store';
import { isLikelyAbortText } from '../../channel/abort-detect';
import { isThreadCapableGroup } from '../../core/chat-info-cache';
import { isCommentTarget } from '../../core/comment-target';
import { SYNTHETIC_VC_CHAT_ID, isSyntheticTarget } from '../../core/synthetic-target';
import { encodeFeishuRouteTarget } from '../../core/targets';
import type { LarkClient } from '../../core/lark-client';
import { sendCommentReplyLark } from '../outbound/deliver';
import { runFeishuDoctorI18n } from '../../commands/doctor';
import { runFeishuAuthI18n } from '../../commands/auth';
import { getFeishuHelpI18n, runFeishuStartI18n } from '../../commands/index';
import { buildI18nMarkdownCard, sendCardFeishu, sendMessageFeishu } from '../outbound/send';
import { dispatchPermissionNotification, dispatchSystemCommand } from './dispatch-commands';
import {
  buildBodyForAgent,
  buildEnvelopeWithHistory,
  buildInboundPayload,
  buildMessageBody,
} from './dispatch-builders';
import { getSentinelStore } from './sentinel-store';
import { type DispatchContext, buildDispatchContext, resolveThreadSessionKey } from './dispatch-context';
import type { PermissionError } from './permission';
import { mentionedBot } from './mention';
import { resolveRespondToMentionAll } from './gate';

const log = larkLogger('inbound/dispatch');

// ---------------------------------------------------------------------------
// Internal: normal message dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch a normal (non-command) message via the streaming card flow.
 * Cleans up consumed history entries after dispatch completes.
 *
 * Note: history cleanup is intentionally placed here and NOT in the
 * system-command path — command handlers don't consume history context,
 * so the entries should be preserved for the next normal message.
 */
/**
 * Dispatch a comment-target message via the buffered block dispatcher.
 *
 * Comment targets cannot use the streaming card flow (IM APIs don't
 * understand comment:... targets). Instead we use the SDK's buffered
 * block dispatcher with a deliver callback that sends via the Drive
 * comment reply API.
 */
async function dispatchCommentMessage(
  dc: DispatchContext,
  ctxPayload: ReturnType<typeof LarkClient.runtime.channel.reply.finalizeInboundContext>,
  skillFilter?: string[],
): Promise<void> {
  const effectiveSessionKey = dc.threadSessionKey ?? dc.route.sessionKey;
  dc.log(`feishu[${dc.account.accountId}]: dispatching comment reply (session=${effectiveSessionKey})`);
  log.info(`dispatching comment reply (session=${effectiveSessionKey})`);

  let delivered = false;

  await dc.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: dc.accountScopedCfg,
    dispatcherOptions: {
      deliver: async (payload) => {
        const text = payload.text?.trim() ?? '';
        if (!text || text === 'NO_REPLY') return;
        await sendCommentReplyLark({
          cfg: dc.accountScopedCfg,
          to: dc.ctx.chatId,
          text,
          accountId: dc.account.accountId,
        });
        delivered = true;
      },
      onSkip: (_payload, info) => {
        if (info.reason !== 'silent') {
          dc.log(`feishu[${dc.account.accountId}]: comment reply skipped (reason=${info.reason})`);
        }
      },
      onError: (err, info) => {
        dc.error(`feishu[${dc.account.accountId}]: comment ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      ...(skillFilter ? { skillFilter } : {}),
    },
  });

  dc.log(`feishu[${dc.account.accountId}]: comment dispatch complete (delivered=${delivered})`);
  log.info(`comment dispatch complete (delivered=${delivered}, elapsed=${ticketElapsed()}ms)`);
}

/**
 * Dispatch a synthetic-target message via the buffered block dispatcher
 * while discarding every delivered payload.
 *
 * Synthetic contexts (e.g. VC meeting-invited) trigger the agent for its
 * side-effects (tool calls) — they do not correspond to a real IM chat,
 * so any text / card the agent emits must be dropped instead of being
 * sent as a DM to whatever open_id happens to be in ctx.chatId.
 */
async function dispatchSyntheticMessage(
  dc: DispatchContext,
  ctxPayload: ReturnType<typeof LarkClient.runtime.channel.reply.finalizeInboundContext>,
  skillFilter?: string[],
): Promise<void> {
  const effectiveSessionKey = dc.threadSessionKey ?? dc.route.sessionKey;
  const isVcSynthetic = dc.ctx.chatId === SYNTHETIC_VC_CHAT_ID;
  let deliveredFinalToSender = false;
  dc.log(
    `feishu[${dc.account.accountId}]: dispatching synthetic reply (session=${effectiveSessionKey}, target=${dc.ctx.chatId})`,
  );
  log.info(`dispatching synthetic reply (session=${effectiveSessionKey})`);

  await dc.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: dc.accountScopedCfg,
    dispatcherOptions: {
      deliver: async (payload, info) => {
        const text = payload.text?.trim() ?? '';
        const preview = text.slice(0, 120);

        // VC invited flows intentionally keep the synthetic target to avoid
        // leaking intermediate tool output to IM, but the final business
        // result should be explicitly notified to the inviter.
        //
        // Important: this DM is only a transport bridge for the final text.
        // It does not rebind the inviter's DM conversation to the synthetic
        // meeting-scoped session; later DM replies will still be routed by the
        // normal OpenClaw DM session rules.
        if (isVcSynthetic && info.kind === 'final' && text && text !== 'NO_REPLY' && !deliveredFinalToSender) {
          deliveredFinalToSender = true;
          try {
            await sendMessageFeishu({
              cfg: dc.accountScopedCfg,
              to: dc.ctx.senderId,
              text,
              accountId: dc.account.accountId,
            });
            dc.log(
              `feishu[${dc.account.accountId}]: synthetic VC final delivered explicitly to sender=${dc.ctx.senderId}, preview="${preview}"`,
            );
            return;
          } catch (err) {
            deliveredFinalToSender = false;
            dc.error(
              `feishu[${dc.account.accountId}]: synthetic VC final delivery failed to sender=${dc.ctx.senderId}: ${String(err)}`,
            );
          }
        }

        if (info.kind === 'final') {
          dc.log(
            `feishu[${dc.account.accountId}]: synthetic final payload dropped (target=${dc.ctx.chatId})`,
          );
        }
      },
      onSkip: (_payload, info) => {
        if (info.reason !== 'silent') {
          dc.log(`feishu[${dc.account.accountId}]: synthetic reply skipped (reason=${info.reason})`);
        }
      },
      onError: (err, info) => {
        dc.error(`feishu[${dc.account.accountId}]: synthetic ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      ...(skillFilter ? { skillFilter } : {}),
    },
  });

  dc.log(`feishu[${dc.account.accountId}]: synthetic dispatch complete (elapsed=${ticketElapsed()}ms)`);
}

async function dispatchNormalMessage(
  dc: DispatchContext,
  ctxPayload: ReturnType<typeof LarkClient.runtime.channel.reply.finalizeInboundContext>,
  chatHistories: Map<string, HistoryEntry[]> | undefined,
  historyKey: string | undefined,
  historyLimit: number,
  replyToMessageId?: string,
  skillFilter?: string[],
  skipTyping?: boolean,
): Promise<void> {
  // Synthetic targets (e.g. VC meeting-invited) have no real IM peer to
  // deliver replies to. Route them through the buffered block dispatcher
  // with a deliver() that drops every payload — the agent still runs
  // (tool calls, side-effects) but produces no outbound IM traffic.
  if (isSyntheticTarget(dc.ctx.chatId)) {
    await dispatchSyntheticMessage(dc, ctxPayload, skillFilter);
    return;
  }

  // Comment targets bypass the streaming card / IM flow entirely —
  // route through the Drive comment reply API.
  if (isCommentTarget(dc.ctx.chatId)) {
    await dispatchCommentMessage(dc, ctxPayload, skillFilter);
    return;
  }

  // Abort messages should never create streaming cards — dispatch via the
  // plain-text system-command path so the SDK's abort handler can reply
  // without touching CardKit.
  if (isLikelyAbortText(dc.ctx.content?.trim() ?? '')) {
    dc.log(`feishu[${dc.account.accountId}]: abort message detected, using plain-text dispatch`);
    log.info('abort message detected, using plain-text dispatch');
    await dispatchSystemCommand(dc, ctxPayload, replyToMessageId);
    return;
  }

  const effectiveSessionKey = dc.threadSessionKey ?? dc.route.sessionKey;
  const toolUseDisplay = resolveToolUseDisplayConfig({
    cfg: dc.accountScopedCfg,
    feishuCfg: dc.account.config,
    agentId: dc.route.agentId,
    sessionKey: effectiveSessionKey,
    body: dc.ctx.content,
  });
  if (toolUseDisplay.showToolUse) {
    startToolUseTraceRun(effectiveSessionKey);
  } else {
    clearToolUseTraceRun(effectiveSessionKey);
  }

  const { dispatcher, replyOptions, markDispatchIdle, markFullyComplete, abortCard } = createFeishuReplyDispatcher({
    cfg: dc.accountScopedCfg,
    agentId: dc.route.agentId,
    chatId: dc.ctx.chatId,
    sessionKey: effectiveSessionKey,
    replyToMessageId: replyToMessageId ?? dc.ctx.messageId,
    accountId: dc.account.accountId,
    chatType: dc.ctx.chatType,
    skipTyping,
    replyInThread: dc.isThread,
    threadId: dc.isThread ? dc.ctx.threadId : undefined,
    toolUseDisplay,
  });

  // Create an AbortController so the abort fast-path can cancel the
  // underlying LLM request (not just the streaming card UI).
  const abortController = new AbortController();

  // Register the active dispatcher so the monitor abort fast-path can
  // terminate the streaming card before this task completes.
  const queueKey = buildQueueKey(dc.account.accountId, dc.ctx.chatId, dc.ctx.threadId);
  registerActiveDispatcher(queueKey, { abortCard, abortController });

  dc.log(`feishu[${dc.account.accountId}]: dispatching to agent (session=${effectiveSessionKey})`);
  log.info(`dispatching to agent (session=${effectiveSessionKey})`);

  try {
    const { queuedFinal, counts } = await dc.core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg: dc.accountScopedCfg,
      dispatcher,
      replyOptions: {
        ...replyOptions,
        abortSignal: abortController.signal,
        ...(skillFilter ? { skillFilter } : {}),
      },
    });

    // Wait for all enqueued deliver() calls in the SDK's sendChain to
    // complete before marking the dispatch as done.  Without this,
    // dispatchReplyFromConfig() may return while the final deliver() is
    // still pending in the Promise chain, causing markFullyComplete() to
    // block it and leaving completedText incomplete — which in turn makes
    // the streaming card's final update show truncated content.
    await dispatcher.waitForIdle();

    markFullyComplete();
    markDispatchIdle();

    // Clean up consumed history entries
    if (dc.isGroup && historyKey && chatHistories) {
      clearHistoryEntriesIfEnabled({
        historyMap: chatHistories,
        historyKey,
        limit: historyLimit,
      });
    }

    dc.log(`feishu[${dc.account.accountId}]: dispatch complete (queuedFinal=${queuedFinal}, replies=${counts.final})`);
    log.info(`dispatch complete (replies=${counts.final}, elapsed=${ticketElapsed()}ms)`);
  } finally {
    unregisterActiveDispatcher(queueKey);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function dispatchToAgent(params: {
  ctx: MessageContext;
  permissionError?: PermissionError;
  mediaPayload: Record<string, unknown>;
  /** Additional structured metadata for synthetic or event-driven inbound flows. */
  extraInboundFields?: Record<string, unknown>;
  quotedContent?: string;
  account: LarkAccount;
  /** account 级别的 ClawdbotConfig（channels.feishu 已替换为 per-account 合并后的配置） */
  accountScopedCfg: ClawdbotConfig;
  runtime?: RuntimeEnv;
  chatHistories?: Map<string, HistoryEntry[]>;
  historyLimit: number;
  /** Override the message ID used for reply threading.  When set, the
   *  reply-dispatcher uses this ID for typing indicators and card replies
   *  instead of ctx.messageId (which may be a synthetic ID). */
  replyToMessageId?: string;
  /** When set, controls whether the sender is authorized to execute
   *  control commands.  Computed by the handler via the SDK's access
   *  group command gating system. */
  commandAuthorized?: boolean;
  /** Per-group configuration for skills, systemPrompt, etc. */
  groupConfig?: FeishuGroupConfig;
  /** Default group configuration from the "*" wildcard entry. */
  defaultGroupConfig?: FeishuGroupConfig;
  /** When true, the reply dispatcher skips typing indicators. */
  skipTyping?: boolean;
}): Promise<void> {
  // 1. Derive shared context (including route resolution + system event)
  const dc = buildDispatchContext(params);

  // 1a. Thread detection fallback for topic groups.
  //     In topic groups (chat_mode=topic), reply events may carry root_id
  //     without thread_id.  When threadSession is enabled, use root_id as
  //     a synthetic threadId so replies stay inside the topic instead of
  //     creating a new top-level message.
  if (!dc.isThread && dc.isGroup && dc.ctx.rootId && dc.account.config?.threadSession === true) {
    const threadCapable = await isThreadCapableGroup({
      cfg: dc.accountScopedCfg,
      chatId: dc.ctx.chatId,
      accountId: dc.account.accountId,
    });
    if (threadCapable) {
      log.info(`inferred thread from root_id=${dc.ctx.rootId} in topic group ${dc.ctx.chatId}`);
      dc.isThread = true;
      dc.ctx = { ...dc.ctx, threadId: dc.ctx.rootId };
    }
  }

  // 1b. Resolve thread session isolation (async: may query group info API)
  if (dc.isThread && dc.ctx.threadId) {
    dc.threadSessionKey = await resolveThreadSessionKey({
      accountScopedCfg: dc.accountScopedCfg,
      account: dc.account,
      chatId: dc.ctx.chatId,
      threadId: dc.ctx.threadId,
      baseSessionKey: dc.route.sessionKey,
    });
  }

  // Consume any pending mention sentinels for this thread. Take and
  // delete is one shot per inbound — capture once, hand to both body
  // builders below.
  const sentinelKey = threadScopedKey(dc.ctx.chatId, dc.isThread ? dc.ctx.threadId : undefined);
  const sentinels = getSentinelStore(dc.account.accountId).consumeSentinels(sentinelKey);

  // 3. Build annotated message body
  const messageBody = buildMessageBody(params.ctx, params.quotedContent, sentinels);

  // 4. Permission-error notification (optional side-effect).
  //    Isolated so a failure here does not block the main message dispatch.
  //    Skipped for comment targets: the streaming card dispatcher inside
  //    dispatchPermissionNotification sends via IM APIs which don't
  //    understand comment:... targets.
  if (params.permissionError && !isCommentTarget(dc.ctx.chatId)) {
    try {
      await dispatchPermissionNotification(dc, params.permissionError, params.replyToMessageId);
    } catch (err) {
      dc.error(`feishu[${dc.account.accountId}]: permission notification failed, continuing: ${String(err)}`);
    }
  }

  // 5. Build main envelope (with group chat history)
  const { combinedBody, historyKey } = buildEnvelopeWithHistory(
    dc,
    messageBody,
    params.chatHistories,
    params.historyLimit,
  );

  // 6. Build BodyForAgent with mention annotation (if any).
  //    SDK >= 2026.2.10 no longer falls back to Body for BodyForAgent,
  //    so we must set it explicitly to preserve the annotation.
  const bodyForAgent = buildBodyForAgent(params.ctx, sentinels);

  // 7. Build InboundHistory for SDK metadata injection (>= 2026.2.10).
  //    The SDK's buildInboundUserContextPrefix renders these as structured
  //    JSON blocks; earlier SDK versions simply ignore unknown fields.
  const threadHistoryKey = threadScopedKey(dc.ctx.chatId, dc.isThread ? dc.ctx.threadId : undefined);
  const inboundHistory =
    dc.isGroup && params.chatHistories && params.historyLimit > 0
      ? (params.chatHistories.get(threadHistoryKey) ?? []).map((entry) => ({
          sender: entry.sender,
          body: entry.body,
          timestamp: entry.timestamp ?? Date.now(),
        }))
      : undefined;

  // 8. Build inbound context payload
  const isBareNewOrReset = /^\/(?:new|reset)\s*$/i.test((params.ctx.content ?? '').trim());
  const groupSystemPrompt = dc.isGroup
    ? params.groupConfig?.systemPrompt?.trim() || params.defaultGroupConfig?.systemPrompt?.trim() || undefined
    : undefined;
  const originatingTo =
    isBareNewOrReset && dc.isThread
      ? encodeFeishuRouteTarget({
          target: dc.feishuTo,
          replyToMessageId: params.replyToMessageId ?? params.ctx.messageId,
          threadId: dc.ctx.threadId,
        })
      : undefined;
  const ctxPayload = buildInboundPayload(dc, {
    body: combinedBody,
    bodyForAgent,
    rawBody: params.ctx.content,
    commandBody: params.ctx.content,
    originatingTo,
    senderName: params.ctx.senderName ?? params.ctx.senderId,
    senderId: params.ctx.senderId,
    messageSid: params.ctx.messageId,
    wasMentioned:
      mentionedBot(params.ctx) ||
      (params.ctx.mentionAll &&
        resolveRespondToMentionAll({
          groupConfig: params.groupConfig,
          defaultConfig: params.defaultGroupConfig,
          accountFeishuCfg: params.account.config,
        })),
    replyToBody: params.quotedContent,
    inboundHistory,
    extraFields: {
      ...params.mediaPayload,
      ...(params.extraInboundFields ?? {}),
      ...(groupSystemPrompt ? { GroupSystemPrompt: groupSystemPrompt } : {}),
      ...(dc.ctx.threadId ? { MessageThreadId: dc.ctx.threadId } : {}),
    },
  });

  // 9a. Intercept /feishu commands for i18n multi-locale card dispatch
  //     Must run BEFORE the SDK command check — the SDK does not recognise
  //     plugin-registered commands via isControlCommandMessage, so
  //     /feishu_* falls through to the AI agent otherwise.
  //     Skipped for comment targets: comment text won't match /feishu_*
  //     patterns in practice, and sendCardFeishu/sendMessageFeishu can't
  //     deliver to comment:... targets.
  const contentTrimmed = (params.ctx.content ?? '').trim();
  const isCommentFlow = isCommentTarget(dc.ctx.chatId);
  const isDoctorCommand = !isCommentFlow && /^\/feishu[_ ]doctor\s*$/i.test(contentTrimmed);
  const isAuthCommand = !isCommentFlow && /^\/feishu[_ ](?:auth|onboarding)\s*$/i.test(contentTrimmed);
  const isStartCommand = !isCommentFlow && /^\/feishu[_ ]start\s*$/i.test(contentTrimmed);
  const isHelpCommand = !isCommentFlow && /^\/feishu(?:[_ ]help)?\s*$/i.test(contentTrimmed);

  const i18nCommandName = isDoctorCommand
    ? 'doctor'
    : isAuthCommand
      ? 'auth'
      : isStartCommand
        ? 'start'
        : isHelpCommand
          ? 'help'
          : null;

  if (i18nCommandName) {
    dc.log(`feishu[${dc.account.accountId}]: ${i18nCommandName} command detected, using i18n dispatch`);
    log.info(`${i18nCommandName} command detected, using i18n dispatch`);
    try {
      let i18nTexts: Record<string, string>;
      if (isDoctorCommand) {
        i18nTexts = await runFeishuDoctorI18n(dc.accountScopedCfg, dc.account.accountId);
      } else if (isAuthCommand) {
        i18nTexts = await runFeishuAuthI18n(dc.accountScopedCfg);
      } else if (isStartCommand) {
        i18nTexts = runFeishuStartI18n(dc.accountScopedCfg);
      } else {
        i18nTexts = getFeishuHelpI18n();
      }
      const card = buildI18nMarkdownCard(i18nTexts);
      await sendCardFeishu({
        cfg: dc.accountScopedCfg,
        to: dc.ctx.chatId,
        card,
        replyToMessageId: params.replyToMessageId ?? dc.ctx.messageId,
        accountId: dc.account.accountId,
        replyInThread: dc.isThread,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      dc.error(`feishu[${dc.account.accountId}]: ${i18nCommandName} i18n dispatch failed: ${errMsg}`);
      await sendMessageFeishu({
        cfg: dc.accountScopedCfg,
        to: dc.ctx.chatId,
        text: `${i18nCommandName} failed: ${errMsg}`,
        replyToMessageId: params.replyToMessageId ?? dc.ctx.messageId,
        accountId: dc.account.accountId,
        replyInThread: dc.isThread,
      });
    }
    return;
  }

  // 8. Dispatch: system command vs. normal message
  //    Comment targets always go to normal dispatch — system command
  //    delivery uses sendMessageFeishu which can't reach comment threads.
  const isCommand = !isCommentFlow &&
    dc.core.channel.commands.isControlCommandMessage(params.ctx.content, params.accountScopedCfg);

  // Resolve per-group skill filter (per-group > default "*")
  const skillFilter = dc.isGroup ? (params.groupConfig?.skills ?? params.defaultGroupConfig?.skills) : undefined;

  if (isCommand) {
    await dispatchSystemCommand(dc, ctxPayload, params.replyToMessageId);
    // /new and /reset explicitly start a new session — clear pending history
    if (isBareNewOrReset && dc.isGroup && historyKey && params.chatHistories) {
      clearHistoryEntriesIfEnabled({
        historyMap: params.chatHistories,
        historyKey,
        limit: params.historyLimit,
      });
    }
  } else {
    // Normal message dispatch; history cleanup happens inside.
    // System commands intentionally skip history cleanup — command handlers
    // don't consume history context, so entries are preserved for the next
    // normal message.
    await dispatchNormalMessage(
      dc,
      ctxPayload,
      params.chatHistories,
      historyKey,
      params.historyLimit,
      params.replyToMessageId,
      skillFilter,
      params.skipTyping,
    );
  }
}
