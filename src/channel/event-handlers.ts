/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Event handlers for the Feishu WebSocket monitor.
 *
 * Extracted from monitor.ts to improve testability and reduce
 * function size. Each handler receives a MonitorContext with all
 * dependencies needed to process the event.
 */

import type { FeishuMessageEvent, FeishuBotAddedEvent, FeishuReactionCreatedEvent } from '../messaging/types';
import { handleFeishuMessage } from '../messaging/inbound/handler';
import { handleFeishuReaction, resolveReactionContext } from '../messaging/inbound/reaction-handler';
import { isMessageExpired } from '../messaging/inbound/dedup';
import { withTicket } from '../core/lark-ticket';
import { larkLogger } from '../core/lark-logger';
import { handleCardAction } from '../tools/auto-auth';
import { enqueueFeishuChatTask, buildQueueKey, hasActiveTask, getActiveDispatcher } from './chat-queue';
import { extractRawTextFromEvent, isLikelyAbortText } from './abort-detect';
import type { MonitorContext } from './types';

const elog = larkLogger('channel/event-handlers');

// ---------------------------------------------------------------------------
// Event ownership validation
// ---------------------------------------------------------------------------

/**
 * Verify that the event's app_id matches the current account.
 *
 * Lark SDK EventDispatcher flattens the v2 envelope header (which
 * contains `app_id`) into the handler `data` object, so `app_id` is
 * available directly on `data`.
 *
 * Returns `false` (discard event) when the app_id does not match.
 */
function isEventOwnershipValid(ctx: MonitorContext, data: unknown): boolean {
  const expectedAppId = ctx.lark.account.appId;
  if (!expectedAppId) return true; // appId not configured — skip check

  const eventAppId = (data as Record<string, unknown>).app_id;
  if (eventAppId == null) return true; // SDK did not provide app_id — defensive skip

  if (eventAppId !== expectedAppId) {
    elog.warn('event app_id mismatch, discarding', {
      accountId: ctx.accountId,
      expected: expectedAppId,
      received: String(eventAppId),
    });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

export async function handleMessageEvent(ctx: MonitorContext, data: unknown): Promise<void> {
  if (!isEventOwnershipValid(ctx, data)) return;
  const { accountId, log, error } = ctx;
  try {
    const event = data as FeishuMessageEvent;
    const msgId = event.message?.message_id ?? 'unknown';
    const chatId = event.message?.chat_id ?? '';
    const threadId = event.message?.thread_id || undefined;

    // Dedup — skip duplicate messages (e.g. from WebSocket reconnects).
    if (!ctx.messageDedup.tryRecord(msgId, accountId)) {
      log(`feishu[${accountId}]: duplicate message ${msgId}, skipping`);
      return;
    }

    // Expiry — discard stale messages from reconnect replay.
    if (isMessageExpired(event.message?.create_time)) {
      log(`feishu[${accountId}]: message ${msgId} expired, discarding`);
      return;
    }

    // ---- Abort fast-path ----
    // If the message looks like an abort trigger and there is an active
    // reply dispatcher for this chat, fire abortCard() immediately
    // (before the message enters the serial queue) so the streaming
    // card is terminated without waiting for the current task.
    const abortText = extractRawTextFromEvent(event);
    if (abortText && isLikelyAbortText(abortText)) {
      const queueKey = buildQueueKey(accountId, chatId, threadId);
      if (hasActiveTask(queueKey)) {
        const active = getActiveDispatcher(queueKey);
        if (active) {
          log(`feishu[${accountId}]: abort fast-path triggered for chat ${chatId} (text="${abortText}")`);
          active.abortController?.abort();
          active.abortCard().catch((err) => {
            error(`feishu[${accountId}]: abort fast-path abortCard failed: ${String(err)}`);
          });
        }
      }
    }

    const { status } = enqueueFeishuChatTask({
      accountId,
      chatId,
      threadId,
      task: async () => {
        try {
          await withTicket(
            {
              messageId: msgId,
              chatId,
              accountId,
              startTime: Date.now(),
              senderOpenId: event.sender?.sender_id?.open_id || '',
              chatType: (event.message?.chat_type as 'p2p' | 'group') || undefined,
              threadId,
            },
            () =>
              handleFeishuMessage({
                cfg: ctx.cfg,
                event,
                botOpenId: ctx.lark.botOpenId,
                runtime: ctx.runtime,
                chatHistories: ctx.chatHistories,
                accountId,
              }),
          );
        } catch (err) {
          error(`feishu[${accountId}]: error handling message: ${String(err)}`);
        }
      },
    });
    log(`feishu[${accountId}]: message ${msgId} in chat ${chatId}${threadId ? ` thread ${threadId}` : ''} — ${status}`);
  } catch (err) {
    error(`feishu[${accountId}]: error handling message: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Reaction handler
// ---------------------------------------------------------------------------

export async function handleReactionEvent(ctx: MonitorContext, data: unknown): Promise<void> {
  if (!isEventOwnershipValid(ctx, data)) return;
  const { accountId, log, error } = ctx;
  try {
    const event = data as FeishuReactionCreatedEvent;
    const msgId = event.message_id ?? 'unknown';

    log(`feishu[${accountId}]: reaction event on message ${msgId}`);

    // ---- Dedup: deterministic key based on message + emoji + operator ----
    const emojiType = event.reaction_type?.emoji_type ?? '';
    const operatorOpenId = event.user_id?.open_id ?? '';
    const dedupKey = `${msgId}:reaction:${emojiType}:${operatorOpenId}`;
    if (!ctx.messageDedup.tryRecord(dedupKey, accountId)) {
      log(`feishu[${accountId}]: duplicate reaction ${dedupKey}, skipping`);
      return;
    }

    // ---- Expiry: discard stale reaction events ----
    if (isMessageExpired(event.action_time)) {
      log(`feishu[${accountId}]: reaction on ${msgId} expired, discarding`);
      return;
    }

    // ---- Pre-resolve real chatId before enqueuing ----
    // The API call (3s timeout) runs outside the queue so it doesn't
    // block the serial chain, and is read-only so ordering is irrelevant.
    const preResolved = await resolveReactionContext({
      cfg: ctx.cfg,
      event,
      botOpenId: ctx.lark.botOpenId,
      runtime: ctx.runtime,
      accountId,
    });
    if (!preResolved) return;

    // ---- Enqueue with the real chatId (matches normal message queue key) ----
    const { status } = enqueueFeishuChatTask({
      accountId,
      chatId: preResolved.chatId,
      threadId: preResolved.threadId,
      task: async () => {
        try {
          await withTicket(
            {
              messageId: msgId,
              chatId: preResolved.chatId,
              accountId,
              startTime: Date.now(),
              senderOpenId: operatorOpenId,
              chatType: preResolved.chatType,
              threadId: preResolved.threadId,
            },
            () =>
              handleFeishuReaction({
                cfg: ctx.cfg,
                event,
                botOpenId: ctx.lark.botOpenId,
                runtime: ctx.runtime,
                chatHistories: ctx.chatHistories,
                accountId,
                preResolved,
              }),
          );
        } catch (err) {
          error(`feishu[${accountId}]: error handling reaction: ${String(err)}`);
        }
      },
    });
    log(`feishu[${accountId}]: reaction on ${msgId} (chatId=${preResolved.chatId}) — ${status}`);
  } catch (err) {
    error(`feishu[${accountId}]: error handling reaction event: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Bot membership handler
// ---------------------------------------------------------------------------

export async function handleBotMembershipEvent(
  ctx: MonitorContext,
  data: unknown,
  action: 'added' | 'removed',
): Promise<void> {
  if (!isEventOwnershipValid(ctx, data)) return;
  const { accountId, log, error } = ctx;
  try {
    const event = data as FeishuBotAddedEvent;
    log(`feishu[${accountId}]: bot ${action} ${action === 'removed' ? 'from' : 'to'} chat ${event.chat_id}`);
  } catch (err) {
    error(`feishu[${accountId}]: error handling bot ${action} event: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Card action handler
// ---------------------------------------------------------------------------

/**
 * Handle a Feishu interactive card action event.
 *
 * First, we try the built-in OAuth handler (`handleCardAction`). This covers
 * cases where the card action is part of the OAuth authorisation flow.
 *
 * If `handleCardAction` returns `undefined` the action is not OAuth-related.
 * In that case we forward it into the standard inbound message pipeline so
 * the agent can handle multi-step card interactions (e.g. a "Confirm / Cancel"
 * button after the agent presents a draft).
 *
 * The card action payload is normalised into a synthetic `FeishuMessageEvent`
 * so that the existing session-isolation, serialisation, and context logic in
 * `handleMessageEvent` can be reused without modification.
 */
export async function handleCardActionEvent(ctx: MonitorContext, data: unknown): Promise<unknown> {
  try {
    const result = await handleCardAction(data, ctx.cfg, ctx.accountId);
    if (result !== undefined) return result;

    // ── Non-OAuth card action: forward to agent via inbound message pipeline ──
    const { accountId, log } = ctx;
    const payload = data as Record<string, unknown>;
    const operator = (payload.operator as Record<string, unknown>) ?? {};
    const openId = (operator.open_id as string) ?? '';
    const action = (payload.action as Record<string, unknown>) ?? {};
    const context = (payload.context as Record<string, unknown>) ?? {};

    const chatId = (payload.open_chat_id as string) || (context.open_chat_id as string) || '';
    const msgId = (payload.open_message_id as string) || (context.open_message_id as string) || '';

    // Merge action.value + action.form_value and tag with action metadata so
    // the agent can identify which button was clicked and what form data was
    // submitted.
    const actionValue: Record<string, unknown> = {
      ...((action.value as Record<string, unknown>) ?? {}),
      ...((action.form_value as Record<string, unknown>) ?? {}),
    };
    if (action.tag) actionValue._action_tag = action.tag;

    log(`feishu[${accountId}]: non-OAuth card action from ${openId} in chat ${chatId}: ${JSON.stringify(actionValue)}`);

    const syntheticEvent: FeishuMessageEvent = {
      sender: {
        sender_id: { open_id: openId },
        sender_type: 'user',
      },
      message: {
        message_id: msgId || `card_action_${Date.now()}`,
        chat_id: chatId,
        chat_type: chatId.startsWith('oc_') ? 'group' : 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: JSON.stringify(actionValue) }),
        // Signal to downstream handlers that this message originated from a
        // card action so they can skip mention checks and format responses
        // as a follow-up card rather than a fresh reply.
        _card_action: true,
      } as FeishuMessageEvent['message'],
    };

    const { status } = enqueueFeishuChatTask({
      accountId,
      chatId,
      threadId: undefined,
      task: async () => {
        try {
          await withTicket(
            {
              messageId: syntheticEvent.message?.message_id ?? '',
              chatId,
              accountId,
              startTime: Date.now(),
              senderOpenId: openId,
              chatType: syntheticEvent.message?.chat_type as 'p2p' | 'group' | undefined,
              threadId: undefined,
            },
            () =>
              handleFeishuMessage({
                cfg: ctx.cfg,
                event: syntheticEvent,
                botOpenId: ctx.lark.botOpenId,
                runtime: ctx.runtime,
                chatHistories: ctx.chatHistories,
                accountId,
              }),
          );
        } catch (err) {
          elog.warn(`feishu[${accountId}]: error handling card action: ${String(err)}`);
        }
      },
    });

    log(`feishu[${accountId}]: card action from ${openId} enqueued for chat ${chatId} — ${status}`);
  } catch (err) {
    elog.warn(`card.action.trigger handler error: ${err}`);
  }
}
