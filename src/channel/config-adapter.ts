/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Configuration merge helpers for Feishu account management.
 *
 * Centralises the pattern of merging a partial configuration patch
 * into the Feishu section of the top-level ClawdbotConfig, handling
 * both the default account (top-level fields) and named accounts
 * (nested under `accounts`).
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import { DEFAULT_ACCOUNT_ID } from 'openclaw/plugin-sdk/account-id';
import type { FeishuConfig } from '../core/types';
import { getLarkAccount, getLarkAccountIds } from '../core/accounts';
import { collectIsolationWarnings } from '../core/security-check';

/** Generic Feishu account config merge. */
function mergeFeishuAccountConfig(
  cfg: ClawdbotConfig,
  accountId: string,
  patch: Record<string, unknown>,
): ClawdbotConfig {
  const isDefault = !accountId || accountId === DEFAULT_ACCOUNT_ID;
  if (isDefault) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        feishu: { ...cfg.channels?.feishu, ...patch },
      },
    };
  }
  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      feishu: {
        ...feishuCfg,
        accounts: {
          ...feishuCfg?.accounts,
          [accountId]: { ...feishuCfg?.accounts?.[accountId], ...patch },
        },
      },
    },
  };
}

/** Set the `enabled` flag on a Feishu account. */
export function setAccountEnabled(cfg: ClawdbotConfig, accountId: string, enabled: boolean): ClawdbotConfig {
  return mergeFeishuAccountConfig(cfg, accountId, { enabled });
}

/** Apply an arbitrary config patch to a Feishu account. */
export function applyAccountConfig(
  cfg: ClawdbotConfig,
  accountId: string,
  patch: Record<string, unknown>,
): ClawdbotConfig {
  return mergeFeishuAccountConfig(cfg, accountId, patch);
}

/** Delete a Feishu account entry from the config. */
export function deleteAccount(cfg: ClawdbotConfig, accountId: string): ClawdbotConfig {
  const isDefault = !accountId || accountId === DEFAULT_ACCOUNT_ID;

  if (isDefault) {
    // Delete entire feishu config
    const next = { ...cfg } as ClawdbotConfig;
    const nextChannels = { ...cfg.channels };
    delete (nextChannels as Record<string, unknown>).feishu;
    if (Object.keys(nextChannels).length > 0) {
      next.channels = nextChannels;
    } else {
      delete next.channels;
    }
    return next;
  }

  // Delete specific account from accounts
  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
  const accounts = { ...feishuCfg?.accounts };
  delete accounts[accountId];

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      feishu: {
        ...feishuCfg,
        accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
      },
    },
  };
}

/** Collect security warnings for a Feishu account. */
export function collectFeishuSecurityWarnings(params: { cfg: ClawdbotConfig; accountId: string }): string[] {
  const { cfg, accountId } = params;
  const warnings: string[] = [];

  const account = getLarkAccount(cfg, accountId);
  const feishuCfg = account.config;
  // cfg.channels.defaults is a cross-channel defaults object (not formally typed)
  const defaultGroupPolicy = (
    (cfg.channels as Record<string, unknown> | undefined)?.defaults as { groupPolicy?: string } | undefined
  )?.groupPolicy;
  const groupPolicy = feishuCfg?.groupPolicy ?? defaultGroupPolicy ?? 'allowlist';
  if (groupPolicy === 'open') {
    warnings.push(
      `- Feishu[${account.accountId}] groups: groupPolicy="open" allows any group to interact (mention-gated). To restrict which groups are allowed, set groupPolicy="allowlist" and list group IDs in channels.feishu.groups. To restrict which senders can trigger the bot, set channels.feishu.groupAllowFrom with user open_ids (ou_xxx).`,
    );
  }

  // Multi-account cross-tenant isolation check (only on first account to avoid duplicates)
  const allIds = getLarkAccountIds(cfg);
  if (allIds.length === 0 || accountId === allIds[0]) {
    for (const w of collectIsolationWarnings(cfg)) {
      warnings.push(w);
    }
  }

  return warnings;
}
