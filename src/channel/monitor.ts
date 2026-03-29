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

import { createConnectedChannelStatusPatch } from 'openclaw/plugin-sdk/gateway-runtime';
import type { ClawdbotConfig, RuntimeEnv } from 'openclaw/plugin-sdk';
import type { HistoryEntry } from 'openclaw/plugin-sdk/reply-history';
import { getEnabledLarkAccounts, getLarkAccount } from '../core/accounts';
import { LarkClient } from '../core/lark-client';
import { MessageDedup } from '../messaging/inbound/dedup';
import { larkLogger } from '../core/lark-logger';
import { drainShutdownHooks } from '../core/shutdown-hooks';
import { bindFeishuStatusSink } from './status-registry';
import type { FeishuRuntimeState, FeishuStatusPatch, MonitorContext, MonitorFeishuOpts } from './types';
import {
  handleBotMembershipEvent,
  handleCardActionEvent,
  handleMessageEvent,
  handleReactionEvent,
} from './event-handlers';

const mlog = larkLogger('channel/monitor');

// Re-export type for backward compatibility
export type { MonitorFeishuOpts } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_INITIAL_RESTART_BACKOFF_MS = 3_000;
const DEFAULT_MAX_RESTART_BACKOFF_MS = 60_000;

function resolveHealthMonitorConfig(account: ReturnType<typeof getLarkAccount>): {
  startupTimeoutMs: number;
  initialRestartBackoffMs: number;
  maxRestartBackoffMs: number;
} {
  const cfg = account.config?.healthMonitor ?? {};
  const initialRestartBackoffMs = Math.max(1_000, cfg.initialRestartBackoffMs ?? DEFAULT_INITIAL_RESTART_BACKOFF_MS);

  return {
    startupTimeoutMs: Math.max(1_000, cfg.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS),
    initialRestartBackoffMs,
    maxRestartBackoffMs: Math.max(initialRestartBackoffMs, cfg.maxRestartBackoffMs ?? DEFAULT_MAX_RESTART_BACKOFF_MS),
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer === 'object' && typeof timer.unref === 'function') {
      timer.unref();
    }

    if (!signal) {
      return;
    }

    if (signal.aborted) {
      clearTimeout(timer);
      resolve();
      return;
    }

    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

function relayAbort(parent: AbortSignal | undefined, child: AbortController): () => void {
  if (!parent) {
    return () => {};
  }

  if (parent.aborted) {
    child.abort();
    return () => {};
  }

  const abort = () => child.abort();
  parent.addEventListener('abort', abort, { once: true });
  return () => parent.removeEventListener('abort', abort);
}

function withState(state: FeishuRuntimeState, patch: FeishuStatusPatch = {}): FeishuStatusPatch {
  return {
    ...patch,
    state,
    healthState: state,
  };
}

function buildHandlers(ctx: MonitorContext): Record<string, (data: unknown) => Promise<void>> {
  return {
    'im.message.receive_v1': (data) => handleMessageEvent(ctx, data),
    'im.message.message_read_v1': async () => {},
    'im.message.reaction.created_v1': (data) => handleReactionEvent(ctx, data),
    // These events are expected in normal usage but do not affect the
    // plugin's current behavior. Register no-op handlers to avoid SDK
    // warnings about missing handlers.
    'im.message.reaction.deleted_v1': async () => {},
    'im.chat.access_event.bot_p2p_chat_entered_v1': async () => {},
    'im.chat.member.bot.added_v1': (data) => handleBotMembershipEvent(ctx, data, 'added'),
    'im.chat.member.bot.deleted_v1': (data) => handleBotMembershipEvent(ctx, data, 'removed'),
    // 飞书 SDK EventDispatcher.register 不支持带返回值的处理器，此处 as any 是 SDK 类型限制的变通
    'card.action.trigger': ((data: unknown) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handleCardActionEvent(ctx, data)) as any,
  };
}

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
async function monitorSingleAccount(params: {
  cfg: ClawdbotConfig;
  account: ReturnType<typeof getLarkAccount>;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  setStatus?: (patch: FeishuStatusPatch) => void;
}): Promise<void> {
  const { account, runtime, abortSignal, setStatus } = params;
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
  const healthCfg = resolveHealthMonitorConfig(account);
  const statusSink = (patch: FeishuStatusPatch): void => {
    setStatus?.(patch);
  };
  const unbindStatus = bindFeishuStatusSink(accountId, statusSink);
  log(
    `feishu[${accountId}]: message dedup enabled (ttl=${messageDedup['ttlMs']}ms, max=${messageDedup['maxEntries']})`,
  );

  log(`feishu[${accountId}]: starting WebSocket connection...`);

  // Create LarkClient instance — manages SDK client, WS, and bot identity.
  const lark = LarkClient.fromAccount(account);

  // Attach dedup instance so it is disposed together with the client.
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

  const handlers = buildHandlers(ctx);
  let backoffMs = healthCfg.initialRestartBackoffMs;
  let attemptSeq = 0;
  let consecutiveFailures = 0;

  statusSink(withState('starting', { connected: false, reconnectAttempts: 0 }));

  try {
    while (!abortSignal?.aborted) {
      const sessionAbort = new AbortController();
      const detachAbort = relayAbort(abortSignal, sessionAbort);
      let currentAttemptId = 0;
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      let watchdogAttemptId = 0;
      let watchdogTriggered = false;
      let everReady = false;

      const clearWatchdog = (): void => {
        if (watchdog) {
          clearTimeout(watchdog);
          watchdog = null;
        }
      };

      const armWatchdog = (attemptId: number): void => {
        watchdogAttemptId = attemptId;
        if (!everReady && watchdog) {
          return;
        }
        clearWatchdog();
        watchdog = setTimeout(() => {
          if (sessionAbort.signal.aborted) {
            return;
          }

          watchdogTriggered = true;
          consecutiveFailures += 1;
          const now = Date.now();
          const reason = 'startup_timeout';
          statusSink(
            withState('failed', {
              attemptId: watchdogAttemptId,
              connected: false,
              lastError: reason,
              lastErrorAt: now,
              lastErrorReason: reason,
              lastRestartReason: reason,
              lastDisconnect: { at: now, error: reason },
              consecutiveFailures,
              reconnectAttempts: consecutiveFailures,
            }),
          );
          error(
            `feishu[${accountId}][attempt=${watchdogAttemptId}]: startup_timeout after ${healthCfg.startupTimeoutMs}ms`,
          );
          lark.disconnect();
          sessionAbort.abort();
        }, healthCfg.startupTimeoutMs);

        if (typeof watchdog === 'object' && typeof watchdog.unref === 'function') {
          watchdog.unref();
        }
      };

      try {
        await lark.startWS({
          handlers,
          abortSignal: sessionAbort.signal,
          lifecycle: {
            onConnectAttempt: () => {
              currentAttemptId = ++attemptSeq;
              const now = Date.now();
              armWatchdog(currentAttemptId);
              statusSink(
                withState(everReady ? 'restarting' : 'connecting', {
                  attemptId: currentAttemptId,
                  connected: false,
                  lastConnectStartAt: now,
                  reconnectAttempts: consecutiveFailures,
                }),
              );
              log(`feishu[${accountId}][attempt=${currentAttemptId}]: connect_start`);
            },
            onReady: () => {
              clearWatchdog();
              everReady = true;
              consecutiveFailures = 0;
              backoffMs = healthCfg.initialRestartBackoffMs;
              const now = Date.now();
              statusSink({
                ...withState('ready', {
                  attemptId: currentAttemptId,
                  lastReadyAt: now,
                  lastError: null,
                  lastErrorReason: null,
                  lastDisconnect: null,
                  consecutiveFailures: 0,
                  reconnectAttempts: 0,
                }),
                ...createConnectedChannelStatusPatch(now),
              });
              log(`feishu[${accountId}][attempt=${currentAttemptId}]: ready`);
              log(`feishu[${accountId}]: bot open_id resolved: ${lark.botOpenId ?? 'unknown'}`);
            },
            onConnectFailure: () => {
              consecutiveFailures += 1;
              const now = Date.now();
              const reason = 'connect_failed';
              statusSink(
                withState('connecting', {
                  attemptId: currentAttemptId || null,
                  connected: false,
                  lastError: reason,
                  lastErrorAt: now,
                  lastErrorReason: reason,
                  consecutiveFailures,
                  reconnectAttempts: consecutiveFailures,
                }),
              );
              error(`feishu[${accountId}][attempt=${currentAttemptId || 'unknown'}]: connect_failed`);
            },
            onClose: () => {
              clearWatchdog();
              if (sessionAbort.signal.aborted || abortSignal?.aborted) {
                return;
              }

              const now = Date.now();
              const reason = everReady ? 'socket_close' : 'connect_closed';
              statusSink(
                withState(everReady ? 'degraded' : 'connecting', {
                  attemptId: currentAttemptId || null,
                  connected: false,
                  lastError: reason,
                  lastErrorAt: now,
                  lastErrorReason: reason,
                  lastDisconnect: { at: now, error: reason },
                  reconnectAttempts: consecutiveFailures,
                }),
              );
              log(`feishu[${accountId}][attempt=${currentAttemptId || 'unknown'}]: socket_close`);
            },
            onError: (err) => {
              if (sessionAbort.signal.aborted || abortSignal?.aborted) {
                return;
              }

              const now = Date.now();
              const reason = everReady ? 'ws_error' : 'connect_error';
              const message = err.message || String(err);
              statusSink(
                withState(everReady ? 'degraded' : 'connecting', {
                  attemptId: currentAttemptId || null,
                  connected: false,
                  lastError: message,
                  lastErrorAt: now,
                  lastErrorReason: reason,
                  lastDisconnect: { at: now, error: message },
                  reconnectAttempts: consecutiveFailures,
                }),
              );
              error(`feishu[${accountId}][attempt=${currentAttemptId || 'unknown'}]: ws_error ${message}`);
            },
          },
        });
      } finally {
        clearWatchdog();
        detachAbort();
      }

      if (abortSignal?.aborted) {
        break;
      }

      if (watchdogTriggered) {
        statusSink(
          withState('restarting', {
            connected: false,
            lastRestartReason: 'startup_timeout',
            reconnectAttempts: consecutiveFailures,
          }),
        );
        log(`feishu[${accountId}]: restart scheduled in ${backoffMs}ms`);
        try {
          await sleep(backoffMs, abortSignal);
        } catch {
          break;
        }
        backoffMs = Math.min(backoffMs * 2, healthCfg.maxRestartBackoffMs);
        continue;
      }

      if (!everReady) {
        consecutiveFailures += 1;
      }

      statusSink(
        withState('restarting', {
          connected: false,
          lastRestartReason: everReady ? 'connection_ended' : 'connect_ended',
          reconnectAttempts: consecutiveFailures,
        }),
      );
      log(`feishu[${accountId}]: connection ended unexpectedly, restarting in ${backoffMs}ms`);
      try {
        await sleep(backoffMs, abortSignal);
      } catch {
        break;
      }
      backoffMs = Math.min(backoffMs * 2, healthCfg.maxRestartBackoffMs);
    }
  } finally {
    unbindStatus();
    statusSink(withState('stopped', { connected: false, reconnectAttempts: consecutiveFailures }));
    mlog.info(`websocket stopped for account ${accountId}`);
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
        setStatus: opts.setStatus,
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
        setStatus: opts.setStatus,
      }),
    ),
  );
  await drainShutdownHooks({ log });
}
