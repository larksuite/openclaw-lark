/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * uat-policy.ts — UAT 访问策略配置归一化。
 *
 * 从 account.config.uat 的 optional 字段产出稳定默认值后的策略对象，
 * 各消费方统一使用 resolveUatPolicy() 的输出，不再自行解释 optional 字段。
 */

import type { ConfiguredLarkAccount } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 飞书应用协作者角色 + 特殊 owner 角色。 */
export type UatRole = 'normal' | 'operator' | 'developer' | 'administrator' | 'owner';

/** 可配置的角色（不含 owner，owner 始终最高特权）。 */
export type UatConfigurableRole = Exclude<UatRole, 'owner'>;

/** 归一化后的 UAT 访问策略，所有字段均为必填。 */
export interface ResolvedUatPolicy {
  ownerOnly: boolean;
  appRoleAuth: boolean;
  requiredRole: UatConfigurableRole;
  autoOnboarding: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** accessLevel 数字 → 角色名映射。 */
const ACCESS_LEVEL_TO_ROLE: Record<number, UatConfigurableRole> = {
  1: 'normal',
  2: 'operator',
  3: 'developer',
  4: 'administrator',
};

/** 角色等级比较值（数字越大权限越高）。 */
export const ROLE_RANK: Record<UatRole, number> = {
  normal: 0,
  operator: 1,
  developer: 2,
  administrator: 3,
  owner: 4,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 从账号配置中解析出稳定的 UAT 策略对象。
 *
 * 所有字段均填充默认值，消费方不需要处理 undefined：
 * - ownerOnly: true（默认最小暴露面）
 * - appRoleAuth: false
 * - requiredRole: 'normal'
 * - autoOnboarding: false
 */
export function resolveUatPolicy(account: ConfiguredLarkAccount): ResolvedUatPolicy {
  const uat = account.config?.uat;
  return {
    ownerOnly: uat?.ownerOnly ?? true,
    appRoleAuth: uat?.appRoleAuth ?? false,
    requiredRole: ACCESS_LEVEL_TO_ROLE[uat?.accessLevel ?? 1] ?? 'normal',
    autoOnboarding: uat?.autoOnboarding ?? false,
  };
}

/**
 * 比较两个角色的等级。
 *
 * @returns true 如果 actual 的等级 >= required
 */
export function isRoleSufficient(actual: UatRole, required: UatConfigurableRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}
