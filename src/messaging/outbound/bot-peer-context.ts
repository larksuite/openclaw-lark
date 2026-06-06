/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * AsyncLocalStorage-backed channel for telling the outbound adapter that
 * the current dispatch is replying to a bot peer in a group chat.
 *
 * Why ALS instead of an extra adapter parameter: the outbound adapter is
 * channel-agnostic (Slack / Telegram / Feishu share the same shape) and
 * the SDK owns the call site between dispatch and our outbound. Adding a
 * Feishu-specific "peer-is-bot" parameter would pollute that interface.
 * ALS lets the dispatch layer attach context once and have it flow through
 * the SDK's async chain to the outbound adapter without any other layer
 * needing to know.
 *
 * Lifetime: scoped to a single `runWithBotPeerContext(...)` call. When that
 * promise settles, the store is gone. No manual cleanup required.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface BotPeerContext {
  /** The peer bot's open_id — what `ensureMention` will inject. */
  peerOpenId: string;
  /** Display name for the rendered `<at>` element. */
  peerName: string;
  /**
   * Mutable de-dup flag: set once the peer @ has appeared on an outbound
   * chunk (model-written or injected) so multi-chunk replies don't prepend
   * the @ to every chunk. Scoped to the single dispatch via the store.
   */
  mentioned?: boolean;
}

const storage = new AsyncLocalStorage<BotPeerContext>();

/**
 * Run `fn` with the given bot-peer context attached to the async chain.
 * The outbound adapter's `currentBotPeerContext()` inside `fn` (and any
 * promises it spawns) will see this store.
 */
export function runWithBotPeerContext<T>(
  ctx: BotPeerContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(ctx, fn);
}

/**
 * Read the active bot-peer context, or `undefined` if none is set.
 * Outbound code uses this to decide whether to wrap the reply text with
 * `ensureMention` so the peer bot actually receives a Feishu notification.
 */
export function currentBotPeerContext(): BotPeerContext | undefined {
  return storage.getStore();
}
