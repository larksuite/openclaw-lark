/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Process-level chat task queue.
 *
 * Although located in channel/, this module is intentionally shared
 * across channel, messaging, tools, and card layers as a process-level
 * singleton. Consumers: monitor.ts, dispatch.ts, oauth.ts, auto-auth.ts.
 *
 * Ensures tasks targeting the same account+chat are executed serially.
 * Used by both websocket inbound messages and synthetic message paths.
 */

type QueueStatus = 'queued' | 'immediate';

export interface ActiveDispatcherEntry {
  abortCard: () => Promise<void>;
  abortController?: AbortController;
}

const chatQueues = new Map<string, Promise<void>>();
const activeDispatchers = new Map<string, ActiveDispatcherEntry>();

/**
 * Append `:thread:{threadId}` suffix when threadId is present.
 * Consistent with the SDK's `:thread:` separator convention.
 */
export function threadScopedKey(base: string, threadId?: string): string {
  return threadId ? `${base}:thread:${threadId}` : base;
}

export function buildQueueKey(accountId: string, chatId: string, threadId?: string): string {
  return threadScopedKey(`${accountId}:${chatId}`, threadId);
}

export function registerActiveDispatcher(key: string, entry: ActiveDispatcherEntry): void {
  activeDispatchers.set(key, entry);
}

export function unregisterActiveDispatcher(key: string): void {
  activeDispatchers.delete(key);
}

export function getActiveDispatcher(key: string): ActiveDispatcherEntry | undefined {
  return activeDispatchers.get(key);
}

/** Check whether the queue has an active task for the given key. */
export function hasActiveTask(key: string): boolean {
  return chatQueues.has(key);
}

export function enqueueFeishuChatTask(params: {
  accountId: string;
  chatId: string;
  threadId?: string;
  task: () => Promise<void>;
}): { status: QueueStatus; promise: Promise<void> } {
  const { accountId, chatId, threadId, task } = params;
  const key = buildQueueKey(accountId, chatId, threadId);
  const prev = chatQueues.get(key) ?? Promise.resolve();
  const status: QueueStatus = chatQueues.has(key) ? 'queued' : 'immediate';
  const next = prev.then(task, task); // continue queue even if previous task failed
  chatQueues.set(key, next);

  const cleanup = (): void => {
    if (chatQueues.get(key) === next) {
      chatQueues.delete(key);
    }
  };

  next.then(cleanup, cleanup);

  return { status, promise: next };
}

/** @internal Test-only: reset all queue and dispatcher state. */
export function _resetChatQueueState(): void {
  chatQueues.clear();
  activeDispatchers.clear();
}
