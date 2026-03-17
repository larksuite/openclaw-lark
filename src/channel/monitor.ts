/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * WebSocket monitoring for the Lark/Feishu channel plugin.
 *
 * Manages per-account WSClient connections and routes inbound Feishu
 * events (messages, bot membership changes, read receipts) to the
 * appropriate handlers.
 */

import type { ClawdbotConfig, RuntimeEnv, HistoryEntry } from 'openclaw/plugin-sdk';
import { getLarkAccount, getEnabledLarkAccounts } from '../core/accounts';
import { LarkClient } from '../core/lark-client';
import { MessageDedup } from '../messaging/inbound/dedup';
import { larkLogger } from '../core/lark-logger';
import { drainShutdownHooks } from '../core/shutdown-hooks';
import type { MonitorFeishuOpts, MonitorContext } from './types';
import {
  handleMessageEvent,
  handleReactionEvent,
  handleBotMembershipEvent,
  handleCardActionEvent,
} from './event-handlers';

const mlog = larkLogger('channel/monitor');

// Re-export type for backward compatibility
export type { MonitorFeishuOpts } from './types';

// ---------------------------------------------------------------------------
// Single-account monitor
// ---------------------------------------------------------------------------

/**
 * Start monitoring a single Feishu account.
 *
 * Creates a LarkClient, probes bot identity, registers event handlers,
 * and starts a WebSocket connection. Returns a Promise that resolves
 * when the abort signal fires (or immediately if already aborted).
 */
// ---------------------------------------------------------------------------
// WS health check constants
// ---------------------------------------------------------------------------

/** How often to check WebSocket liveness (ms). */
const WS_HEALTH_CHECK_INTERVAL_MS = 60_000;

/** Consider a connection stale if no events for this long (ms). */
const WS_STALE_THRESHOLD_MS = 5 * 60_000;

/** Initial delay before restarting a dropped WebSocket (ms). */
const WS_RESTART_INITIAL_DELAY_MS = 5_000;

/** Maximum restart delay after exponential back-off (ms). */
const WS_RESTART_MAX_DELAY_MS = 30_000;

// ---------------------------------------------------------------------------
// Single-account monitor
// ---------------------------------------------------------------------------

/**
 * Start monitoring a single Feishu account.
 *
 * Creates a LarkClient, probes bot identity, registers event handlers,
 * and starts a WebSocket connection.  Automatically restarts the
 * connection when it drops — including silent TCP deaths detected via
 * a periodic health check timer.
 *
 * Returns a Promise that resolves when the outer abort signal fires.
 */
async function monitorSingleAccount(params: {
  cfg: ClawdbotConfig;
  account: ReturnType<typeof getLarkAccount>;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { account, runtime, abortSignal } = params;
  const { accountId } = account;
  const log = runtime?.log ?? ((...args: unknown[]) => mlog.info(args.map(String).join(' ')));
  const error = runtime?.error ?? ((...args: unknown[]) => mlog.error(args.map(String).join(' ')));

  // Only websocket mode is supported in the monitor path.
  const connectionMode = account.config.connectionMode ?? 'websocket';
  if (connectionMode !== 'websocket') {
    log(`feishu[${accountId}]: webhook mode not implemented in monitor`);
    return;
  }

  // Message dedup — filters duplicate deliveries from WebSocket reconnects.
  const dedupCfg = account.config.dedup;
  const messageDedup = new MessageDedup({
    ttlMs: dedupCfg?.ttlMs,
    maxEntries: dedupCfg?.maxEntries,
  });
  log(
    `feishu[${accountId}]: message dedup enabled (ttl=${messageDedup['ttlMs']}ms, max=${messageDedup['maxEntries']})`,
  );

  log(`feishu[${accountId}]: starting WebSocket connection...`);

  // ------------------------------------------------------------------
  // Auto-restart loop — if WS drops, wait a bit and restart.
  // Each iteration gets its own internal AbortController so the health
  // check can trigger a clean restart without killing the account.
  // ------------------------------------------------------------------

  let restartDelay = WS_RESTART_INITIAL_DELAY_MS;

  while (!abortSignal?.aborted) {
    // Create a fresh LarkClient to get a new WSClient each iteration.
    const lark = LarkClient.fromAccount(account);
    lark.messageDedup = messageDedup;

    /** Per-chat history maps (used for group-chat context window). */
    const chatHistories = new Map<string, HistoryEntry[]>();

    const ctx: MonitorContext = {
      get cfg() {
        return LarkClient.runtime.config.loadConfig();
      },
      lark,
      accountId,
      chatHistories,
      messageDedup,
      runtime,
      log,
      error,
    };

    // Internal AbortController — aborted by health check (stale) or outer signal.
    const innerAc = new AbortController();

    // Propagate outer abort to inner controller.
    const onOuterAbort = () => innerAc.abort();
    abortSignal?.addEventListener('abort', onOuterAbort, { once: true });

    // --- Health check timer -------------------------------------------
    const healthCheckTimer = setInterval(() => {
      if (!lark.wsConnected) return; // already disconnected
      const lastEvent = lark.lastEventAt;
      if (lastEvent === 0) return; // no events received yet — skip
      const staleDuration = Date.now() - lastEvent;
      if (staleDuration > WS_STALE_THRESHOLD_MS) {
        log(
          `feishu[${accountId}]: WebSocket appears stale ` +
            `(no events for ${Math.round(staleDuration / 1000)}s), forcing reconnect...`,
        );
        innerAc.abort();
      }
    }, WS_HEALTH_CHECK_INTERVAL_MS);

    try {
      await lark.startWS({
        handlers: {
          'im.message.receive_v1': (data) => handleMessageEvent(ctx, data),
          'im.message.message_read_v1': async () => {},
          'im.message.reaction.created_v1': (data) => handleReactionEvent(ctx, data),
          'im.chat.member.bot.added_v1': (data) => handleBotMembershipEvent(ctx, data, 'added'),
          'im.chat.member.bot.deleted_v1': (data) => handleBotMembershipEvent(ctx, data, 'removed'),
          'card.action.trigger': ((data: unknown) =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            handleCardActionEvent(ctx, data)) as any,
        },
        abortSignal: innerAc.signal,
      });

      // Log bot identity on first successful connection.
      log(`feishu[${accountId}]: bot open_id resolved: ${lark.botOpenId ?? 'unknown'}`);
      log(`feishu[${accountId}]: WebSocket client started`);
      mlog.info(`websocket started for account ${accountId}`);
    } catch (err) {
      error(`feishu[${accountId}]: WebSocket error: ${err}`);
    } finally {
      clearInterval(healthCheckTimer);
      abortSignal?.removeEventListener('abort', onOuterAbort);
    }

    // If the outer signal fired, stop the loop entirely.
    if (abortSignal?.aborted) break;

    // Otherwise, this was a health-check-triggered or unexpected disconnect — restart.
    log(`feishu[${accountId}]: WebSocket disconnected, restarting in ${restartDelay / 1000}s...`);
    await new Promise((resolve) => setTimeout(resolve, restartDelay));
    restartDelay = Math.min(restartDelay * 2, WS_RESTART_MAX_DELAY_MS);

    // Check again after the delay — the outer signal may have fired while waiting.
    if (abortSignal?.aborted) break;

    // Reset delay on the next successful connection (handled at top of loop).
    restartDelay = WS_RESTART_INITIAL_DELAY_MS;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start monitoring for all enabled Feishu accounts (or a single
 * account when `opts.accountId` is specified).
 */
export async function monitorFeishuProvider(opts: MonitorFeishuOpts = {}): Promise<void> {
  const cfg = opts.config;
  if (!cfg) {
    throw new Error('Config is required for Feishu monitor');
  }

  // Store the original global config so plugin commands (doctor, diagnose)
  // can access cross-account information even when running inside an
  // account-scoped config context.
  LarkClient.setGlobalConfig(cfg);

  const log = opts.runtime?.log ?? ((...args: unknown[]) => mlog.info(args.map(String).join(' ')));

  // Single-account mode.
  if (opts.accountId) {
    const account = getLarkAccount(cfg, opts.accountId);
    if (!account.enabled || !account.configured) {
      throw new Error(`Feishu account "${opts.accountId}" not configured or disabled`);
    }
    await monitorSingleAccount({
      cfg,
      account,
      runtime: opts.runtime,
      abortSignal: opts.abortSignal,
    });
    await drainShutdownHooks({ log });
    return;
  }

  // Multi-account mode: start all enabled accounts in parallel.
  const accounts = getEnabledLarkAccounts(cfg);
  if (accounts.length === 0) {
    throw new Error('No enabled Feishu accounts configured');
  }

  log(`feishu: starting ${accounts.length} account(s): ${accounts.map((a) => a.accountId).join(', ')}`);

  await Promise.all(
    accounts.map((account) =>
      monitorSingleAccount({
        cfg,
        account,
        runtime: opts.runtime,
        abortSignal: opts.abortSignal,
      }),
    ),
  );
  await drainShutdownHooks({ log });
}
