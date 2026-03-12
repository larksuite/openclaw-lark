/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * uat-access-guard.ts — UAT 访问统一判权入口。
 *
 * 负责在 UAT 调用前判定当前用户是否有权限。
 * doctor/diagnose 命令不参与此 guard，它们有独立的诊断用户选择逻辑。
 *
 * 判权顺序：
 *   1. 无用户身份 → UatIdentityRequiredError
 *   2. ownerOnly=true → 只认 owner
 *   3. ownerOnly=false && appRoleAuth=false → 按 normal 放行
 *   4. ownerOnly=false && appRoleAuth=true && requiredRole=normal → 直接放行
 *   5. ownerOnly=false && appRoleAuth=true && requiredRole>normal → 查远端角色
 */

import type * as Lark from '@larksuiteoapi/node-sdk';
import type { ConfiguredLarkAccount } from './types';
import type { UatRole, UatConfigurableRole } from './uat-policy';
import { resolveUatPolicy, isRoleSufficient } from './uat-policy';
import { getAppInfo } from './app-scope-checker';
import { getCollaboratorRoles, getCollaboratorRole } from './app-collaborator-cache';
import { larkLogger } from './lark-logger';

const log = larkLogger('core/uat-access-guard');

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/**
 * 没有用户身份（senderOpenId 为空）时抛出。
 * 不允许 auto-auth 拉起 OAuth（无法确定授权对象）。
 */
export class UatIdentityRequiredError extends Error {
  /** 标记属性，供 isUatPolicyError() 识别。 */
  readonly isUatPolicyError = true as const;

  constructor() {
    super('无法获取用户身份，请在飞书对话中使用此功能。');
    this.name = 'UatIdentityRequiredError';
  }
}

/**
 * 用户角色不满足策略要求时抛出。
 * 不允许 auto-auth 拉起 OAuth（角色不够不是授权不足）。
 */
export class UatAccessDeniedError extends Error {
  readonly isUatPolicyError = true as const;
  readonly requiredRole: UatConfigurableRole | 'owner';
  readonly actualRole?: UatConfigurableRole;

  constructor(requiredRole: UatConfigurableRole | 'owner', actualRole?: UatConfigurableRole) {
    const roleLabel = requiredRole === 'owner' ? '应用所有者' : requiredRole;
    super(`当前用户角色不满足要求（需要 ${roleLabel} 或更高角色）。`);
    this.name = 'UatAccessDeniedError';
    this.requiredRole = requiredRole;
    this.actualRole = actualRole;
  }
}

/**
 * 远端角色信息无法获取时抛出。
 * 不允许 auto-auth 拉起 OAuth。
 */
export class UatAccessUnavailableError extends Error {
  readonly isUatPolicyError = true as const;
  readonly reason: 'owner_lookup_failed' | 'collaborator_lookup_failed';

  constructor(reason: 'owner_lookup_failed' | 'collaborator_lookup_failed') {
    super('无法验证应用角色，请稍后重试或联系管理员检查应用权限。');
    this.name = 'UatAccessUnavailableError';
    this.reason = reason;
  }
}

/**
 * 判断 err 是否为 UAT 策略错误（三种之一）。
 * 用于 isInvokeError / auto-auth 的识别。
 */
export function isUatPolicyError(err: unknown): boolean {
  return (
    err instanceof UatIdentityRequiredError ||
    err instanceof UatAccessDeniedError ||
    err instanceof UatAccessUnavailableError
  );
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type UatAccessResult =
  | { allowed: true; userOpenId: string; role: UatRole; ownerOpenId?: string }
  | { allowed: false; error: UatIdentityRequiredError | UatAccessDeniedError | UatAccessUnavailableError };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function lookupOwnerOpenId(sdk: Lark.Client, appId: string): Promise<string | undefined> {
  try {
    const appInfo = await getAppInfo(sdk, appId);
    return appInfo.effectiveOwnerOpenId;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 解析 UAT 访问权限，返回严格结果。
 * 不抛出异常——调用方根据 allowed 字段决定后续行为。
 */
export async function resolveUatAccess(params: {
  account: ConfiguredLarkAccount;
  sdk: Lark.Client;
  userOpenId?: string;
  stateDir?: string;
}): Promise<UatAccessResult> {
  const { account, sdk, stateDir } = params;
  const userOpenId = params.userOpenId;
  const policy = resolveUatPolicy(account);

  // 1. 无用户身份
  if (!userOpenId) {
    return { allowed: false, error: new UatIdentityRequiredError() };
  }

  // 2. ownerOnly 模式
  if (policy.ownerOnly) {
    const ownerOpenId = await lookupOwnerOpenId(sdk, account.appId);
    if (ownerOpenId === undefined) {
      return { allowed: false, error: new UatAccessUnavailableError('owner_lookup_failed') };
    }
    if (ownerOpenId === userOpenId) {
      return { allowed: true, userOpenId, role: 'owner', ownerOpenId };
    }
    return { allowed: false, error: new UatAccessDeniedError('owner') };
  }

  // 3. 非 ownerOnly + 无角色鉴权
  if (!policy.appRoleAuth) {
    return { allowed: true, userOpenId, role: 'normal' };
  }

  // 4. appRoleAuth=true, requiredRole=normal → 所有用户都能通过，跳过远端查询
  if (policy.requiredRole === 'normal') {
    return { allowed: true, userOpenId, role: 'normal' };
  }

  // 5. 需要查远端角色
  // 5a. 先查 owner
  const ownerOpenId = await lookupOwnerOpenId(sdk, account.appId);
  if (ownerOpenId === undefined) {
    return { allowed: false, error: new UatAccessUnavailableError('owner_lookup_failed') };
  }
  if (ownerOpenId === userOpenId) {
    return { allowed: true, userOpenId, role: 'owner', ownerOpenId };
  }

  // 5b. 查协作者缓存
  let collaborators;
  try {
    collaborators = await getCollaboratorRoles({
      accountId: account.accountId,
      appId: account.appId,
      sdk,
      stateDir,
    });
  } catch {
    return { allowed: false, error: new UatAccessUnavailableError('collaborator_lookup_failed') };
  }

  const actualRole = getCollaboratorRole(collaborators, userOpenId);

  if (isRoleSufficient(actualRole, policy.requiredRole)) {
    return { allowed: true, userOpenId, role: actualRole, ownerOpenId };
  }

  return { allowed: false, error: new UatAccessDeniedError(policy.requiredRole, actualRole) };
}

/**
 * 断言 UAT 访问权限，不满足则抛出。
 * 用于 tool-client / oauth / auth 等需要一行判权的场景。
 */
export async function assertUatAccess(params: {
  account: ConfiguredLarkAccount;
  sdk: Lark.Client;
  userOpenId?: string;
  stateDir?: string;
}): Promise<{ userOpenId: string; role: UatRole }> {
  const result = await resolveUatAccess(params);
  if (!result.allowed) {
    log.warn(`UAT access denied for ${params.userOpenId ?? 'unknown'}`, {
      accountId: params.account.accountId,
      error: result.error.name,
    });
    throw result.error;
  }
  return { userOpenId: result.userOpenId, role: result.role };
}
