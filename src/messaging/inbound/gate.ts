/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Policy gate for inbound Feishu messages.
 *
 * Determines whether a parsed message should be processed or rejected
 * based on group/DM access policies, sender allowlists, and mention
 * requirements.
 *
 * Group access follows the same two-layer model as Telegram:
 *
 *   Layer 1 – Which GROUPS are allowed (SDK `resolveGroupPolicy`):
 *     - No `groups` configured + `groupPolicy: "open"` → any group passes
 *     - `groupPolicy: "allowlist"` or `groups` configured → acts as allowlist
 *       (explicit group IDs or `"*"` wildcard)
 *     - `groupPolicy: "disabled"` → all groups blocked
 *
 *   Layer 2 – Which SENDERS are allowed within a group:
 *     - Per-group `groupPolicy` overrides global for sender filtering
 *     - `groupAllowFrom` (global) + per-group `allowFrom` are merged
 *     - `"open"` → any sender; `"allowlist"` → check merged list;
 *       `"disabled"` → block all senders
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import type { HistoryEntry } from 'openclaw/plugin-sdk/reply-history';
import type { MessageContext } from '../types';
import type { FeishuConfig, FeishuGroupConfig, LarkAccount  } from '../../core/types';
import { LarkClient } from '../../core/lark-client';
import {
  isFeishuGroupAllowed,
  resolveFeishuAllowlistMatch,
  resolveFeishuGroupConfig,
  resolveGroupSenderPolicyContext,
  splitLegacyGroupAllowFrom,
} from './policy';
import { mentionedBot } from './mention';
import { sendPairingReply } from './gate-effects';

/**
 * Resolve the effective `respondToMentionAll` setting.
 *
 * Precedence: per-group > default ("*") group > global account config > false.
 */
export function resolveRespondToMentionAll(params: {
  groupConfig?: { respondToMentionAll?: boolean };
  defaultConfig?: { respondToMentionAll?: boolean };
  accountFeishuCfg?: { respondToMentionAll?: boolean };
}): boolean {
  return (
    params.groupConfig?.respondToMentionAll ??
    params.defaultConfig?.respondToMentionAll ??
    params.accountFeishuCfg?.respondToMentionAll ??
    false
  );
}

/**
 * Resolve the effective allowBots setting.
 *
 * Precedence: per-group > default ("*") > account > 'mentions'.
 *
 * The `'mentions'` default lets bot-to-bot interaction work out of the box
 * while still requiring an explicit @-mention in groups; DMs treat it as
 * pass-through. Operators can opt into fully-open (`true`) or fully-closed
 * (`false`) explicitly.
 */
export function resolveAllowBots(params: {
  groupConfig?: FeishuGroupConfig;
  defaultConfig?: FeishuGroupConfig;
  accountFeishuCfg?: FeishuConfig;
}): boolean | 'mentions' {
  return (
    params.groupConfig?.allowBots ??
    params.defaultConfig?.allowBots ??
    params.accountFeishuCfg?.allowBots ??
    'mentions'
  );
}

/** Prevent spamming the legacy groupAllowFrom migration warning. */
let legacyGroupAllowFromWarned = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the pairing allowFrom store for the Feishu channel via the SDK runtime.
 */
async function readAllowFromStore(accountId: string): Promise<string[]> {
  const core = LarkClient.runtime;
  return await core.channel.pairing.readAllowFromStore({
    channel: 'feishu',
    accountId,
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GateResult {
  allowed: boolean;
  reason?: string;
  /** When a group message is rejected due to missing bot mention, the
   *  caller should record this entry into the chat history map. */
  historyEntry?: HistoryEntry;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the pairing allowFrom store for the Feishu channel.
 *
 * Exported so that handler.ts can provide it as a closure to the SDK's
 * `resolveSenderCommandAuthorization` helper.
 */
export { readAllowFromStore as readFeishuAllowFromStore };

/**
 * Check whether an inbound message passes all access-control gates.
 *
 * The DM gate is async because it may read from the pairing store
 * and send pairing request messages.
 */
export async function checkMessageGate(params: {
  ctx: MessageContext;
  accountFeishuCfg?: FeishuConfig;
  account: LarkAccount;
  /** account 级别的 ClawdbotConfig（channels.feishu 已替换为 per-account 合并后的配置） */
  accountScopedCfg?: ClawdbotConfig;
  log: (...args: unknown[]) => void;
}): Promise<GateResult> {
  const { ctx } = params;

  if (ctx.senderIsBot) {
    return checkBotSenderGate(params);
  }

  const isGroup = ctx.chatType === 'group';
  if (isGroup) {
    return checkGroupGate(params);
  }
  return checkDmGate(params);
}

// ---------------------------------------------------------------------------
// Internal: shared group access (Layer 1)
// ---------------------------------------------------------------------------

interface FeishuGroupAccess {
  /** Non-null = caller must reject with this gate result. */
  rejected: GateResult | null;
  /** True when admission was granted via the legacy chat-id-in-groupAllowFrom
   *  compat path; downstream sender filtering is skipped in that mode. */
  legacyGroupAdmit: boolean;
  /** sender_ids only (oc_ chat-id entries excluded). */
  senderGroupAllowFrom: string[];
  groupConfig: FeishuGroupConfig | undefined;
  defaultConfig: FeishuGroupConfig | undefined;
}

/**
 * Layer 1 group-level admission check, shared between human and bot sender paths.
 *
 * Computes:
 *  - `groupPolicy` access via SDK (`resolveGroupPolicy`)
 *  - Legacy chat-id-in-`groupAllowFrom` compat
 *  - Per-group `enabled === false` kill switch
 *
 * Returns `rejected` non-null when the caller should reject with that result;
 * otherwise the resolved per-group config is returned for downstream use.
 *
 * Bot senders go through the same Layer 1 as humans — `allowBots` only governs
 * sender-axis admission, not which groups the account responds in.
 */
function resolveFeishuGroupAccess(params: {
  ctx: MessageContext;
  accountFeishuCfg?: FeishuConfig;
  account: LarkAccount;
  accountScopedCfg?: ClawdbotConfig;
  log: (...args: unknown[]) => void;
}): FeishuGroupAccess {
  const { ctx, accountFeishuCfg, account, accountScopedCfg, log } = params;
  const core = LarkClient.runtime;

  // Legacy compat: groupAllowFrom with chat_id entries.
  const rawGroupAllowFrom = accountFeishuCfg?.groupAllowFrom ?? [];
  const { legacyChatIds, senderAllowFrom: senderGroupAllowFrom } = splitLegacyGroupAllowFrom(rawGroupAllowFrom);

  if (legacyChatIds.length > 0 && !legacyGroupAllowFromWarned) {
    legacyGroupAllowFromWarned = true;
    log(
      `feishu[${account.accountId}]: ⚠️  groupAllowFrom contains chat_id entries ` +
        `(${legacyChatIds.join(', ')}). groupAllowFrom is for SENDER filtering ` +
        `(open_ids like ou_xxx). Please move chat_ids to "groups" config instead:\n` +
        `  channels.feishu.groups: {\n` +
        legacyChatIds.map((id) => `    "${id}": {},`).join('\n') +
        `\n  }`,
    );
  }

  const groupConfig = resolveFeishuGroupConfig({ cfg: accountFeishuCfg, groupId: ctx.chatId });
  const defaultConfig = accountFeishuCfg?.groups?.['*'];

  // SDK group-level policy (groupPolicy disabled / allowlist / open).
  const groupAccess = core.channel.groups.resolveGroupPolicy({
    cfg: accountScopedCfg ?? {},
    channel: 'feishu',
    groupId: ctx.chatId,
    accountId: account.accountId,
    groupIdCaseInsensitive: true,
    hasGroupAllowFrom: senderGroupAllowFrom.length > 0,
  });

  let legacyGroupAdmit = false;
  if (!groupAccess.allowed) {
    const chatIdLower = ctx.chatId.toLowerCase();
    const legacyMatch = legacyChatIds.some((id) => String(id).toLowerCase() === chatIdLower);
    if (!legacyMatch) {
      log(`feishu[${account.accountId}]: group ${ctx.chatId} blocked by group-level policy`);
      return {
        rejected: { allowed: false, reason: 'group_not_allowed' },
        legacyGroupAdmit: false,
        senderGroupAllowFrom,
        groupConfig,
        defaultConfig,
      };
    }
    legacyGroupAdmit = true;
  }

  const enabled = groupConfig?.enabled ?? defaultConfig?.enabled;
  if (enabled === false) {
    log(`feishu[${account.accountId}]: group ${ctx.chatId} disabled by per-group config`);
    return {
      rejected: { allowed: false, reason: 'group_disabled' },
      legacyGroupAdmit,
      senderGroupAllowFrom,
      groupConfig,
      defaultConfig,
    };
  }

  return { rejected: null, legacyGroupAdmit, senderGroupAllowFrom, groupConfig, defaultConfig };
}

// ---------------------------------------------------------------------------
// Internal: bot sender gate
// ---------------------------------------------------------------------------

function checkBotSenderGate(params: {
  ctx: MessageContext;
  accountFeishuCfg?: FeishuConfig;
  account: LarkAccount;
  accountScopedCfg?: ClawdbotConfig;
  log: (...args: unknown[]) => void;
}): GateResult {
  const { ctx, accountFeishuCfg, account, log } = params;
  const isGroup = ctx.chatType === 'group';

  // 1. Layer 1 group access — bot senders are subject to the same group-level
  //    admission as humans. `allowBots` is a sender-axis filter, not a group-axis
  //    filter; an account configured to ignore a group must ignore bots there too.
  let groupConfig: FeishuGroupConfig | undefined;
  let defaultConfig: FeishuGroupConfig | undefined;
  if (isGroup) {
    const access = resolveFeishuGroupAccess(params);
    if (access.rejected) return access.rejected;
    groupConfig = access.groupConfig;
    defaultConfig = access.defaultConfig;
  }

  // 2. Resolve allowBots (per-group > default > account > 'mentions')
  const allowBots = resolveAllowBots({ groupConfig, defaultConfig, accountFeishuCfg });

  // 3. allowBots === false → drop
  if (allowBots === false) {
    log(
      `feishu[${account.accountId}]: drop bot sender ${ctx.senderId} in ${ctx.chatId} (allowBots=false)`,
    );
    return { allowed: false, reason: 'bot_sender_disabled' };
  }

  // 4. allowBots === 'mentions' + bot not mentioned → drop (group only;
  //    DMs have no @-mention concept, so mention-mode is a pass-through there).
  if (isGroup && allowBots === 'mentions' && !mentionedBot(ctx)) {
    log(
      `feishu[${account.accountId}]: drop bot sender ${ctx.senderId} in ${ctx.chatId} (allowBots=mentions, not mentioned)`,
    );
    return { allowed: false, reason: 'bot_sender_not_mentioned' };
  }

  // 5. Group requireMention check — redundant with allowBots='mentions' but
  //    necessary for the explicit `allowBots=true + requireMention=true` combo.
  //
  //    NOTE: this intentionally diverges from the human-sender path (checkGroupGate),
  //    which delegates to SDK's resolveRequireMention that defaults to true.
  //    For bot senders, `requireMention` must be explicitly set to true — the
  //    rationale being: if the operator opts into `allowBots=true`, they want
  //    bot traffic through by default. Holding bots to a true-default mention
  //    requirement would silently negate `allowBots=true` in most configs.
  if (isGroup) {
    const requireMention =
      groupConfig?.requireMention ??
      defaultConfig?.requireMention ??
      accountFeishuCfg?.requireMention;
    if (requireMention === true && !mentionedBot(ctx)) {
      log(
        `feishu[${account.accountId}]: drop bot sender ${ctx.senderId} (no_mention)`,
      );
      // Intentionally NO historyEntry — bot messages never enter chat history.
      return { allowed: false, reason: 'no_mention' };
    }
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Internal: group gate
// ---------------------------------------------------------------------------

function checkGroupGate(params: {
  ctx: MessageContext;
  accountFeishuCfg?: FeishuConfig;
  account: LarkAccount;
  accountScopedCfg?: ClawdbotConfig;
  log: (...args: unknown[]) => void;
}): GateResult {
  const { ctx, accountFeishuCfg, account, accountScopedCfg, log } = params;
  const core = LarkClient.runtime;

  // ---- Layer 1: Group-level admission (shared with bot path) ----
  const access = resolveFeishuGroupAccess(params);
  if (access.rejected) return access.rejected;
  const { legacyGroupAdmit, senderGroupAllowFrom, groupConfig, defaultConfig } = access;

  // ---- Layer 2: Sender-level access ----
  // Per-group groupPolicy overrides the global groupPolicy for sender filtering.
  // senderGroupAllowFrom (global, oc_ entries excluded) + per-group allowFrom.
  //
  // Legacy compat: when a group was admitted via old-style chat_id in
  // groupAllowFrom AND there is no explicit per-group sender config,
  // skip sender filtering (old semantic = "group allowed, any sender").
  const hasExplicitSenderConfig =
    senderGroupAllowFrom.length > 0 || (groupConfig?.allowFrom ?? []).length > 0 || groupConfig?.groupPolicy != null;

  if (!(legacyGroupAdmit && !hasExplicitSenderConfig)) {
    const { senderPolicy, senderAllowFrom } = resolveGroupSenderPolicyContext({
      groupConfig,
      defaultConfig,
      accountFeishuCfg,
      senderGroupAllowFrom,
    });

    const senderAllowed = isFeishuGroupAllowed({
      groupPolicy: senderPolicy,
      allowFrom: senderAllowFrom,
      senderId: ctx.senderId,
      senderName: ctx.senderName,
    });

    if (!senderAllowed) {
      log(`feishu[${account.accountId}]: sender ${ctx.senderId} not allowed in group ${ctx.chatId}`);
      return { allowed: false, reason: 'sender_not_allowed' };
    }
  }

  // ---- Mention requirement (SDK) ----
  // SDK precedence: per-group > default ("*") > requireMentionOverride > true
  const requireMention = core.channel.groups.resolveRequireMention({
    cfg: accountScopedCfg ?? {},
    channel: 'feishu',
    groupId: ctx.chatId,
    accountId: account.accountId,
    groupIdCaseInsensitive: true,
    requireMentionOverride: accountFeishuCfg?.requireMention,
  });

  if (requireMention && !mentionedBot(ctx)) {
    // Check if @all mention should bypass the mention requirement
    if (ctx.mentionAll) {
      const respondToAll = resolveRespondToMentionAll({
        groupConfig,
        defaultConfig,
        accountFeishuCfg,
      });
      if (respondToAll) {
        log(
          `feishu[${account.accountId}]: @all mention detected in group ${ctx.chatId}, allowing due to respondToMentionAll`,
        );
        return { allowed: true };
      }
    }

    log(`feishu[${account.accountId}]: message in group ${ctx.chatId} did not mention bot, recording to history`);

    return {
      allowed: false,
      reason: 'no_mention',
      historyEntry: {
        sender: ctx.senderId,
        body: `${ctx.senderName ?? ctx.senderId}: ${ctx.content}`,
        timestamp: ctx.createTime ?? Date.now(),
        messageId: ctx.messageId,
      },
    };
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Internal: DM gate
// ---------------------------------------------------------------------------

async function checkDmGate(params: {
  ctx: MessageContext;
  accountFeishuCfg?: FeishuConfig;
  account: LarkAccount;
  accountScopedCfg?: ClawdbotConfig;
  log: (...args: unknown[]) => void;
}): Promise<GateResult> {
  const { ctx, accountFeishuCfg, account, accountScopedCfg, log } = params;

  const dmPolicy = accountFeishuCfg?.dmPolicy ?? 'pairing';
  const configAllowFrom = accountFeishuCfg?.allowFrom ?? [];

  if (dmPolicy === 'disabled') {
    log(`feishu[${account.accountId}]: DM disabled by policy, rejecting sender ${ctx.senderId}`);
    return { allowed: false, reason: 'dm_disabled' };
  }

  if (dmPolicy === 'open') {
    return { allowed: true };
  }

  if (dmPolicy === 'allowlist') {
    const storeAllowFrom = await readAllowFromStore(account.accountId).catch(() => [] as string[]);
    const combinedAllowFrom = [...configAllowFrom, ...storeAllowFrom];

    const match = resolveFeishuAllowlistMatch({
      allowFrom: combinedAllowFrom,
      senderId: ctx.senderId,
      senderName: ctx.senderName,
    });
    if (!match.allowed) {
      log(`feishu[${account.accountId}]: sender ${ctx.senderId} not in DM allowlist`);
      return { allowed: false, reason: 'dm_not_allowed' };
    }
    return { allowed: true };
  }

  // dmPolicy === "pairing"
  const storeAllowFrom = await readAllowFromStore(account.accountId).catch(() => [] as string[]);
  const combinedAllowFrom = [...configAllowFrom, ...storeAllowFrom];

  const match = resolveFeishuAllowlistMatch({
    allowFrom: combinedAllowFrom,
    senderId: ctx.senderId,
    senderName: ctx.senderName,
  });

  if (match.allowed) {
    return { allowed: true };
  }

  // Sender not yet paired — create a pairing request and notify them
  log(`feishu[${account.accountId}]: sender ${ctx.senderId} not paired, creating pairing request`);
  try {
    await sendPairingReply({
      senderId: ctx.senderId,
      chatId: ctx.chatId,
      accountId: account.accountId,
      accountScopedCfg,
    });
  } catch (err) {
    log(`feishu[${account.accountId}]: failed to create pairing request for ${ctx.senderId}: ${String(err)}`);
  }

  return { allowed: false, reason: 'pairing_pending' };
}
