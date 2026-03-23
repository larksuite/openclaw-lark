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
import type { FeishuConfig } from '../../core/types';
import type { LarkAccount } from '../../core/types';
import { LarkClient } from '../../core/lark-client';
import {
  resolveFeishuGroupConfig,
  resolveFeishuAllowlistMatch,
  isFeishuGroupAllowed,
  splitLegacyGroupAllowFrom,
  resolveGroupSenderPolicyContext,
} from './policy';
import { mentionedBot } from './mention';
import { sendPairingReply } from './gate-effects';

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
  const { ctx, accountFeishuCfg, account, accountScopedCfg, log } = params;
  const isGroup = ctx.chatType === 'group';

  if (isGroup) {
    return checkGroupGate({ ctx, accountFeishuCfg, account, accountScopedCfg, log });
  }

  return checkDmGate({ ctx, accountFeishuCfg, account, accountScopedCfg, log });
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

  // ---- Legacy compat: groupAllowFrom with chat_id entries ----
  // Older Feishu configs used groupAllowFrom with chat_ids (oc_xxx) to
  // control which groups are allowed.  The correct semantic (aligned with
  // Telegram) is sender_ids.  Detect and split so both layers still work.
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

  // ---- Layer 1: Group-level access (SDK) ----
  // The SDK reads `channels.feishu.groups` as an allowlist of group IDs.
  // - No groups configured + groupPolicy "open" → any group passes
  // - groupPolicy "allowlist" (or groups configured) → only listed groups pass
  // - groupPolicy "disabled" → all groups blocked
  const groupAccess = core.channel.groups.resolveGroupPolicy({
    cfg: accountScopedCfg ?? {},
    channel: 'feishu',
    groupId: ctx.chatId,
    accountId: account.accountId,
    groupIdCaseInsensitive: true,
    hasGroupAllowFrom: senderGroupAllowFrom.length > 0,
  });

  // Legacy compat: if SDK rejects the group but the chat_id is in the
  // old-style groupAllowFrom, allow it (backward compatibility).
  // Track whether this group was admitted via legacy path so we can skip
  // sender filtering below (old semantic: chat_id in groupAllowFrom meant
  // "allow this group for any sender").
  let legacyGroupAdmit = false;
  if (!groupAccess.allowed) {
    const chatIdLower = ctx.chatId.toLowerCase();
    const legacyMatch = legacyChatIds.some((id) => String(id).toLowerCase() === chatIdLower);
    if (!legacyMatch) {
      log(`feishu[${account.accountId}]: group ${ctx.chatId} blocked by group-level policy`);
      return { allowed: false, reason: 'group_not_allowed' };
    }
    legacyGroupAdmit = true;
  }

  // ---- Per-group config (Feishu-specific fields) ----
  const groupConfig = resolveFeishuGroupConfig({
    cfg: accountFeishuCfg,
    groupId: ctx.chatId,
  });
  const defaultConfig = accountFeishuCfg?.groups?.['*'];

  // Per-group enabled flag
  const enabled = groupConfig?.enabled ?? defaultConfig?.enabled;
  if (enabled === false) {
    log(`feishu[${account.accountId}]: group ${ctx.chatId} disabled by per-group config`);
    return { allowed: false, reason: 'group_disabled' };
  }

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
