/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Request-level ticket for the Feishu plugin.
 *
 * Uses Node.js AsyncLocalStorage to propagate a ticket (message_id,
 * chat_id, account_id) through the entire async call chain without passing
 * parameters explicitly.  Call {@link withTicket} at the event entry point
 * (monitor.ts) and use {@link getTicket} anywhere downstream.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LarkTicket {
  messageId: string;
  chatId: string;
  accountId: string;
  startTime: number;
  senderOpenId?: string;
  chatType?: 'p2p' | 'group';
  threadId?: string;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const store = new AsyncLocalStorage<LarkTicket>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run `fn` within a ticket context.  All async operations spawned inside
 * `fn` will inherit the context and can access it via {@link getTicket}.
 */
export function withTicket<T>(ticket: LarkTicket, fn: () => T | Promise<T>): T | Promise<T> {
  return store.run(ticket, fn);
}

/** Return the current ticket, or `undefined` if not inside withTicket. */
export function getTicket(): LarkTicket | undefined {
  return store.getStore();
}

/** Milliseconds elapsed since the current ticket was created, or 0. */
export function ticketElapsed(): number {
  const t = store.getStore();
  return t ? Date.now() - t.startTime : 0;
}
