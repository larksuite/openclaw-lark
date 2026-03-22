/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * System command and permission notification dispatch for inbound messages.
 *
 * Handles control commands (/help, /reset, etc.) via plain-text delivery
 * and permission-error notifications via the streaming card flow.
 */

import type { DispatchContext } from './dispatch-context';
import type { PermissionError } from './permission';
import { LarkClient } from '../../core/lark-client';
import { larkLogger } from '../../core/lark-logger';
import { ticketElapsed } from '../../core/lark-ticket';
import { createFeishuReplyDispatcher } from '../../card/reply-dispatcher';
import { sendMessageFeishu } from '../outbound/send';
import { buildInboundPayload } from './dispatch-builders';

const log = larkLogger('inbound/dispatch-commands');

// ---------------------------------------------------------------------------
// Permission error notification
// ---------------------------------------------------------------------------

/**
 * Dispatch a permission-error notification to the agent so it can
 * inform the user about the missing Feishu API scope.
 */
export async function dispatchPermissionNotification(
  dc: DispatchContext,
  permissionError: PermissionError,
  replyToMessageId?: string,
): Promise<void> {
  const grantUrl = permissionError.grantUrl ?? '';
  const permissionNotifyBody = `[System: The bot encountered a Feishu API permission error. Please inform the user about this issue and provide the permission grant URL for the admin to authorize. Permission grant URL: ${grantUrl}]`;

  const permBody = dc.core.channel.reply.formatAgentEnvelope({
    channel: 'Feishu',
    from: dc.envelopeFrom,
    timestamp: new Date(),
    envelope: dc.envelopeOptions,
    body: permissionNotifyBody,
  });

  const permCtx = buildInboundPayload(dc, {
    body: permBody,
    bodyForAgent: permissionNotifyBody,
    rawBody: permissionNotifyBody,
    commandBody: permissionNotifyBody,
    senderName: 'system',
    senderId: 'system',
    messageSid: `${dc.ctx.messageId}:permission-error`,
    wasMentioned: false,
  });

  const {
    dispatcher: permDispatcher,
    replyOptions: permReplyOptions,
    markDispatchIdle: markPermIdle,
    markFullyComplete: markPermComplete,
  } = createFeishuReplyDispatcher({
    cfg: dc.accountScopedCfg,
    agentId: dc.route.agentId,
    sessionKey: dc.threadSessionKey ?? dc.route.sessionKey,
    chatId: dc.ctx.chatId,
    replyToMessageId: replyToMessageId ?? dc.ctx.messageId,
    accountId: dc.account.accountId,
    chatType: dc.ctx.chatType,
    replyInThread: dc.isThread,
  });

  dc.log(`feishu[${dc.account.accountId}]: dispatching permission error notification to agent`);

  await dc.core.channel.reply.dispatchReplyFromConfig({
    ctx: permCtx,
    cfg: dc.accountScopedCfg,
    dispatcher: permDispatcher,
    replyOptions: permReplyOptions,
  });

  await permDispatcher.waitForIdle();
  markPermComplete();
  markPermIdle();
}

// ---------------------------------------------------------------------------
// System command dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch a system command (/help, /reset, etc.) via plain-text delivery.
 * No streaming card, no "Processing..." state.
 *
 * When `suppressReply` is true the agent still runs (e.g. reads workspace
 * files) but its text output is not forwarded to Feishu.  This is used for
 * bare /new and /reset commands: the SDK already sends a "done" notice
 * via its own route, so the AI greeting would be redundant.
 */
export async function dispatchSystemCommand(
  dc: DispatchContext,
  ctxPayload: ReturnType<typeof LarkClient.runtime.channel.reply.finalizeInboundContext>,
  suppressReply = false,
  replyToMessageId?: string,
): Promise<void> {
  let delivered = false;

  dc.log(
    `feishu[${dc.account.accountId}]: detected system command, using plain-text dispatch${suppressReply ? ' (reply suppressed)' : ''}`,
  );
  log.info(`system command detected, plain-text dispatch${suppressReply ? ', reply suppressed' : ''}`);

  await dc.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: dc.accountScopedCfg,
    dispatcherOptions: {
      deliver: async (payload) => {
        if (suppressReply) return;
        const text = payload.text?.trim() ?? '';
        if (!text) return;
        await sendMessageFeishu({
          cfg: dc.accountScopedCfg,
          to: dc.ctx.chatId,
          text,
          replyToMessageId: replyToMessageId ?? dc.ctx.messageId,
          accountId: dc.account.accountId,
          replyInThread: dc.isThread,
        });
        delivered = true;
      },
      onSkip: (_payload, info) => {
        if (info.reason !== 'silent') {
          dc.log(`feishu[${dc.account.accountId}]: command reply skipped (reason=${info.reason})`);
        }
      },
      onError: (err, info) => {
        dc.error(`feishu[${dc.account.accountId}]: command ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {},
  });

  dc.log(`feishu[${dc.account.accountId}]: system command dispatched (delivered=${delivered})`);
  log.info(`system command dispatched (delivered=${delivered}, elapsed=${ticketElapsed()}ms)`);
}
