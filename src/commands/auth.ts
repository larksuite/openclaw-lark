/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_auth command — 飞书用户权限批量授权命令实现
 *
 * 直接复用 onboarding-auth.ts 的 triggerOnboarding() 函数。
 * 注意：此命令仅限应用 owner 执行（与 onboarding 逻辑一致）
 */

import type { OpenClawConfig } from 'openclaw/plugin-sdk';
import { triggerOnboarding } from '../tools/onboarding-auth';
import { getTicket } from '../core/lark-ticket';
import { getLarkAccount } from '../core/accounts';
import { LarkClient } from '../core/lark-client';
import { getAppInfo, getAppGrantedScopes } from '../core/app-scope-checker';
import { getStoredToken } from '../core/token-store';
import { filterSensitiveScopes } from '../core/tool-scopes';
import { assertOwnerAccessStrict, OwnerAccessDeniedError } from '../core/owner-policy';
import { openPlatformDomain } from '../core/domains';

import type { FeishuLocale } from './locale';

// ---------------------------------------------------------------------------
// I18n text map
// ---------------------------------------------------------------------------

const T: Record<FeishuLocale, {
  noIdentity: string;
  accountIncomplete: (accountId: string) => string;
  missingSelfManage: (link: string) => string;
  ownerOnly: string;
  missingOfflineAccess: (link: string) => string;
  noUserScopes: string;
  allAuthorized: (count: number) => string;
  authSent: string;
}> = {
  zh_cn: {
    noIdentity: '❌ 无法获取用户身份，请在飞书对话中使用此命令',
    accountIncomplete: (accountId) => `❌ 账号 ${accountId} 配置不完整`,
    missingSelfManage: (link) =>
      `❌ 应用缺少核心权限 application:application:self_manage，无法查询可授权 scope 列表。\n\n请管理员在飞书开放平台开通此权限后重试：[申请权限](${link})`,
    ownerOnly: '❌ 此命令仅限应用 owner 执行\n\n如需授权，请联系应用管理员。',
    missingOfflineAccess: (link) =>
      `❌ 应用缺少核心权限 offline_access，无法查询可授权 scope 列表。\n\n请管理员在飞书开放平台开通此权限后重试：[申请权限](${link})`,
    noUserScopes: '当前应用未开通任何用户级权限，无需授权。',
    allAuthorized: (count) => `✅ 您已授权所有可用权限（共 ${count} 个），无需重复授权。`,
    authSent: '✅ 已发送授权请求',
  },
  en_us: {
    noIdentity: '❌ Unable to identify user. Please use this command in a Feishu conversation.',
    accountIncomplete: (accountId) => `❌ Account ${accountId} configuration is incomplete`,
    missingSelfManage: (link) =>
      `❌ App is missing the core permission application:application:self_manage and cannot query available scopes.\n\nPlease ask an admin to grant this permission on the Feishu Open Platform: [Apply](${link})`,
    ownerOnly: '❌ This command is restricted to the app owner.\n\nPlease contact the app admin for authorization.',
    missingOfflineAccess: (link) =>
      `❌ App is missing the core permission offline_access and cannot query available scopes.\n\nPlease ask an admin to grant this permission on the Feishu Open Platform: [Apply](${link})`,
    noUserScopes: 'No user-level permissions are enabled for this app. Authorization is not needed.',
    allAuthorized: (count) => `✅ You have authorized all available permissions (${count} total). No re-authorization needed.`,
    authSent: '✅ Authorization request sent',
  },
};

// ---------------------------------------------------------------------------
// Auth result types (separate side-effects from text generation)
// ---------------------------------------------------------------------------

type AuthResult =
  | { kind: 'no_identity' }
  | { kind: 'account_incomplete'; accountId: string }
  | { kind: 'missing_self_manage'; link: string }
  | { kind: 'owner_only' }
  | { kind: 'missing_offline_access'; link: string }
  | { kind: 'no_user_scopes' }
  | { kind: 'all_authorized'; count: number }
  | { kind: 'auth_sent' };

/**
 * Format an AuthResult into a locale-specific message string.
 */
function formatAuthResult(result: AuthResult, locale: FeishuLocale): string {
  const t = T[locale];
  switch (result.kind) {
    case 'no_identity':
      return t.noIdentity;
    case 'account_incomplete':
      return t.accountIncomplete(result.accountId);
    case 'missing_self_manage':
      return t.missingSelfManage(result.link);
    case 'owner_only':
      return t.ownerOnly;
    case 'missing_offline_access':
      return t.missingOfflineAccess(result.link);
    case 'no_user_scopes':
      return t.noUserScopes;
    case 'all_authorized':
      return t.allAuthorized(result.count);
    case 'auth_sent':
      return t.authSent;
  }
}

// ---------------------------------------------------------------------------
// Core logic (executes side-effects exactly once)
// ---------------------------------------------------------------------------

/**
 * Execute the auth command logic, including side-effects (triggerOnboarding).
 * Returns a discriminated result that can be formatted into any locale.
 */
async function executeFeishuAuth(config: OpenClawConfig): Promise<AuthResult> {
  const ticket = getTicket();
  const senderOpenId = ticket?.senderOpenId;

  if (!senderOpenId) {
    return { kind: 'no_identity' };
  }

  // 提前检查 owner 身份，给出明确提示
  const acct = getLarkAccount(config, ticket.accountId);
  if (!acct.configured) {
    return { kind: 'account_incomplete', accountId: ticket.accountId };
  }

  const sdk = LarkClient.fromAccount(acct).sdk;
  const { appId } = acct;

  const openDomain = openPlatformDomain(acct.brand);

  try {
    await getAppInfo(sdk, appId);
  } catch {
    const link = `${openDomain}/app/${appId}/auth?q=application:application:self_manage&op_from=feishu-openclaw&token_type=tenant`;
    return { kind: 'missing_self_manage', link };
  }

  // Owner 检查（fail-close: 授权命令安全优先）
  try {
    await assertOwnerAccessStrict(acct, sdk, senderOpenId);
  } catch (err) {
    if (err instanceof OwnerAccessDeniedError) {
      return { kind: 'owner_only' };
    }
    throw err;
  }

  // 预检：是否还有未授权的 scope
  let appScopes: string[];
  try {
    appScopes = await getAppGrantedScopes(sdk, appId, 'user');
  } catch {
    const link = `${openDomain}/app/${appId}/auth?q=application:application:self_manage&op_from=feishu-openclaw&token_type=tenant`;
    return { kind: 'missing_self_manage', link };
  }

  // offline_access 预检 — OAuth 必须的前提权限
  const allScopes = await getAppGrantedScopes(sdk, appId);
  if (allScopes.length > 0 && !allScopes.includes('offline_access')) {
    const link = `${openDomain}/app/${appId}/auth?q=offline_access&op_from=feishu-openclaw&token_type=user`;
    return { kind: 'missing_offline_access', link };
  }

  appScopes = filterSensitiveScopes(appScopes);

  if (appScopes.length === 0) {
    return { kind: 'no_user_scopes' };
  }

  const existing = await getStoredToken(appId, senderOpenId);
  const grantedScopes = new Set(existing?.scope?.split(/\s+/).filter(Boolean) ?? []);
  const missingScopes = appScopes.filter((s) => !grantedScopes.has(s));

  if (missingScopes.length === 0) {
    return { kind: 'all_authorized', count: appScopes.length };
  }

  // 调用 triggerOnboarding 执行批量授权（副作用，只执行一次）
  await triggerOnboarding({
    cfg: config,
    userOpenId: senderOpenId,
    accountId: ticket.accountId,
  });

  return { kind: 'auth_sent' };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 执行飞书用户权限批量授权命令
 * 直接调用 triggerOnboarding()，包含 owner 检查
 */
export async function runFeishuAuth(
  config: OpenClawConfig,
  locale: FeishuLocale = 'zh_cn',
): Promise<string> {
  const result = await executeFeishuAuth(config);
  return formatAuthResult(result, locale);
}

/**
 * 运行飞书授权命令，同时生成中英双语结果。
 * 副作用（triggerOnboarding）只执行一次，结果格式化为双语文本。
 */
export async function runFeishuAuthI18n(
  config: OpenClawConfig,
): Promise<Record<FeishuLocale, string>> {
  const result = await executeFeishuAuth(config);
  return {
    zh_cn: formatAuthResult(result, 'zh_cn'),
    en_us: formatAuthResult(result, 'en_us'),
  };
}
