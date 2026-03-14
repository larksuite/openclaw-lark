/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu-doctor 诊断报告 Markdown 格式化（完全重构版）
 *
 * 直接生成 Markdown 诊断报告，不依赖 diagnose.ts 的任何架构和代码。
 * 按照 doctor_template.md 的格式规范实现。
 */

import type { OpenClawConfig } from 'openclaw/plugin-sdk';
import type * as Lark from '@larksuiteoapi/node-sdk';

import { getEnabledLarkAccounts } from '../core/accounts';
import { LarkClient } from '../core/lark-client';

/**
 * Resolve the global config for cross-account operations.
 *
 * Plugin commands receive an account-scoped config where `channels.feishu`
 * has been replaced with the merged per-account config (the `accounts` map
 * is stripped by `baseConfig()`).  Commands that enumerate all accounts
 * need the original global config to see the full `accounts` map.
 */
function resolveGlobalConfig(config: OpenClawConfig): OpenClawConfig {
  return LarkClient.globalConfig ?? config;
}
import type { ConfiguredLarkAccount } from '../core/types';
import { getAppGrantedScopes, missingScopes } from '../core/app-scope-checker';
import { getAppOwnerFallback } from '../core/app-owner-fallback';
import { getStoredToken, tokenStatus } from '../core/token-store';

import { filterSensitiveScopes, REQUIRED_APP_SCOPES, TOOL_SCOPES } from '../core/tool-scopes';
import { probeFeishu } from '../channel/probe';
import { AppScopeCheckFailedError } from '../core/tool-client';
import { getPluginVersion } from '../core/version';
import { openPlatformDomain } from '../core/domains';
// TODO: 暂时注释掉，等产品策略明确后再放开
// import { checkMultiAccountIsolation, formatIsolationWarning } from "../core/security-check";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CheckStatus = 'pass' | 'warn' | 'fail';

export type { FeishuLocale } from './locale';
/** @deprecated Use FeishuLocale instead */
export type DoctorLocale = import('./locale').FeishuLocale;

// ---------------------------------------------------------------------------
// I18n text map
// ---------------------------------------------------------------------------

const T: Record<DoctorLocale, {
  // maskSecret
  notSet: string;
  // checkBasicInfo
  legacyNotDisabled: string;
  legacyRunCmds: string;
  legacyDisabled: string;
  credentials: string;
  accountEnabled: string;
  apiOk: string;
  apiFail: string;
  apiError: string;
  // checkToolsProfile
  toolsOk: string;
  toolsWarnProfile: (profile: string) => string;
  toolsDocRef: string;
  // checkAppPermissions
  allPermsGranted: (count: number) => string;
  missingPermsPrefix: string;
  missingPermsSuffix: string;
  cannotQueryPerms: string;
  cannotQueryPermsGeneric: string;
  suggestCheckPerm: string;
  adminApply: string;
  apply: string;
  // generatePermissionTable
  permTableHeader: string;
  // checkUserPermissions
  authStatusLabel: string;
  userTotal: string;
  valid: string;
  needRefresh: string;
  expired: string;
  tokenRefreshLabel: string;
  tokenRefreshOn: string;
  tokenRefreshOff: string;
  noUserAuth: string;
  noUserAuthDesc: string;
  permCompareLabel: string;
  permInsufficient: string;
  userCountLabel: string;
  noAuthLabel: string;
  appMissingUserPerms: (count: number) => string;
  permCompareSummary: (appCount: number, total: number, userPart: string) => string;
  userReauth: string;
  userNeedsOAuth: string;
  userPermFailed: string;
  userPermFailedNoSelfManage: string;
  // runFeishuDoctor (main report)
  reportTitle: string;
  pluginVersionLabel: string;
  diagTimeLabel: string;
  noAccounts: string;
  accountNotFoundPrefix: string;
  enabledAccountsLabel: string;
  toolsCheckPass: string;
  toolsCheckWarn: string;
  accountPrefix: string;
  envCheckPass: string;
  envCheckFail: string;
  appPermPass: string;
  appPermFail: string;
  userPermPass: string;
  userPermFail: string;
}> = {
  zh_cn: {
    notSet: '(未设置)',
    legacyNotDisabled:
      '❌ **旧版插件**: 检测到旧版官方插件未禁用\n' +
      '👉 请依次运行命令：\n' +
      '```\n' +
      'openclaw config set plugins.entries.feishu.enabled false --json\n' +
      'openclaw gateway restart\n' +
      '```',
    legacyRunCmds: '👉 请依次运行命令：',
    legacyDisabled: '✅ **旧版插件**: 已禁用',
    credentials: '✅ **凭证完整性**',
    accountEnabled: '✅ **账户启用**: 已启用',
    apiOk: '✅ **API 连通性**: 连接成功',
    apiFail: '❌ **API 连通性**: 连接失败',
    apiError: '❌ **API 连通性**: 探测异常',
    toolsOk: '✅ 飞书工具加载暂未发现异常',
    toolsWarnProfile: (profile: string) =>
      `⚠️ **工具基础允许列表**: 当前为 \`${profile}\`，飞书工具可能无法加载。可以按需修改配置：`,
    toolsDocRef: '📖 参考文档',
    allPermsGranted: (count: number) => `全部 ${count} 个必需权限已开通`,
    missingPermsPrefix: '缺少',
    missingPermsSuffix: '个必需权限。需应用管理员申请开通',
    cannotQueryPerms: '无法查询应用权限状态。原因：未开通 application:application:self_manage 权限',
    cannotQueryPermsGeneric: '无法查询应用权限状态。',
    suggestCheckPerm: '建议检查 application:application:self_manage 权限',
    adminApply: '需应用管理员申请开通',
    apply: '申请',
    permTableHeader: '| 权限名称 | 应用已开通 | 用户已授权 |',
    authStatusLabel: '**授权状态**',
    userTotal: '共 1 个用户',
    valid: '有效',
    needRefresh: '需刷新',
    expired: '已过期',
    tokenRefreshLabel: '**Token 自动刷新**',
    tokenRefreshOn: '✓ 已开启自动刷新 (1/1 个用户)',
    tokenRefreshOff: '✗ 未开启自动刷新，Token 将在 2 小时后过期',
    noUserAuth: '⚠️ **暂无用户授权**',
    noUserAuthDesc: '尚未有用户通过 OAuth 授权。用户首次使用需以用户身份的功能时，会自动触发授权流程。',
    permCompareLabel: '**权限对照**',
    permInsufficient: '**用户身份权限不足**',
    userCountLabel: '已授权',
    noAuthLabel: '暂无授权',
    appMissingUserPerms: (count: number) => `💡 应用缺少 ${count} 个用户身份权限。需应用管理员申请开通`,
    permCompareSummary: (appCount: number, total: number, userPart: string) =>
      `应用 **${appCount}/${total}** 已开通，用户 **${userPart}**`,
    userReauth: '💡 用户需要重新授权以获得完整权限，可以向机器人发送消息 "**/feishu auth**"',
    userNeedsOAuth: '💡 用户需要进行 OAuth 授权，可以向机器人发送消息 "**/feishu auth**"',
    userPermFailed: '用户权限检查失败',
    userPermFailedNoSelfManage: '用户权限检查失败：无法查询应用权限。原因：未开通 application:application:self_manage 权限',
    reportTitle: '### 飞书插件诊断',
    pluginVersionLabel: '插件版本',
    diagTimeLabel: '诊断时间',
    noAccounts: '❌ **错误**: 未找到已启用的飞书账户\n\n请在 OpenClaw 配置文件中配置飞书账户并启用。',
    accountNotFoundPrefix: '❌ **错误**: 未找到账户',
    enabledAccountsLabel: '当前已启用的账户',
    toolsCheckPass: '#### ✅ 工具配置检查通过',
    toolsCheckWarn: '#### ⚠️ 工具配置检查异常',
    accountPrefix: '### 账户',
    envCheckPass: '#### ✅ 环境信息检查通过',
    envCheckFail: '#### ❌ 环境信息检查未通过',
    appPermPass: '#### ✅ 应用身份权限检查通过',
    appPermFail: '#### ❌ 应用身份权限检查未通过',
    userPermPass: '#### ✅ 用户身份权限检查通过',
    userPermFail: '#### ❌ 用户身份权限检查未通过',
  },
  en_us: {
    notSet: '(not set)',
    legacyNotDisabled:
      '❌ **Legacy Plugin**: Legacy official plugin is not disabled\n' +
      '👉 Please run the following commands:\n' +
      '```\n' +
      'openclaw config set plugins.entries.feishu.enabled false --json\n' +
      'openclaw gateway restart\n' +
      '```',
    legacyRunCmds: '👉 Please run the following commands:',
    legacyDisabled: '✅ **Legacy Plugin**: Disabled',
    credentials: '✅ **Credentials**',
    accountEnabled: '✅ **Account**: Enabled',
    apiOk: '✅ **API Connectivity**: Connected',
    apiFail: '❌ **API Connectivity**: Connection failed',
    apiError: '❌ **API Connectivity**: Probe error',
    toolsOk: '✅ Feishu tools loading: No issues found',
    toolsWarnProfile: (profile: string) =>
      `⚠️ **Tool Allowlist**: Currently set to \`${profile}\`. Feishu tools may not load properly. Update configuration as needed:`,
    toolsDocRef: '📖 Documentation',
    allPermsGranted: (count: number) => `All ${count} required permissions granted`,
    missingPermsPrefix: 'Missing',
    missingPermsSuffix: 'required permissions. Admin needs to apply',
    cannotQueryPerms: 'Unable to query app permissions. Reason: Missing application:application:self_manage permission',
    cannotQueryPermsGeneric: 'Unable to query app permissions.',
    suggestCheckPerm: 'Please check application:application:self_manage permission',
    adminApply: 'Admin needs to apply',
    apply: 'Apply',
    permTableHeader: '| Permission | App Granted | User Authorized |',
    authStatusLabel: '**Auth Status**',
    userTotal: '1 user total',
    valid: 'Valid',
    needRefresh: 'Needs refresh',
    expired: 'Expired',
    tokenRefreshLabel: '**Token Auto-Refresh**',
    tokenRefreshOn: '✓ Auto-refresh enabled (1/1 users)',
    tokenRefreshOff: '✗ Auto-refresh not enabled. Token will expire in 2 hours',
    noUserAuth: '⚠️ **No User Authorization**',
    noUserAuthDesc: 'No user has authorized via OAuth yet. The authorization flow will be triggered automatically when a user first uses a feature requiring user identity.',
    permCompareLabel: '**Permission Comparison**',
    permInsufficient: '**Insufficient User Permissions**',
    userCountLabel: 'authorized',
    noAuthLabel: 'not authorized',
    appMissingUserPerms: (count: number) => `💡 App is missing ${count} user-identity permissions. Admin needs to apply`,
    permCompareSummary: (appCount: number, total: number, userPart: string) =>
      `App **${appCount}/${total}** granted, User **${userPart}**`,
    userReauth: '💡 User needs to re-authorize for full permissions. Send message to bot: "**/feishu auth**"',
    userNeedsOAuth: '💡 User needs OAuth authorization. Send message to bot: "**/feishu auth**"',
    userPermFailed: 'User permission check failed',
    userPermFailedNoSelfManage: 'User permission check failed: Unable to query app permissions. Reason: Missing application:application:self_manage permission',
    reportTitle: '### Feishu Plugin Diagnostics',
    pluginVersionLabel: 'Plugin version',
    diagTimeLabel: 'Diagnosis time',
    noAccounts: '❌ **Error**: No enabled Feishu accounts found\n\nPlease configure and enable a Feishu account in the OpenClaw configuration.',
    accountNotFoundPrefix: '❌ **Error**: Account not found',
    enabledAccountsLabel: 'Currently enabled accounts',
    toolsCheckPass: '#### ✅ Tool Configuration Check Passed',
    toolsCheckWarn: '#### ⚠️ Tool Configuration Check Warning',
    accountPrefix: '### Account',
    envCheckPass: '#### ✅ Environment Check Passed',
    envCheckFail: '#### ❌ Environment Check Failed',
    appPermPass: '#### ✅ App Permission Check Passed',
    appPermFail: '#### ❌ App Permission Check Failed',
    userPermPass: '#### ✅ User Permission Check Passed',
    userPermFail: '#### ❌ User Permission Check Failed',
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * 格式化时间戳为 "YYYY-MM-DD HH:mm:ss"
 */
function formatTimestamp(date: Date): string {
  return date.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace('T', ' ');
}

/**
 * 获取所有工具动作需要的唯一 scope 列表（从 diagnose.ts 复制）
 */
function getAllToolScopes(): string[] {
  const scopesSet = new Set<string>();
  for (const scopes of Object.values(TOOL_SCOPES)) {
    for (const scope of scopes) {
      scopesSet.add(scope);
    }
  }
  return Array.from(scopesSet).sort();
}

// ---------------------------------------------------------------------------
// 基础信息检查
// ---------------------------------------------------------------------------

/**
 * 掩码敏感信息（appSecret）
 */
function maskSecret(secret: string | undefined, locale: DoctorLocale): string {
  if (!secret) return T[locale].notSet;
  if (secret.length <= 4) return '****';
  return secret.slice(0, 4) + '****';
}

/**
 * 检查基础信息和账号状态
 */
async function checkBasicInfo(
  account: ConfiguredLarkAccount,
  config: OpenClawConfig,
  locale: DoctorLocale,
): Promise<{ status: CheckStatus; markdown: string }> {
  const t = T[locale];
  const lines: string[] = [];
  let status: CheckStatus = 'pass';

  // 旧版官方插件是否已禁用
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const feishuEntry = (config as any).plugins?.entries?.feishu;
  if (feishuEntry && feishuEntry.enabled !== false) {
    status = 'fail';
    lines.push(t.legacyNotDisabled);
  } else {
    lines.push(t.legacyDisabled);
  }

  lines.push(`${t.credentials}: appId: ${account.appId}, appSecret: ${maskSecret(account.appSecret, locale)}`);
  lines.push(t.accountEnabled);

  // API 连通性
  try {
    const probeResult = await probeFeishu({
      accountId: account.accountId,
      appId: account.appId,
      appSecret: account.appSecret,
      brand: account.brand,
    });

    if (probeResult.ok) {
      lines.push(t.apiOk);
    } else {
      status = 'fail';
      lines.push(`${t.apiFail} - ${probeResult.error}`);
    }
  } catch (err) {
    status = 'fail';
    lines.push(`${t.apiError} - ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    status,
    markdown: lines.join('\n'),
  };
}

// ---------------------------------------------------------------------------
// 工具配置检查
// ---------------------------------------------------------------------------

const INCOMPLETE_PROFILES = new Set(['minimal', 'coding', 'messaging']);

function checkToolsProfile(config: OpenClawConfig, locale: DoctorLocale): { status: CheckStatus; markdown: string } {
  const t = T[locale];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (config as any).tools;
  const profile: string | undefined = tools?.profile;

  if (!profile) {
    return {
      status: 'pass',
      markdown: t.toolsOk,
    };
  }

  if (INCOMPLETE_PROFILES.has(profile)) {
    return {
      status: 'warn',
      markdown:
        `${t.toolsWarnProfile(profile)}\n` +
        '```\n' +
        'openclaw config set tools.profile "full"\n' +
        'openclaw gateway restart\n' +
        '```\n' +
        `${t.toolsDocRef}: https://docs.openclaw.ai/zh-CN/tools`,
    };
  }

  // profile === "full" 或其他未知值
  return {
    status: 'pass',
    markdown: t.toolsOk,
  };
}

// ---------------------------------------------------------------------------
// 应用权限检查
// ---------------------------------------------------------------------------

/**
 * 检查应用权限状态
 */
async function checkAppPermissions(
  account: ConfiguredLarkAccount,
  sdk: Lark.Client,
  locale: DoctorLocale,
): Promise<{ status: CheckStatus; markdown: string; missingScopes: string[] }> {
  const t = T[locale];
  const { appId } = account;
  const openDomain = openPlatformDomain(account.brand);

  try {
    // 获取应用已开通的权限（tenant token）
    const grantedScopes = await getAppGrantedScopes(sdk, appId, 'tenant');

    // 计算缺失的必需权限
    const requiredMissing = missingScopes(grantedScopes, Array.from(REQUIRED_APP_SCOPES));

    if (requiredMissing.length === 0) {
      // 全部权限已开通
      return {
        status: 'pass',
        markdown: t.allPermsGranted(REQUIRED_APP_SCOPES.length),
        missingScopes: [],
      };
    }

    // 缺少必需权限
    const lines: string[] = [];
    let applyUrl = `${openDomain}/app/${appId}/auth?op_from=feishu-openclaw&token_type=tenant`;
    if (requiredMissing.length < 20) {
      applyUrl = `${openDomain}/app/${appId}/auth?q=${encodeURIComponent(requiredMissing.join(','))}&op_from=feishu-openclaw&token_type=tenant`;
    }
    lines.push(`${t.missingPermsPrefix} ${requiredMissing.length} ${t.missingPermsSuffix} [${t.apply}](${applyUrl})`);
    lines.push('');
    for (const scope of requiredMissing) {
      lines.push(`- ${scope}`);
    }

    return {
      status: 'fail',
      markdown: lines.join('\n'),
      missingScopes: requiredMissing,
    };
  } catch (err) {
    // API 调用失败（通常是缺少 application:application:self_manage 权限）
    const applyUrl = `${openDomain}/app/${appId}/auth?q=application:application:self_manage&op_from=feishu-openclaw&token_type=tenant`;

    if (err instanceof AppScopeCheckFailedError) {
      return {
        status: 'fail',
        markdown: `${t.cannotQueryPerms}\n\n${t.adminApply} [${t.apply}](${applyUrl})`,
        missingScopes: [],
      };
    }

    return {
      status: 'fail',
      markdown: `${t.cannotQueryPermsGeneric}${err instanceof Error ? err.message : String(err)}\n\n${t.suggestCheckPerm} [${t.apply}](${applyUrl})`,
      missingScopes: [],
    };
  }
}

// ---------------------------------------------------------------------------
// 用户权限检查
// ---------------------------------------------------------------------------

/**
 * 生成权限对照表
 */
function generatePermissionTable(
  appGrantedScopes: string[],
  userGrantedScopes: string[],
  hasValidUser: boolean,
  locale: DoctorLocale,
): string {
  let allScopes = getAllToolScopes();
  allScopes = filterSensitiveScopes(allScopes);
  const appSet = new Set(appGrantedScopes);
  const userSet = new Set(userGrantedScopes);

  const lines: string[] = [];
  lines.push(T[locale].permTableHeader);
  lines.push('|----------|-----------|-----------|');

  for (const scope of allScopes) {
    const appGranted = appSet.has(scope) ? '✅' : '❌';
    // 如果没有有效用户，显示 ➖；否则根据授权情况显示 ✅ 或 ❌
    const userGranted = !hasValidUser ? '➖' : userSet.has(scope) ? '✅' : '❌';
    lines.push(`| ${scope} | ${appGranted} | ${userGranted} |`);
  }

  return lines.join('\n');
}

/**
 * 检查用户权限状态
 */
async function checkUserPermissions(
  account: ConfiguredLarkAccount,
  sdk: Lark.Client,
  locale: DoctorLocale,
): Promise<{
  status: CheckStatus;
  markdown: string;
  hasAuth: boolean;
  tokenExpired: boolean;
  missingUserScopes: string[];
}> {
  const t = T[locale];
  const { appId } = account;
  const openDomain = openPlatformDomain(account.brand);
  const lines: string[] = [];

  try {
    // 1. 获取应用所有者
    const ownerId = await getAppOwnerFallback(account, sdk);

    // 2. 读取 token
    const token = ownerId ? await getStoredToken(appId, ownerId) : null;

    // 判断是否有有效的用户授权
    const hasUserAuth = !!token;

    // 变量初始化
    let authStatus: CheckStatus = 'warn';
    let refreshStatus: CheckStatus = 'warn';
    let validCount = 0;
    let scopes: string[] = [];
    let userTokenStatus: 'valid' | 'needs_refresh' | 'expired' = 'expired';
    let userMissing: string[] = [];

    // 获取应用开通的支持 user token 的权限
    const appUserScopes = await getAppGrantedScopes(sdk, appId, 'user');
    let  allScopes = getAllToolScopes();
    allScopes = filterSensitiveScopes(allScopes);
    const appGrantedCount = appUserScopes.filter((s) => allScopes.includes(s)).length;

    if (hasUserAuth) {
      // 有用户授权 - 检查授权状态
      const status = tokenStatus(token);
      userTokenStatus = status;
      scopes = token.scope.split(' ').filter(Boolean);
      validCount = status === 'valid' ? 1 : 0;
      const needsRefreshCount = status === 'needs_refresh' ? 1 : 0;
      const expiredCount = status === 'expired' ? 1 : 0;

      authStatus = expiredCount > 0 ? 'warn' : validCount === 1 ? 'pass' : 'warn';
      const authEmoji = authStatus === 'pass' ? '✅' : '⚠️';

      lines.push(
        `${authEmoji} ${t.authStatusLabel}: ${t.userTotal} | ✓ ${t.valid}: ${validCount}, ⟳ ${t.needRefresh}: ${needsRefreshCount}, ✗ ${t.expired}: ${expiredCount}`,
      );

      // Token 自动刷新检查
      const hasOfflineAccess = scopes.includes('offline_access');
      refreshStatus = hasOfflineAccess ? 'pass' : 'warn';
      const refreshEmoji = refreshStatus === 'pass' ? '✅' : '⚠️';

      lines.push(
        `${refreshEmoji} ${t.tokenRefreshLabel}: ${hasOfflineAccess ? t.tokenRefreshOn : t.tokenRefreshOff}`,
      );
    } else {
      // 没有用户授权
      lines.push(t.noUserAuth);
      lines.push('');
      lines.push(t.noUserAuthDesc);
      lines.push('');
    }

    // 计算用户已授权权限数
    const userGrantedCount = validCount === 1 ? scopes.filter((s) => allScopes.includes(s)).length : 0;

    // 计算用户缺失的权限
    if (hasUserAuth && validCount === 1) {
      const scopeSet = new Set(scopes);
      userMissing = allScopes.filter((s) => !scopeSet.has(s));
    }

    // 权限对照统计
    const tableStatus: CheckStatus =
      appGrantedCount < allScopes.length || userGrantedCount < allScopes.length
        ? appGrantedCount < allScopes.length
          ? 'fail'
          : 'warn'
        : 'pass';
    const tableEmoji = tableStatus === 'pass' ? '✅' : tableStatus === 'warn' ? '⚠️' : '❌';

    if (validCount === 0) {
      lines.push(`${t.permCompareLabel}: ${t.permCompareSummary(appGrantedCount, allScopes.length, t.noAuthLabel)}`);
    } else if (userGrantedCount < allScopes.length) {
      lines.push(
        `${tableEmoji} ${t.permInsufficient}: ${t.permCompareSummary(appGrantedCount, allScopes.length, `${userGrantedCount}/${allScopes.length} ${t.userCountLabel}`)}`,
      );
    } else {
      lines.push(
        `${tableEmoji} ${t.permCompareLabel}: ${t.permCompareSummary(appGrantedCount, allScopes.length, `${userGrantedCount}/${allScopes.length} ${t.userCountLabel}`)}`,
      );
    }
    lines.push('');

    // 添加指引信息
    if (appGrantedCount < allScopes.length) {
      // 计算缺失的应用权限
      const appMissingScopes = allScopes.filter((s) => !appUserScopes.includes(s));
      let appApplyUrl = `${openDomain}/app/${appId}/auth?op_from=feishu-openclaw&token_type=user`;
      if (appMissingScopes.length < 20) {
        appApplyUrl = `${openDomain}/app/${appId}/auth?q=${encodeURIComponent(appMissingScopes.join(','))}&op_from=feishu-openclaw&token_type=user`;
      }

      lines.push(`${t.appMissingUserPerms(appMissingScopes.length)} [${t.apply}](${appApplyUrl})`);
    }
    if (userGrantedCount < allScopes.length && validCount > 0) {
      lines.push(t.userReauth);
      lines.push('');
    } else if (!hasUserAuth) {
      lines.push(t.userNeedsOAuth);
      lines.push('');
    }

    // 生成详细权限对照表
    const table = generatePermissionTable(appUserScopes, validCount === 1 ? scopes : [], validCount === 1, locale);
    lines.push(table);

    // 计算总体状态
    const overallStatus: CheckStatus =
      tableStatus === 'fail'
        ? 'fail'
        : authStatus === 'warn' || refreshStatus === 'warn' || tableStatus === 'warn'
          ? 'warn'
          : 'pass';

    return {
      status: overallStatus,
      markdown: lines.join('\n'),
      hasAuth: hasUserAuth,
      tokenExpired: userTokenStatus === 'expired',
      missingUserScopes: userMissing,
    };
  } catch (err) {
    const applyUrl = `${openDomain}/app/${appId}/auth?q=application:application:self_manage&op_from=feishu-openclaw&token_type=tenant`;

    if (err instanceof AppScopeCheckFailedError) {
      return {
        status: 'warn',
        markdown: `${t.userPermFailedNoSelfManage}\n\n${t.adminApply} [${t.apply}](${applyUrl})`,
        hasAuth: false,
        tokenExpired: false,
        missingUserScopes: [],
      };
    }

    return {
      status: 'warn',
      markdown: `${t.userPermFailed}: ${err instanceof Error ? err.message : String(err)}`,
      hasAuth: false,
      tokenExpired: false,
      missingUserScopes: [],
    };
  }
}

// ---------------------------------------------------------------------------
// 主函数
// ---------------------------------------------------------------------------

/**
 * 运行飞书插件诊断，生成 Markdown 格式报告。
 *
 * @param config - OpenClaw 配置
 * @param currentAccountId - 当前发送命令的机器人账号 ID（若有则只诊断该账号）
 * @param locale - 输出语言，默认 zh_cn
 */
export async function runFeishuDoctor(
  config: OpenClawConfig,
  currentAccountId?: string,
  locale: DoctorLocale = 'zh_cn',
): Promise<string> {
  const t = T[locale];
  const lines: string[] = [];

  // 1. 获取目标账户
  //    Use the global config to enumerate all accounts — the passed-in
  //    config may be account-scoped (accounts map stripped).
  const globalCfg = resolveGlobalConfig(config);
  const allAccounts = getEnabledLarkAccounts(globalCfg);
  if (allAccounts.length === 0) {
    return t.noAccounts;
  }

  // 若指定了 accountId，只诊断该账号
  const accounts = currentAccountId ? allAccounts.filter((a) => a.accountId === currentAccountId) : allAccounts;

  if (accounts.length === 0) {
    return `${t.accountNotFoundPrefix} "${currentAccountId}"\n\n${t.enabledAccountsLabel}: ${allAccounts.map((a) => a.accountId).join(', ')}`;
  }

  // 2. 生成报告头部
  lines.push(t.reportTitle);
  lines.push('');
  lines.push(`${t.pluginVersionLabel}: ${getPluginVersion()}  |  ${t.diagTimeLabel}: ${formatTimestamp(new Date())}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // 3. 工具配置（全局，不区分账户）
  const toolsResult = checkToolsProfile(config, locale);
  const toolsTitle = toolsResult.status === 'pass' ? t.toolsCheckPass : t.toolsCheckWarn;
  lines.push(toolsTitle);
  lines.push('');
  lines.push(toolsResult.markdown);
  lines.push('');
  lines.push('---');
  lines.push('');

  // 3.5 多账号隔离检查（全局问题，始终展示）
  // TODO: 暂时注释掉，等产品策略明确后再放开
  // const isolationStatus = checkMultiAccountIsolation(config);
  // const isolationWarning = formatIsolationWarning(isolationStatus, config);
  // if (isolationWarning) {
  //   lines.push(isolationWarning);
  //   lines.push("");
  //   lines.push("---");
  //   lines.push("");
  // }

  // 4. 逐账户诊断（仅目标账户）
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i] as ConfiguredLarkAccount;
    const sdk = LarkClient.fromAccount(account).sdk;
    const accountLabel = account.accountId || account.appId;

    if (accounts.length > 1) {
      lines.push(`${t.accountPrefix} ${i + 1}: ${accountLabel}`);
      lines.push('');
    }

    // 4a. 环境信息
    const basicInfoResult = await checkBasicInfo(account, config, locale);
    const basicTitle = basicInfoResult.status === 'pass' ? t.envCheckPass : t.envCheckFail;
    lines.push(basicTitle);
    lines.push('');
    lines.push(basicInfoResult.markdown);
    lines.push('');
    lines.push('---');
    lines.push('');

    // 4b. 应用权限
    const appResult = await checkAppPermissions(account, sdk, locale);
    const appTitle = appResult.status === 'pass' ? t.appPermPass : t.appPermFail;
    lines.push(appTitle);
    lines.push('');
    lines.push(appResult.markdown);
    lines.push('');
    lines.push('---');
    lines.push('');

    // 4c. 用户权限
    const userResult = await checkUserPermissions(account, sdk, locale);
    const userTitle = userResult.status === 'pass' ? t.userPermPass : t.userPermFail;
    lines.push(userTitle);
    lines.push('');
    lines.push(userResult.markdown);
    lines.push('');

    if (i < accounts.length - 1) {
      lines.push('---');
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * 运行飞书插件诊断，同时生成中英双语 Markdown 报告。
 * 用于飞书 channel 的多语言 post 发送。
 */
export async function runFeishuDoctorI18n(
  config: OpenClawConfig,
  currentAccountId?: string,
): Promise<Record<DoctorLocale, string>> {
  const [zh_cn, en_us] = await Promise.all([
    runFeishuDoctor(config, currentAccountId, 'zh_cn'),
    runFeishuDoctor(config, currentAccountId, 'en_us'),
  ]);
  return { zh_cn, en_us };
}
