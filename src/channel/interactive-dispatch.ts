/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Feishu interactive dispatch wrapper.
 *
 * This module adapts Feishu `card.action.trigger` events into OpenClaw's
 * standard interactive dispatch pipeline:
 * - Plugins register via `api.registerInteractiveHandler({ channel, namespace, handler })`
 * - Channel forwards via `dispatchPluginInteractiveHandler()`
 *
 * We intentionally do NOT maintain any channel-local global registry here.
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
// NOTE: This is the SDK-standard interactive pipeline.
import { dispatchPluginInteractiveHandler } from 'openclaw/plugin-sdk/plugin-runtime';
import { larkLogger } from '../core/lark-logger';
import { sendCardFeishu, sendMessageFeishu, updateCardFeishu } from '../messaging/outbound/send';

const log = larkLogger('channel/interactive-dispatch');

interface FeishuCardActionTriggerEvent {
  operator?: { open_id?: string };
  open_chat_id?: string;
  open_message_id?: string;
  context?: { open_chat_id?: string; open_message_id?: string };
  action?: { value?: { action?: string } };
}

function extractBasics(data: unknown): {
  action: string;
  senderOpenId?: string;
  openChatId?: string;
  openMessageId?: string;
} | null {
  try {
    const ev = data as FeishuCardActionTriggerEvent;
    const action = ev.action?.value?.action;
    if (!action || typeof action !== 'string') return null;
    const openChatId = ev.open_chat_id ?? ev.context?.open_chat_id;
    const openMessageId = ev.open_message_id ?? ev.context?.open_message_id;
    return {
      action: action.trim(),
      senderOpenId: ev.operator?.open_id,
      openChatId,
      openMessageId,
    };
  } catch {
    return null;
  }
}

export type FeishuInteractiveHandlerResponse = unknown;

export interface FeishuInteractiveHandlerContext {
  channel: 'feishu';
  accountId: string;
  senderId?: string;
  conversationId?: string;
  messageId?: string;
  namespace: string;
  payload: string;
  action: string;
  rawEvent: unknown;
  respond: {
    reply: (args: { text: string }) => Promise<void>;
    followUp: (args: { text: string }) => Promise<void>;
    /**
     * Best-effort "edit current message" mapping.
     * In Feishu, we prefer updating the original interactive card when possible.
     */
    editMessage: (args: { text?: string; blocks?: unknown[] }) => Promise<void>;
  };
}

function buildMarkdownCard(text: string): Record<string, unknown> {
  return {
    schema: '2.0',
    body: {
      elements: [
        {
          tag: 'markdown',
          content: text,
        },
      ],
    },
  };
}

/**
 * Dispatch a Feishu interactive card action to business plugins through
 * the OpenClaw SDK's standard interactive dispatch pipeline.
 *
 * Returns `undefined` when:
 * - the event does not look like an interactive action we can route, or
 * - no plugin handler is registered for the derived namespace.
 *
 * @param params.cfg - OpenClaw config snapshot.
 * @param params.accountId - Current Feishu account id.
 * @param params.data - Raw `card.action.trigger` event payload.
 */
export async function dispatchFeishuPluginInteractiveHandler(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  data: unknown;
}): Promise<unknown | undefined> {
  const basics = extractBasics(params.data);
  if (!basics) return undefined;
  if (!basics.action) return undefined;

  const respond: FeishuInteractiveHandlerContext['respond'] = {
    reply: async (args: { text: string }) => {
      if (!basics.openChatId || !String(args?.text || '').trim()) return;
      await sendMessageFeishu({
        cfg: params.cfg,
        to: basics.openChatId,
        text: String(args?.text || ''),
        replyToMessageId: basics.openMessageId,
        accountId: params.accountId,
        replyInThread: false,
      });
    },
    followUp: async (args: { text: string }) => {
      if (!basics.openChatId || !String(args?.text || '').trim()) return;
      await sendMessageFeishu({
        cfg: params.cfg,
        to: basics.openChatId,
        text: String(args?.text || ''),
        replyToMessageId: basics.openMessageId,
        accountId: params.accountId,
        replyInThread: false,
      });
    },
    editMessage: async (args: { text?: string; blocks?: unknown[] }) => {
      if (!basics.openMessageId) {
        if (Array.isArray(args?.blocks) && args.blocks.length && basics.openChatId) {
          await sendCardFeishu({
            cfg: params.cfg,
            to: basics.openChatId,
            card: { schema: '2.0', body: { elements: args.blocks as Record<string, unknown>[] } },
            replyToMessageId: basics.openMessageId,
            accountId: params.accountId,
            replyInThread: false,
          });
          return;
        }
        if (typeof args?.text === 'string' && args.text.trim() && basics.openChatId) {
          await sendMessageFeishu({
            cfg: params.cfg,
            to: basics.openChatId,
            text: args.text,
            replyToMessageId: basics.openMessageId,
            accountId: params.accountId,
            replyInThread: false,
          });
        }
        return;
      }
      if (Array.isArray(args?.blocks) && args.blocks.length) {
        await updateCardFeishu({
          cfg: params.cfg,
          messageId: basics.openMessageId,
          card: { schema: '2.0', body: { elements: args.blocks as Record<string, unknown>[] } },
          accountId: params.accountId,
        });
        return;
      }
      if (typeof args?.text === 'string' && args.text.trim()) {
        await updateCardFeishu({
          cfg: params.cfg,
          messageId: basics.openMessageId,
          card: buildMarkdownCard(args.text),
          accountId: params.accountId,
        });
        return;
      }
      await updateCardFeishu({
        cfg: params.cfg,
        messageId: basics.openMessageId,
        card: { schema: '2.0', body: { elements: [] } },
        accountId: params.accountId,
      });
    },
  };

  try {
    const dedupeId = `feishu:${params.accountId}:${basics.openChatId ?? '-'}:${basics.openMessageId ?? '-'}:${
      basics.senderOpenId ?? '-'
    }:${basics.action}`;

    let cardResponse: FeishuInteractiveHandlerResponse | undefined;
    const result = await dispatchPluginInteractiveHandler<{
      channel: 'feishu';
      namespace: string;
      // handler returns unknown so Feishu can synchronously return {toast, card}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: (ctx: FeishuInteractiveHandlerContext) => Promise<any> | any;
    }>({
      channel: 'feishu',
      data: basics.action,
      dedupeId,
      invoke: async (match: {
        registration: { handler: (ctx: FeishuInteractiveHandlerContext) => Promise<unknown> | unknown };
        namespace: string;
        payload: string;
      }) => {
        const { registration, namespace, payload } = match;
        const handlerCtx: FeishuInteractiveHandlerContext = {
          channel: 'feishu',
          accountId: params.accountId,
          senderId: basics.senderOpenId,
          conversationId: basics.openChatId,
          messageId: basics.openMessageId,
          namespace,
          payload,
          action: basics.action,
          rawEvent: params.data,
          respond,
        };
        cardResponse = await registration.handler(handlerCtx);
        // If the handler returns a card response, treat it as handled.
        return { handled: cardResponse !== undefined };
      },
    });

    if (!result.matched) return undefined;
    return cardResponse;
  } catch (err) {
    log.warn(`interactive dispatch failed: ${String(err)}`);
    return {
      toast: {
        type: 'error',
        content: '交互处理失败，请稍后重试',
      },
    };
  }
}
