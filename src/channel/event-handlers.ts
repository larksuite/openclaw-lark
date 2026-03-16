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

import type {
  FeishuMessageEvent,
  FeishuBotAddedEvent,
  FeishuReactionCreatedEvent,
  FeishuBitableRecordChangedEvent,
} from '../messaging/types';
import { handleFeishuMessage } from '../messaging/inbound/handler';
import { handleFeishuReaction, resolveReactionContext } from '../messaging/inbound/reaction-handler';
import { handleFeishuBitableRecordChanged } from '../messaging/inbound/bitable-handler';
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

export async function handleCardActionEvent(ctx: MonitorContext, data: unknown): Promise<unknown> {
  try {
    return await handleCardAction(data, ctx.cfg, ctx.accountId);
  } catch (err) {
    elog.warn(`card.action.trigger handler error: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Bitable record-changed handler
// ---------------------------------------------------------------------------

/**
 * Handle a `drive.file.bitable_record_changed_v1` event.
 *
 * The SDK's EventDispatcher delivers the inner `event` object directly as
 * handler data, so `data` here maps to the `event` field of the raw
 * webhook body.  The outer v2 envelope `app_id` is injected by the SDK
 * into the data object alongside the inner fields.
 *
 * The handler uses `bitableNotifications` config to resolve which chats
 * should receive the notification, then dispatches a synthetic message
 * to the agent for each matching target.
 */
export async function handleBitableRecordChangedEvent(ctx: MonitorContext, data: unknown): Promise<void> {
  if (!isEventOwnershipValid(ctx, data)) return;
  const { accountId, log, error } = ctx;
  try {
    const event = data as FeishuBitableRecordChangedEvent;

    // Basic sanity check — must have a file_token to be useful
    if (!event.file_token) {
      log(`feishu[${accountId}]: bitable_record_changed missing file_token, skipping`);
      return;
    }

    // Dedup: use a composite key so reconnect-replayed events are suppressed
    const actionCount = event.action_list?.length ?? 0;
    const firstRecordId = event.action_list?.[0]?.record_id ?? '';
    const dedupKey = `bitable:${event.file_token}:${event.table_id}:${event.revision ?? event.update_time ?? Date.now()}:${firstRecordId}:${actionCount}`;
    if (!ctx.messageDedup.tryRecord(dedupKey, accountId)) {
      log(`feishu[${accountId}]: duplicate bitable_record_changed ${dedupKey}, skipping`);
      return;
    }

    log(`feishu[${accountId}]: bitable_record_changed file=${event.file_token} table=${event.table_id} actions=${actionCount}`);

    await handleFeishuBitableRecordChanged({
      cfg: ctx.cfg,
      event,
      runtime: ctx.runtime,
      chatHistories: ctx.chatHistories,
      accountId,
    });
  } catch (err) {
    error(`feishu[${accountId}]: error handling bitable_record_changed: ${String(err)}`);
  }
}
