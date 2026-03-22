/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * ChannelPlugin interface implementation for the Lark/Feishu channel.
 *
 * This is the top-level entry point that the OpenClaw plugin system uses to
 * discover capabilities, resolve accounts, obtain outbound adapters, and
 * start the inbound event gateway.
 */

import type { ChannelMeta, ChannelPlugin, ChannelThreadingToolContext, ClawdbotConfig } from 'openclaw/plugin-sdk';
import { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE } from 'openclaw/plugin-sdk';
import type { LarkAccount } from '../core/types';
import { getLarkAccount, getLarkAccountIds, getDefaultLarkAccountId } from '../core/accounts';
import {
  listFeishuDirectoryPeers,
  listFeishuDirectoryGroups,
  listFeishuDirectoryPeersLive,
  listFeishuDirectoryGroupsLive,
} from './directory';
import { feishuOnboardingAdapter } from './onboarding';
import { feishuOutbound } from '../messaging/outbound/outbound';
import { feishuMessageActions } from '../messaging/outbound/actions';
import { resolveFeishuGroupToolPolicy } from '../messaging/inbound/policy';
import { LarkClient } from '../core/lark-client';
import { sendMessageFeishu } from '../messaging/outbound/send';
import { normalizeFeishuTarget, looksLikeFeishuId } from '../core/targets';
import { triggerOnboarding } from '../tools/onboarding-auth';
import { setAccountEnabled, applyAccountConfig, deleteAccount, collectFeishuSecurityWarnings } from './config-adapter';
import { larkLogger } from '../core/lark-logger';
import { FEISHU_CONFIG_JSON_SCHEMA } from '../core/config-schema';

const pluginLog = larkLogger('channel/plugin');

/** 状态轮询的探针结果缓存时长（10 分钟）。 */
const PROBE_CACHE_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert nullable SDK params to optional params for directory functions. */
function adaptDirectoryParams(params: {
  cfg: ClawdbotConfig;
  query?: string | null;
  limit?: number | null;
  accountId?: string | null;
}): { cfg: ClawdbotConfig; query?: string; limit?: number; accountId?: string } {
  return {
    cfg: params.cfg,
    query: params.query ?? undefined,
    limit: params.limit ?? undefined,
    accountId: params.accountId ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const meta: ChannelMeta = {
  id: 'feishu',
  label: 'Feishu',
  selectionLabel: 'Lark/Feishu (\u98DE\u4E66)',
  docsPath: '/channels/feishu',
  docsLabel: 'feishu',
  blurb: '\u98DE\u4E66/Lark enterprise messaging.',
  aliases: ['lark'],
  order: 70,
};

// ---------------------------------------------------------------------------
// Channel plugin definition
// ---------------------------------------------------------------------------

export const feishuPlugin: ChannelPlugin<LarkAccount> = {
  id: 'feishu',

  meta: {
    ...meta,
  },

  // -------------------------------------------------------------------------
  // Pairing
  // -------------------------------------------------------------------------

  pairing: {
    idLabel: 'feishuUserId',
    normalizeAllowEntry: (entry) => entry.replace(/^(feishu|user|open_id):/i, ''),
    notifyApproval: async ({ cfg, id }) => {
      const accountId = getDefaultLarkAccountId(cfg);
      pluginLog.info('notifyApproval called', { id, accountId });

      // 1. 发送配对成功消息（保持现有行为）
      await sendMessageFeishu({
        cfg,
        to: id,
        text: PAIRING_APPROVED_MESSAGE,
        accountId,
      });

      // 2. 触发 onboarding
      try {
        await triggerOnboarding({ cfg, userOpenId: id, accountId });
        pluginLog.info('onboarding completed', { id });
      } catch (err) {
        pluginLog.warn('onboarding failed', { id, error: String(err) });
      }
    },
  },

  // -------------------------------------------------------------------------
  // Capabilities
  // -------------------------------------------------------------------------

  capabilities: {
    chatTypes: ['direct', 'group'],
    media: true,
    reactions: true,
    threads: true,
    polls: false,
    nativeCommands: true,
    blockStreaming: true,
  },

  // -------------------------------------------------------------------------
  // Agent prompt
  // -------------------------------------------------------------------------

  agentPrompt: {
    messageToolHints: () => [
      '- Feishu targeting: omit `target` to reply to the current conversation (auto-inferred). Explicit targets: `user:open_id` or `chat:chat_id`.',
      '- Feishu supports interactive cards for rich messages.',
      '- Feishu reactions use UPPERCASE emoji type names (e.g. `OK`,`THUMBSUP`,`THANKS`,`MUSCLE`,`FINGERHEART`,`APPLAUSE`,`FISTBUMP`,`JIAYI`,`DONE`,`SMILE`,`BLUSH` ), not Unicode emoji characters.',
      "- Feishu `action=delete`/`action=unsend` only deletes messages sent by the bot. When the user quotes a message and says 'delete this', use the **quoted message's** message_id, not the user's own message_id.",
    ],
  },

  // -------------------------------------------------------------------------
  // Groups
  // -------------------------------------------------------------------------

  groups: {
    resolveToolPolicy: resolveFeishuGroupToolPolicy,
  },

  // -------------------------------------------------------------------------
  // Reload
  // -------------------------------------------------------------------------

  reload: { configPrefixes: ['channels.feishu'] },

  // -------------------------------------------------------------------------
  // Config schema (JSON Schema)
  // -------------------------------------------------------------------------

  configSchema: {
    schema: FEISHU_CONFIG_JSON_SCHEMA,
  },

  // -------------------------------------------------------------------------
  // Config adapter
  // -------------------------------------------------------------------------

  config: {
    listAccountIds: (cfg) => getLarkAccountIds(cfg),
    resolveAccount: (cfg, accountId) => getLarkAccount(cfg, accountId),
    defaultAccountId: (cfg) => getDefaultLarkAccountId(cfg),

    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      return setAccountEnabled(cfg, accountId, enabled);
    },

    deleteAccount: ({ cfg, accountId }) => {
      return deleteAccount(cfg, accountId);
    },

    isConfigured: (account) => account.configured,

    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      name: account.name,
      appId: account.appId,
      brand: account.brand,
    }),

    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = getLarkAccount(cfg, accountId);
      return (account.config?.allowFrom ?? []).map((entry) => String(entry));
    },

    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },

  // -------------------------------------------------------------------------
  // Security
  // -------------------------------------------------------------------------

  security: {
    collectWarnings: ({ cfg, accountId }) =>
      collectFeishuSecurityWarnings({ cfg, accountId: accountId ?? DEFAULT_ACCOUNT_ID }),
  },

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  setup: {
    resolveAccountId: () => DEFAULT_ACCOUNT_ID,
    applyAccountConfig: ({ cfg, accountId }) => {
      return applyAccountConfig(cfg, accountId, { enabled: true });
    },
  },

  // -------------------------------------------------------------------------
  // Onboarding
  // -------------------------------------------------------------------------

  onboarding: feishuOnboardingAdapter,

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  messaging: {
    normalizeTarget: (raw) => normalizeFeishuTarget(raw) ?? undefined,
    targetResolver: {
      looksLikeId: looksLikeFeishuId,
      hint: '<chatId|user:openId|chat:chatId>',
    },
  },

  // -------------------------------------------------------------------------
  // Directory
  // -------------------------------------------------------------------------

  directory: {
    self: async () => null,
    listPeers: async (p) => listFeishuDirectoryPeers(adaptDirectoryParams(p)),
    listGroups: async (p) => listFeishuDirectoryGroups(adaptDirectoryParams(p)),
    listPeersLive: async (p) => listFeishuDirectoryPeersLive(adaptDirectoryParams(p)),
    listGroupsLive: async (p) => listFeishuDirectoryGroupsLive(adaptDirectoryParams(p)),
  },

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  outbound: feishuOutbound,

  // -------------------------------------------------------------------------
  // Threading
  // -------------------------------------------------------------------------

  threading: {
    buildToolContext: ({ context, hasRepliedRef }): ChannelThreadingToolContext => ({
      currentChannelId: normalizeFeishuTarget(context.To ?? '') ?? undefined,
      currentThreadTs: context.MessageThreadId != null ? String(context.MessageThreadId) : undefined,
      currentMessageId: context.CurrentMessageId,
      hasRepliedRef,
    }),
  },

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  actions: feishuMessageActions,

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      port: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      port: snapshot.port ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account }) => {
      return await LarkClient.fromAccount(account).probe({ maxAgeMs: PROBE_CACHE_TTL_MS });
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      name: account.name,
      appId: account.appId,
      brand: account.brand,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      port: runtime?.port ?? null,
      probe,
    }),
  },

  // -------------------------------------------------------------------------
  // Gateway
  // -------------------------------------------------------------------------

  gateway: {
    startAccount: async (ctx) => {
      const { monitorFeishuProvider } = await import('./monitor.js');
      const account = getLarkAccount(ctx.cfg, ctx.accountId);
      const port = account.config?.webhookPort ?? null;
      ctx.setStatus({ accountId: ctx.accountId, port });
      ctx.log?.info(`starting feishu[${ctx.accountId}] (mode: ${account.config?.connectionMode ?? 'websocket'})`);
      return monitorFeishuProvider({
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        accountId: ctx.accountId,
      });
    },

    stopAccount: async (ctx) => {
      ctx.log?.info(`stopping feishu[${ctx.accountId}]`);
      await LarkClient.clearCache(ctx.accountId);
      ctx.log?.info(`stopped feishu[${ctx.accountId}]`);
    },
  },
};
