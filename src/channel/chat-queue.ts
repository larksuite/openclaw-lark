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
const queueAliases = new Map<string, string>();

function migrateQueueState(from: string, to: string): void {
  if (from === to) return;

  const queue = chatQueues.get(from);
  if (queue && !chatQueues.has(to)) {
    chatQueues.set(to, queue);
  }
  chatQueues.delete(from);

  const dispatcher = activeDispatchers.get(from);
  if (dispatcher && !activeDispatchers.has(to)) {
    activeDispatchers.set(to, dispatcher);
  }
  activeDispatchers.delete(from);
}

export function addQueueAlias(from: string, to: string): void {
  if (!from || !to || from === to) return;
  queueAliases.set(from, to);
  migrateQueueState(from, resolveQueueKey(to));
}

export function resolveQueueKey(key: string): string {
  let current = key;
  const seen = new Set<string>();
  while (queueAliases.has(current) && !seen.has(current)) {
    seen.add(current);
    current = queueAliases.get(current)!;
  }
  return current;
}

export function registerQueueBridge(params: {
  accountId: string;
  chatId: string;
  pendingThreadKey?: string;
  resolvedThreadId?: string;
}): void {
  const { accountId, chatId, pendingThreadKey, resolvedThreadId } = params;
  if (!pendingThreadKey) return;

  const parentKey = buildQueueKey(accountId, chatId);
  addQueueAlias(parentKey, pendingThreadKey);

  if (!resolvedThreadId) return;

  const realThreadKey = buildQueueKey(accountId, chatId, resolvedThreadId);
  addQueueAlias(pendingThreadKey, realThreadKey);
}

export function resolveThreadQueueKey(params: {
  accountId: string;
  chatId: string;
  inboundThreadId?: string;
  pendingThreadKey?: string;
  resolvedThreadId?: string;
}): string {
  if (params.resolvedThreadId) {
    return resolveQueueKey(buildQueueKey(params.accountId, params.chatId, params.resolvedThreadId));
  }
  if (params.inboundThreadId) {
    return resolveQueueKey(buildQueueKey(params.accountId, params.chatId, params.inboundThreadId));
  }
  if (params.pendingThreadKey) {
    return resolveQueueKey(params.pendingThreadKey);
  }
  return resolveQueueKey(buildQueueKey(params.accountId, params.chatId));
}

export function buildAbortLookupKeys(params: { accountId: string; chatId: string; threadId?: string }): string[] {
  const keys = [buildQueueKey(params.accountId, params.chatId)];
  if (params.threadId) {
    keys.unshift(buildQueueKey(params.accountId, params.chatId, params.threadId));
  }
  return [...new Set(keys.map((key) => resolveQueueKey(key)))];
}

export function findActiveDispatcher(keys: string[]): ActiveDispatcherEntry | undefined {
  for (const key of keys) {
    const active = getActiveDispatcher(key);
    if (active) return active;
  }
  return undefined;
}

export function hasAnyActiveTask(keys: string[]): boolean {
  return keys.some((key) => hasActiveTask(key));
}

export function getQueueAliasesForTest(): Map<string, string> {
  return new Map(queueAliases);
}

export function getQueueStateForTest(): { queueKeys: string[]; activeDispatcherKeys: string[] } {
  return {
    queueKeys: [...chatQueues.keys()],
    activeDispatcherKeys: [...activeDispatchers.keys()],
  };
}

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
  activeDispatchers.set(resolveQueueKey(key), entry);
}

export function unregisterActiveDispatcher(key: string): void {
  activeDispatchers.delete(resolveQueueKey(key));
}

export function getActiveDispatcher(key: string): ActiveDispatcherEntry | undefined {
  return activeDispatchers.get(resolveQueueKey(key));
}

/** Check whether the queue has an active task for the given key. */
export function hasActiveTask(key: string): boolean {
  return chatQueues.has(resolveQueueKey(key));
}

export function enqueueFeishuChatTask(params: {
  accountId: string;
  chatId: string;
  threadId?: string;
  task: () => Promise<void>;
}): { status: QueueStatus; promise: Promise<void> } {
  const { accountId, chatId, threadId, task } = params;
  const key = resolveQueueKey(buildQueueKey(accountId, chatId, threadId));
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
  queueAliases.clear();
}
