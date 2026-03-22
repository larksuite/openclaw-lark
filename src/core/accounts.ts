/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Lark multi-account management.
 *
 * Account overrides live under `cfg.channels.feishu.accounts`.
 * Each account may override any top-level Feishu config field;
 * unset fields fall back to the top-level defaults.
 */

import { DEFAULT_ACCOUNT_ID, normalizeAccountId as _sdkNormalizeAccountId } from 'openclaw/plugin-sdk';

const normalizeAccountId: (id: string) => string | undefined =
    typeof _sdkNormalizeAccountId === 'function'
        ? _sdkNormalizeAccountId
        : (id: string) => id?.trim().toLowerCase() || undefined;

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';

import type { FeishuConfig, LarkBrand, LarkAccount, LarkCredentials, ConfiguredLarkAccount } from './types';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extract the `channels.feishu` section from the top-level config. */
function getLarkConfig(cfg: ClawdbotConfig): FeishuConfig | undefined {
  return cfg?.channels?.feishu as FeishuConfig | undefined;
}

/** Return the per-account override map, if present. */
function getAccountMap(section: FeishuConfig): Record<string, Partial<FeishuConfig>> | undefined {
  return (section as FeishuConfig & { accounts?: Record<string, Partial<FeishuConfig>> }).accounts;
}

/** Strip the `accounts` key and return the remaining top-level config. */
function baseConfig(section: FeishuConfig): Omit<FeishuConfig, 'accounts'> {
  const { accounts: _ignored, ...rest } = section as FeishuConfig & {
    accounts?: Record<string, unknown>;
  };
  return rest;
}

/** Merge base config with account override (account fields take precedence). */
function mergeAccountConfig(base: Omit<FeishuConfig, 'accounts'>, override: Partial<FeishuConfig>): FeishuConfig {
  return { ...base, ...override } as FeishuConfig;
}

/** Coerce a domain string to `LarkBrand`, defaulting to `"feishu"`. */
function toBrand(domain: string | undefined): LarkBrand {
  return (domain as LarkBrand) ?? 'feishu';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List all account IDs defined in the Lark config.
 *
 * Returns `[DEFAULT_ACCOUNT_ID]` when no explicit accounts exist.
 */
export function getLarkAccountIds(cfg: ClawdbotConfig): string[] {
  const section = getLarkConfig(cfg);
  if (!section) return [DEFAULT_ACCOUNT_ID];

  const accountMap = getAccountMap(section);
  if (!accountMap || Object.keys(accountMap).length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }

  const accountIds = Object.keys(accountMap);

  // 当 accounts 存在时，如果顶层也配置了 appId/appSecret（即默认机器人），
  // 将 DEFAULT_ACCOUNT_ID 加入列表，确保顶层机器人不会被忽略。
  // 但如果 accountMap 已经包含 default，则不重复添加。
  const hasDefault = accountIds.some((id) => id.trim().toLowerCase() === DEFAULT_ACCOUNT_ID);
  if (!hasDefault) {
    const base = baseConfig(section);
    if (base.appId && base.appSecret) {
      return [DEFAULT_ACCOUNT_ID, ...accountIds];
    }
  }

  return accountIds;
}

/** Return the first (default) account ID. */
export function getDefaultLarkAccountId(cfg: ClawdbotConfig): string {
  return getLarkAccountIds(cfg)[0];
}

/**
 * Resolve a single account by merging the top-level config with
 * account-level overrides.  Account fields take precedence.
 *
 * Falls back to the default account when `accountId` is omitted or `null`.
 */
export function getLarkAccount(cfg: ClawdbotConfig, accountId?: string | null): LarkAccount {
  const requestedId = accountId ? (normalizeAccountId(accountId) ?? DEFAULT_ACCOUNT_ID) : DEFAULT_ACCOUNT_ID;

  const section = getLarkConfig(cfg);

  if (!section) {
    return {
      accountId: requestedId,
      enabled: false,
      configured: false,
      brand: 'feishu',
      config: {} as FeishuConfig,
    };
  }

  const base = baseConfig(section);
  const accountMap = getAccountMap(section);
  const accountOverride =
    accountMap && requestedId !== DEFAULT_ACCOUNT_ID
      ? (accountMap[requestedId] as Partial<FeishuConfig> | undefined)
      : undefined;

  const merged: FeishuConfig = accountOverride
    ? mergeAccountConfig(base, accountOverride)
    : ({ ...base } as FeishuConfig);

  const appId = merged.appId;
  const appSecret = merged.appSecret;
  const configured = !!(appId && appSecret);

  // Respect explicit `enabled` when set; otherwise derive from `configured`.
  const enabled = !!(merged.enabled ?? configured);

  const brand: LarkBrand = toBrand(merged.domain);

  if (configured) {
    return {
      accountId: requestedId,
      enabled,
      configured: true,
      name: merged.name ?? undefined,
      appId: appId!,
      appSecret: appSecret!,
      encryptKey: merged.encryptKey ?? undefined,
      verificationToken: merged.verificationToken ?? undefined,
      brand,
      config: merged,
    };
  }

  return {
    accountId: requestedId,
    enabled,
    configured: false,
    name: merged.name ?? undefined,
    appId: appId ?? undefined,
    appSecret: appSecret ?? undefined,
    encryptKey: merged.encryptKey ?? undefined,
    verificationToken: merged.verificationToken ?? undefined,
    brand,
    config: merged,
  };
}

/**
 * Build an account-scoped config view for downstream helpers that read from
 * `cfg.channels.feishu`.
 *
 * In multi-account mode, many runtime helpers expect the merged account config
 * to already be exposed at `cfg.channels.feishu`. This mirrors the inbound
 * path behavior so outbound/tooling code resolves per-account settings
 * consistently.
 *
 * @param cfg - Original top-level plugin config
 * @param accountId - Optional target account ID
 * @returns Config with `channels.feishu` replaced by the merged account config
 */
export function createAccountScopedConfig(cfg: ClawdbotConfig, accountId?: string | null): ClawdbotConfig {
  const account = getLarkAccount(cfg, accountId);

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      feishu: account.config,
    },
  };
}

/** Return all accounts that are both configured and enabled. */
export function getEnabledLarkAccounts(cfg: ClawdbotConfig): LarkAccount[] {
  const ids = getLarkAccountIds(cfg);
  const results: LarkAccount[] = [];

  for (const id of ids) {
    const account = getLarkAccount(cfg, id);
    if (account.enabled && account.configured) {
      results.push(account);
    }
  }

  return results;
}

/**
 * Extract API credentials from a Feishu config fragment.
 *
 * Returns `null` when `appId` or `appSecret` is missing.
 */
export function getLarkCredentials(feishuCfg?: FeishuConfig): LarkCredentials | null {
  if (!feishuCfg) return null;

  const appId = feishuCfg.appId;
  const appSecret = feishuCfg.appSecret;

  if (!appId || !appSecret) return null;

  return {
    appId,
    appSecret,
    encryptKey: feishuCfg.encryptKey ?? undefined,
    verificationToken: feishuCfg.verificationToken ?? undefined,
    brand: toBrand(feishuCfg.domain),
  };
}

/** Type guard: narrow `LarkAccount` to `ConfiguredLarkAccount`. */
export function isConfigured(account: LarkAccount): account is ConfiguredLarkAccount {
  return account.configured;
}
