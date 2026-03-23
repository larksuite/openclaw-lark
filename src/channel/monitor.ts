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

import type { ClawdbotConfig, RuntimeEnv } from 'openclaw/plugin-sdk';
import type { HistoryEntry } from 'openclaw/plugin-sdk/reply-history';
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

  await lark.startWS({
    handlers: {
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
    },
    abortSignal,
  });

  // startWS resolves when abortSignal fires — probe result is logged inside startWS.
  log(`feishu[${accountId}]: bot open_id resolved: ${lark.botOpenId ?? 'unknown'}`);
  log(`feishu[${accountId}]: WebSocket client started`);
  mlog.info(`websocket started for account ${accountId}`);
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
