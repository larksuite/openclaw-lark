/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Default values and resolution logic for the Feishu tools configuration.
 *
 * Each boolean flag controls whether a particular category of Feishu-specific
 * agent tools (document access, wiki queries, drive operations, etc.) is
 * enabled for a given account.
 */

import type { FeishuToolsConfig, LarkAccount } from './types';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * The default tools configuration.
 *
 * By default every non-destructive capability is enabled.  The `perm` flag
 * (permission management) defaults to `false` because granting / revoking
 * permissions is a privileged operation that admins should opt into
 * explicitly.
 */
export const DEFAULT_TOOLS_CONFIG: Required<FeishuToolsConfig> = {
  doc: true,
  wiki: true,
  drive: true,
  scopes: true,
  perm: false,
  mail: true,
  sheets: true,
  okr: false,
};

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Merge a partial tools configuration with `DEFAULT_TOOLS_CONFIG`.
 *
 * Fields present in the input take precedence; anything absent falls back
 * to the default value.
 */
export function resolveToolsConfig(cfg?: FeishuToolsConfig): Required<FeishuToolsConfig> {
  if (!cfg) return { ...DEFAULT_TOOLS_CONFIG };

  return {
    doc: cfg.doc ?? DEFAULT_TOOLS_CONFIG.doc,
    wiki: cfg.wiki ?? DEFAULT_TOOLS_CONFIG.wiki,
    drive: cfg.drive ?? DEFAULT_TOOLS_CONFIG.drive,
    perm: cfg.perm ?? DEFAULT_TOOLS_CONFIG.perm,
    scopes: cfg.scopes ?? DEFAULT_TOOLS_CONFIG.scopes,
    mail: cfg.mail ?? DEFAULT_TOOLS_CONFIG.mail,
    sheets: cfg.sheets ?? DEFAULT_TOOLS_CONFIG.sheets,
    okr: cfg.okr ?? DEFAULT_TOOLS_CONFIG.okr,
  };
}

// ---------------------------------------------------------------------------
// Multi-account aggregation
// ---------------------------------------------------------------------------

/**
 * 合并多个账户的工具配置（取并集）。
 *
 * 工具注册是全局的（启动时注册一次），只要任意一个账户启用了某工具，
 * 该工具就应被注册。执行时由 LarkTicket 路由到具体账户。
 */
export function resolveAnyEnabledToolsConfig(accounts: LarkAccount[]): Required<FeishuToolsConfig> {
  const merged: Required<FeishuToolsConfig> = {
    doc: false,
    wiki: false,
    drive: false,
    perm: false,
    scopes: false,
    mail: false,
    sheets: false,
    okr: false,
  };
  for (const account of accounts) {
    const cfg = resolveToolsConfig((account.config as { tools?: FeishuToolsConfig }).tools);
    merged.doc = merged.doc || cfg.doc;
    merged.wiki = merged.wiki || cfg.wiki;
    merged.drive = merged.drive || cfg.drive;
    merged.perm = merged.perm || cfg.perm;
    merged.scopes = merged.scopes || cfg.scopes;
    merged.mail = merged.mail || cfg.mail;
    merged.sheets = merged.sheets || cfg.sheets;
    merged.okr = merged.okr || cfg.okr;
  }
  return merged;
}
