/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * CardKit streaming APIs for Lark/Feishu.
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import type { FeishuSendResult } from '../messaging/types';
import { LarkClient } from '../core/lark-client';
import { larkLogger } from '../core/lark-logger';
import { normalizeFeishuTarget, normalizeMessageId, resolveReceiveIdType } from '../core/targets';
import { runWithMessageUnavailableGuard } from '../core/message-unavailable';

const log = larkLogger('card/cardkit');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * 飞书 CardKit SDK 响应的通用结构。
 * SDK 的 TypeScript 类型定义不包含 code/msg 字段，但运行时实际返回。
 * 使用此接口代替 `as any` 以获得类型安全的字段访问。
 */
interface CardKitResponse {
  code?: number;
  msg?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * 记录 CardKit API 响应日志，检测错误码并抛出异常。
 *
 * 默认 fail-fast：body-level 非零 code 视为业务错误，立即抛出，
 * 由调用方（streaming-card-controller 等）统一走 catch → guard 处理。
 */
function logCardKitResponse(params: { resp: CardKitResponse; api: string; context: string }): void {
  const { resp, api, context } = params;
  const { code, msg } = resp;
  log.info(`cardkit ${api} response`, { code, msg, context });
  if (code && code !== 0) {
    log.warn(`cardkit ${api} FAILED`, { code, msg, context, fullResponse: resp });
    throw new Error(`cardkit ${api} FAILED: code=${code}, msg=${msg ?? ''}, ${context}`);
  }
}

// ---------------------------------------------------------------------------
// CardKit streaming APIs
// ---------------------------------------------------------------------------

/**
 * Create a card entity via the CardKit API.
 *
 * Returns the card_id directly, bypassing the idConvert step.
 * The card can then be sent via IM API and streamed via CardKit.
 */
export async function createCardEntity(params: {
  cfg: ClawdbotConfig;
  card: Record<string, unknown>;
  accountId?: string;
}): Promise<string | null> {
  const { cfg, card, accountId } = params;

  const client = LarkClient.fromCfg(cfg, accountId).sdk;

  // SDK 返回类型不完整，运行时包含 code/msg/data 字段
  const response = (await client.cardkit.v1.card.create({
    data: {
      type: 'card_json',
      data: JSON.stringify(card),
    },
  })) as CardKitResponse;

  // 兼容不同 SDK 包装层：优先 data.card_id，回退顶层 card_id
  const cardId =
    ((response.data?.card_id ?? (response as Record<string, unknown>).card_id) as string | undefined) ?? null;
  logCardKitResponse({ resp: response, api: 'card.create', context: `cardId=${cardId}` });
  return cardId;
}

/**
 * Stream text content to a specific card element using the CardKit API.
 *
 * The card automatically diffs the new content against the previous
 * content and renders incremental changes with a typewriter animation.
 *
 * @param params.cardId    - CardKit card ID (from `convertMessageToCardId`).
 * @param params.elementId - The element ID to update (e.g. `STREAMING_ELEMENT_ID`).
 * @param params.content   - The full cumulative text (not a delta).
 * @param params.sequence  - Monotonically increasing sequence number.
 */
export async function streamCardContent(params: {
  cfg: ClawdbotConfig;
  cardId: string;
  elementId: string;
  content: string;
  sequence: number;
  accountId?: string;
}): Promise<void> {
  const { cfg, cardId, elementId, content, sequence, accountId } = params;

  const client = LarkClient.fromCfg(cfg, accountId).sdk;

  // SDK 返回类型不完整，运行时包含 code/msg 字段
  const resp = (await client.cardkit.v1.cardElement.content({
    data: { content, sequence },
    path: { card_id: cardId, element_id: elementId },
  })) as CardKitResponse;
  logCardKitResponse({
    resp,
    api: 'cardElement.content',
    context: `seq=${sequence}, contentLen=${content.length}`,
  });
}

/**
 * Fully replace a card using the CardKit API.
 *
 * Used for the final "complete" state update (with action buttons, green
 * header, etc.) after streaming finishes.
 *
 * @param params.cardId   - CardKit card ID.
 * @param params.card     - The new card JSON content.
 * @param params.sequence - Monotonically increasing sequence number.
 */
export async function updateCardKitCard(params: {
  cfg: ClawdbotConfig;
  cardId: string;
  card: Record<string, unknown>;
  sequence: number;
  accountId?: string;
}): Promise<void> {
  const { cfg, cardId, card, sequence, accountId } = params;

  const client = LarkClient.fromCfg(cfg, accountId).sdk;

  // SDK 返回类型不完整，运行时包含 code/msg 字段
  const resp = (await client.cardkit.v1.card.update({
    data: {
      card: { type: 'card_json', data: JSON.stringify(card) },
      sequence,
    },
    path: { card_id: cardId },
  })) as CardKitResponse;
  logCardKitResponse({
    resp,
    api: 'card.update',
    context: `seq=${sequence}, cardId=${cardId}`,
  });
}

export async function updateCardKitCardForAuth(params: {
  cfg: ClawdbotConfig;
  cardId: string;
  card: Record<string, unknown>;
  sequence: number;
  accountId?: string;
}): Promise<void> {
  return updateCardKitCard(params);
}

/**
 * Send an interactive card message by referencing a CardKit card_id.
 *
 * The content format is: {"type":"card","data":{"card_id":"xxx"}}
 * This links the IM message to the CardKit card entity, enabling
 * streaming updates via cardElement.content().
 */
export async function sendCardByCardId(params: {
  cfg: ClawdbotConfig;
  to: string;
  cardId: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  accountId?: string;
}): Promise<FeishuSendResult> {
  const { cfg, to, cardId, replyToMessageId, replyInThread, accountId } = params;

  const client = LarkClient.fromCfg(cfg, accountId).sdk;

  const contentPayload = JSON.stringify({
    type: 'card',
    data: { card_id: cardId },
  });

  if (replyToMessageId) {
    // 规范化 message_id，处理合成 ID（如 "om_xxx:auth-complete"）
    const normalizedId = normalizeMessageId(replyToMessageId);
    const response = await runWithMessageUnavailableGuard({
      messageId: normalizedId,
      operation: 'im.message.reply(interactive.cardkit)',
      fn: () =>
        client.im.message.reply({
          path: { message_id: normalizedId! },
          data: { content: contentPayload, msg_type: 'interactive', reply_in_thread: replyInThread },
        }),
    });
    return {
      messageId: response?.data?.message_id ?? '',
      chatId: response?.data?.chat_id ?? '',
    };
  }

  const target = normalizeFeishuTarget(to);
  if (!target) {
    throw new Error(`[feishu-send] Invalid target: "${to}"`);
  }
  const receiveIdType = resolveReceiveIdType(target);

  const response = await client.im.message.create({
    // SDK 类型将 receive_id_type 限定为字面量联合，但运行时接受动态值
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params: { receive_id_type: receiveIdType as any },
    data: {
      receive_id: target,
      msg_type: 'interactive',
      content: contentPayload,
    },
  });

  return {
    messageId: response?.data?.message_id ?? '',
    chatId: response?.data?.chat_id ?? '',
  };
}

/**
 * Close (or open) the streaming mode on a CardKit card.
 *
 * Must be called after streaming is complete to restore normal card
 * behaviour (forwarding, interaction callbacks, etc.).
 */
export async function setCardStreamingMode(params: {
  cfg: ClawdbotConfig;
  cardId: string;
  streamingMode: boolean;
  sequence: number;
  accountId?: string;
}): Promise<void> {
  const { cfg, cardId, streamingMode, sequence, accountId } = params;

  const client = LarkClient.fromCfg(cfg, accountId).sdk;

  // SDK 返回类型不完整，运行时包含 code/msg 字段
  const resp = (await client.cardkit.v1.card.settings({
    data: {
      settings: JSON.stringify({ streaming_mode: streamingMode }),
      sequence,
    },
    path: { card_id: cardId },
  })) as CardKitResponse;
  logCardKitResponse({
    resp,
    api: 'card.settings',
    context: `seq=${sequence}, streaming_mode=${streamingMode}`,
  });
}
