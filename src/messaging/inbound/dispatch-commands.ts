/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * System command and permission notification dispatch for inbound messages.
 *
 * Handles control commands (/help, /reset, etc.) via plain-text delivery
 * and permission-error notifications via the streaming card flow.
 */

import type { LarkClient } from '../../core/lark-client';
import { extractLarkApiCode } from '../../core/api-error';
import { larkLogger } from '../../core/lark-logger';
import { ticketElapsed } from '../../core/lark-ticket';
import { createFeishuReplyDispatcher } from '../../card/reply-dispatcher';
import { startToolUseTraceRun } from '../../card/tool-use-trace-store';
import { sendMessageFeishu } from '../outbound/send';
import type { PermissionError } from './permission';
import type { DispatchContext } from './dispatch-context';
import { buildInboundPayload } from './dispatch-builders';

const log = larkLogger('inbound/dispatch-commands');
const MESSAGE_AUDIT_FAILED_CODE = 230028;

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

  startToolUseTraceRun(dc.threadSessionKey ?? dc.route.sessionKey);

  const {
    dispatcher: permDispatcher,
    replyOptions: permReplyOptions,
    markDispatchIdle: markPermIdle,
    markFullyComplete: markPermComplete,
  } = createFeishuReplyDispatcher({
    cfg: dc.accountScopedCfg,
    agentId: dc.route.agentId,
    chatId: dc.ctx.chatId,
    sessionKey: dc.threadSessionKey ?? dc.route.sessionKey,
    replyToMessageId: replyToMessageId ?? dc.ctx.messageId,
    accountId: dc.account.accountId,
    chatType: dc.ctx.chatType,
    replyInThread: dc.isThread,
    toolUseDisplay: {
      mode: 'off',
      showToolUse: false,
      showToolResultDetails: false,
      showFullPaths: false,
    },
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
 */
export async function dispatchSystemCommand(
  dc: DispatchContext,
  ctxPayload: ReturnType<typeof LarkClient.runtime.channel.reply.finalizeInboundContext>,
  replyToMessageId?: string,
): Promise<void> {
  let delivered = false;
  const suppressToolDetails = isLifecycleSessionCommand(dc.ctx.content);

  dc.log(`feishu[${dc.account.accountId}]: detected system command, using plain-text dispatch`);
  log.info('system command detected, plain-text dispatch');

  await dc.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: dc.accountScopedCfg,
    dispatcherOptions: {
      deliver: async (payload, info) => {
        if (suppressToolDetails && info.kind === 'tool') {
          return;
        }

        const text = payload.text?.trim() ?? '';
        if (!text) return;

        const sendText = (outboundText: string) =>
          sendMessageFeishu({
            cfg: dc.accountScopedCfg,
            to: dc.ctx.chatId,
            text: outboundText,
            replyToMessageId: replyToMessageId ?? dc.ctx.messageId,
            accountId: dc.account.accountId,
            replyInThread: dc.isThread,
          });

        try {
          await sendText(text);
        } catch (err) {
          const redactedText = redactEmailAddresses(text);
          if (extractLarkApiCode(err) !== MESSAGE_AUDIT_FAILED_CODE || redactedText === text) {
            throw err;
          }

          dc.log(
            `feishu[${dc.account.accountId}]: command reply rejected by message audit; retrying with email addresses redacted`,
          );
          log.warn('command reply rejected by message audit; retrying with email addresses redacted');
          await sendText(redactedText);
        }
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

function isLifecycleSessionCommand(text: string | undefined): boolean {
  if (!text) return false;
  const match = text.trim().match(/^\/([^\s@]+)/);
  if (!match) return false;
  const command = match[1]?.toLowerCase();
  return command === 'new' || command === 'reset';
}

function redactEmailAddresses(text: string): string {
  return text.replace(/\b([A-Z0-9._%+-]+)@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi, '$1 [at] $2');
}
