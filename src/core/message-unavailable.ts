/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * 消息不可用（已撤回/已删除）状态管理。
 *
 * 目标：
 * 1) 当命中飞书终止错误码（230011/231003）时，按 message_id 标记不可用；
 * 2) 后续针对该 message_id 的 API 调用直接短路，避免持续报错刷屏。
 */

import { LARK_ERROR, MESSAGE_TERMINAL_CODES } from './auth-errors';
import { extractLarkApiCode } from './api-error';
import { normalizeMessageId } from './targets';

export type TerminalMessageApiCode = typeof LARK_ERROR.MESSAGE_RECALLED | typeof LARK_ERROR.MESSAGE_DELETED;

export interface MessageUnavailableState {
  apiCode: TerminalMessageApiCode;
  markedAtMs: number;
  operation?: string;
}

const UNAVAILABLE_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_CACHE_SIZE_BEFORE_PRUNE = 512;

const unavailableMessageCache = new Map<string, MessageUnavailableState>();

function pruneExpired(nowMs = Date.now()): void {
  for (const [messageId, state] of unavailableMessageCache) {
    if (nowMs - state.markedAtMs > UNAVAILABLE_CACHE_TTL_MS) {
      unavailableMessageCache.delete(messageId);
    }
  }
}

export function isTerminalMessageApiCode(code: unknown): code is TerminalMessageApiCode {
  return typeof code === 'number' && MESSAGE_TERMINAL_CODES.has(code);
}

export function markMessageUnavailable(params: {
  messageId: string;
  apiCode: TerminalMessageApiCode;
  operation?: string;
}): void {
  const normalizedId = normalizeMessageId(params.messageId);
  if (!normalizedId) return;

  if (unavailableMessageCache.size >= MAX_CACHE_SIZE_BEFORE_PRUNE) {
    pruneExpired();
  }

  unavailableMessageCache.set(normalizedId, {
    apiCode: params.apiCode,
    operation: params.operation,
    markedAtMs: Date.now(),
  });
}

export function getMessageUnavailableState(messageId: string | undefined): MessageUnavailableState | undefined {
  const normalizedId = normalizeMessageId(messageId);
  if (!normalizedId) return undefined;

  const state = unavailableMessageCache.get(normalizedId);
  if (!state) return undefined;

  if (Date.now() - state.markedAtMs > UNAVAILABLE_CACHE_TTL_MS) {
    unavailableMessageCache.delete(normalizedId);
    return undefined;
  }

  return state;
}

export function isMessageUnavailable(messageId: string | undefined): boolean {
  return !!getMessageUnavailableState(messageId);
}

export function markMessageUnavailableFromError(params: {
  messageId: string | undefined;
  error: unknown;
  operation?: string;
}): TerminalMessageApiCode | undefined {
  const normalizedId = normalizeMessageId(params.messageId);
  if (!normalizedId) return undefined;

  const code = extractLarkApiCode(params.error);
  if (!isTerminalMessageApiCode(code)) return undefined;

  markMessageUnavailable({
    messageId: normalizedId,
    apiCode: code,
    operation: params.operation,
  });
  return code;
}

export class MessageUnavailableError extends Error {
  readonly messageId: string;
  readonly apiCode: TerminalMessageApiCode;
  readonly operation?: string;

  constructor(params: { messageId: string; apiCode: TerminalMessageApiCode; operation?: string }) {
    const operationText = params.operation ? `, op=${params.operation}` : '';
    super(
      `[feishu-message-unavailable] message ${params.messageId} unavailable (code=${params.apiCode}${operationText})`,
    );
    this.name = 'MessageUnavailableError';
    this.messageId = params.messageId;
    this.apiCode = params.apiCode;
    this.operation = params.operation;
  }
}

export function isMessageUnavailableError(error: unknown): error is MessageUnavailableError {
  return (
    error instanceof MessageUnavailableError ||
    (typeof error === 'object' && error !== null && (error as { name?: string }).name === 'MessageUnavailableError')
  );
}

export function assertMessageAvailable(messageId: string | undefined, operation?: string): void {
  const normalizedId = normalizeMessageId(messageId);
  if (!normalizedId) return;

  const state = getMessageUnavailableState(normalizedId);
  if (!state) return;

  throw new MessageUnavailableError({
    messageId: normalizedId,
    apiCode: state.apiCode,
    operation: operation ?? state.operation,
  });
}

/**
 * 针对 message_id 的统一保护：
 * - 调用前检查是否已标记不可用；
 * - 调用报错后识别 230011/231003 并标记；
 * - 命中时抛出 MessageUnavailableError 供上游快速终止流程。
 */
export async function runWithMessageUnavailableGuard<T>(params: {
  messageId: string | undefined;
  operation: string;
  fn: () => Promise<T>;
}): Promise<T> {
  const normalizedId = normalizeMessageId(params.messageId);
  if (!normalizedId) {
    return params.fn();
  }

  assertMessageAvailable(normalizedId, params.operation);

  try {
    return await params.fn();
  } catch (error) {
    const code = markMessageUnavailableFromError({
      messageId: normalizedId,
      error,
      operation: params.operation,
    });
    if (code) {
      throw new MessageUnavailableError({
        messageId: normalizedId,
        apiCode: code,
        operation: params.operation,
      });
    }
    throw error;
  }
}
