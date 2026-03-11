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
export const FULL_TOOLS_CONFIG: Required<Omit<FeishuToolsConfig, 'preset'>> = {
  doc: true,
  wiki: true,
  drive: true,
  scopes: true,
  perm: false,
  chat: true,
  im: true,
  calendar: true,
  task: true,
  bitable: true,
  auth: true,
  mail: true,
  sheets: true,
  okr: false,
};

/**
 * A smaller default tool surface for users who want lower prompt overhead.
 *
 * Keeps the core messaging/auth/doc path available while disabling the
 * heaviest capability groups unless they are explicitly re-enabled.
 */
export const MINIMAL_TOOLS_CONFIG: Required<Omit<FeishuToolsConfig, 'preset'>> = {
  doc: true,
  wiki: false,
  drive: false,
  scopes: false,
  perm: false,
  chat: true,
  im: true,
  calendar: false,
  task: false,
  bitable: false,
  auth: true,
  mail: false,
  sheets: false,
  okr: false,
};

/** Backward-compatible alias for the full/default preset. */
export const DEFAULT_TOOLS_CONFIG = FULL_TOOLS_CONFIG;

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
  const preset = cfg?.preset ?? 'full';
  const base = preset === 'minimal' ? MINIMAL_TOOLS_CONFIG : FULL_TOOLS_CONFIG;

  return {
    preset,
    doc: cfg?.doc ?? base.doc,
    wiki: cfg?.wiki ?? base.wiki,
    drive: cfg?.drive ?? base.drive,
    perm: cfg?.perm ?? base.perm,
    scopes: cfg?.scopes ?? base.scopes,
    chat: cfg?.chat ?? base.chat,
    im: cfg?.im ?? base.im,
    calendar: cfg?.calendar ?? base.calendar,
    task: cfg?.task ?? base.task,
    bitable: cfg?.bitable ?? base.bitable,
    auth: cfg?.auth ?? base.auth,
    mail: cfg?.mail ?? base.mail,
    sheets: cfg?.sheets ?? base.sheets,
    okr: cfg?.okr ?? base.okr,
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
    preset: 'full',
    doc: false,
    wiki: false,
    drive: false,
    perm: false,
    scopes: false,
    chat: false,
    im: false,
    calendar: false,
    task: false,
    bitable: false,
    auth: false,
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
    merged.chat = merged.chat || cfg.chat;
    merged.im = merged.im || cfg.im;
    merged.calendar = merged.calendar || cfg.calendar;
    merged.task = merged.task || cfg.task;
    merged.bitable = merged.bitable || cfg.bitable;
    merged.auth = merged.auth || cfg.auth;
    merged.mail = merged.mail || cfg.mail;
    merged.sheets = merged.sheets || cfg.sheets;
    merged.okr = merged.okr || cfg.okr;
  }
  return merged;
}
