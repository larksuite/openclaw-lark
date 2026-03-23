/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Pure construction functions for the agent dispatch pipeline.
 *
 * All functions in this module are side-effect-free: they build data
 * structures (message bodies, envelope payloads, inbound context) but
 * never perform I/O, send messages, or mutate external state.
 */

import type { HistoryEntry } from 'openclaw/plugin-sdk/reply-history';
import { buildPendingHistoryContextFromMap } from 'openclaw/plugin-sdk/reply-history';
import type { MessageContext } from '../types';
import type { DispatchContext } from './dispatch-context';
import { LarkClient } from '../../core/lark-client';
import { nonBotMentions } from './mention';
import { threadScopedKey } from '../../channel/chat-queue';

// ---------------------------------------------------------------------------
// Mention annotation
// ---------------------------------------------------------------------------

/**
 * Build a `[System: ...]` mention annotation when the message @-mentions
 * non-bot users.  Returns `undefined` when there are no user mentions.
 *
 * Sender identity / chat metadata are handled by the SDK's own
 * `buildInboundUserContextPrefix` (via SenderId, SenderName, ReplyToBody,
 * InboundHistory, etc.), so we only inject the mention data that the SDK
 * does not natively support.
 */
export function buildMentionAnnotation(ctx: MessageContext): string | undefined {
  const mentions = nonBotMentions(ctx);
  if (mentions.length === 0) return undefined;
  const mentionDetails = mentions.map((t) => `${t.name} (open_id: ${t.openId})`).join(', ');
  return `[System: This message @mentions the following users: ${mentionDetails}. Use these open_ids when performing actions involving these users.]`;
}

// ---------------------------------------------------------------------------
// Message body builders
// ---------------------------------------------------------------------------

/**
 * Pure function: build the annotated message body with optional quote,
 * speaker prefix, and mention annotation (for the envelope Body).
 *
 * Note: message_id and reply_to are now conveyed via system-event tags
 * (msg:om_xxx, reply_to:om_yyy) instead of inline annotations, keeping
 * the body cleaner and avoiding misleading heuristics for non-text
 * message types (merge_forward, interactive cards, etc.).
 */
export function buildMessageBody(ctx: MessageContext, quotedContent?: string): string {
  let messageBody = ctx.content;
  if (quotedContent) {
    messageBody = `[Replying to: "${quotedContent}"]\n\n${ctx.content}`;
  }

  const speaker = ctx.senderName ?? ctx.senderId;
  messageBody = `${speaker}: ${messageBody}`;

  const mentionAnnotation = buildMentionAnnotation(ctx);
  if (mentionAnnotation) {
    messageBody += `\n\n${mentionAnnotation}`;
  }

  return messageBody;
}

/**
 * Build the BodyForAgent value: the clean message content plus an
 * optional mention annotation.
 *
 * SDK >= 2026.2.10 changed the BodyForAgent fallback chain from
 * `BodyForAgent ?? Body` to `BodyForAgent ?? CommandBody ?? RawBody ?? Body`,
 * so annotations embedded only in Body never reach the AI.  Setting
 * BodyForAgent explicitly ensures the mention annotation survives.
 *
 * Sender identity, reply context, and chat history are NOT duplicated
 * here — they are injected by the SDK's `buildInboundUserContextPrefix`
 * via the standard fields (SenderId, SenderName, ReplyToBody,
 * InboundHistory) that we pass in buildInboundPayload.
 *
 * Note: media file paths are substituted into `ctx.content` upstream
 * (handler.ts -> substituteMediaPaths) before this function is called.
 * The SDK's `detectAndLoadPromptImages` will discover image paths from
 * the text and inject them as multimodal content blocks.
 */
export function buildBodyForAgent(ctx: MessageContext): string {
  const mentionAnnotation = buildMentionAnnotation(ctx);
  if (mentionAnnotation) {
    return `${ctx.content}\n\n${mentionAnnotation}`;
  }
  return ctx.content;
}

// ---------------------------------------------------------------------------
// Inbound payload builder
// ---------------------------------------------------------------------------

/**
 * Unified call to `finalizeInboundContext`, eliminating the duplicated
 * field-mapping between permission notification and main message paths.
 */
export function buildInboundPayload(
  dc: DispatchContext,
  opts: {
    body: string;
    bodyForAgent: string;
    rawBody: string;
    commandBody: string;
    originatingTo?: string;
    senderName: string;
    senderId: string;
    messageSid: string;
    wasMentioned: boolean;
    replyToBody?: string;
    inboundHistory?: { sender: string; body: string; timestamp: number }[];
    extraFields?: Record<string, unknown>;
  },
): ReturnType<typeof LarkClient.runtime.channel.reply.finalizeInboundContext> {
  return dc.core.channel.reply.finalizeInboundContext({
    // extraFields first — fixed fields below always take precedence
    ...opts.extraFields,
    Body: opts.body,
    BodyForAgent: opts.bodyForAgent,
    RawBody: opts.rawBody,
    CommandBody: opts.commandBody,
    From: dc.feishuFrom,
    To: dc.feishuTo,
    SessionKey: dc.threadSessionKey ?? dc.route.sessionKey,
    AccountId: dc.route.accountId,
    ChatType: dc.isGroup ? 'group' : 'direct',
    GroupSubject: dc.isGroup ? dc.ctx.chatId : undefined,
    SenderName: opts.senderName,
    SenderId: opts.senderId,
    Provider: 'feishu' as const,
    Surface: 'feishu' as const,
    MessageSid: opts.messageSid,
    ReplyToBody: opts.replyToBody,
    InboundHistory: opts.inboundHistory,
    Timestamp: dc.ctx.createTime ?? Date.now(),
    WasMentioned: opts.wasMentioned,
    CommandAuthorized: dc.commandAuthorized,
    OriginatingChannel: 'feishu' as const,
    OriginatingTo: opts.originatingTo ?? dc.feishuTo,
  });
}

// ---------------------------------------------------------------------------
// Envelope + history builder
// ---------------------------------------------------------------------------

/**
 * Format the agent envelope and prepend group chat history if applicable.
 * Returns the combined body and the history key (undefined for DMs).
 */
export function buildEnvelopeWithHistory(
  dc: DispatchContext,
  messageBody: string,
  chatHistories: Map<string, HistoryEntry[]> | undefined,
  historyLimit: number,
): { combinedBody: string; historyKey: string | undefined } {
  const body = dc.core.channel.reply.formatAgentEnvelope({
    channel: 'Feishu',
    from: dc.envelopeFrom,
    timestamp: new Date(),
    envelope: dc.envelopeOptions,
    body: messageBody,
  });

  let combinedBody = body;
  const historyKey = dc.isGroup ? threadScopedKey(dc.ctx.chatId, dc.isThread ? dc.ctx.threadId : undefined) : undefined;

  if (dc.isGroup && historyKey && chatHistories) {
    combinedBody = buildPendingHistoryContextFromMap({
      historyMap: chatHistories,
      historyKey,
      limit: historyLimit,
      currentMessage: combinedBody,
      formatEntry: (entry) =>
        dc.core.channel.reply.formatAgentEnvelope({
          channel: 'Feishu',
          from: `${dc.ctx.chatId}:${entry.sender}`,
          timestamp: entry.timestamp,
          body: entry.body,
          envelope: dc.envelopeOptions,
        }),
    });
  }

  return { combinedBody, historyKey };
}
