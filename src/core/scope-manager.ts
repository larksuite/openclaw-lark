/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Scope 管理模块
 *
 * 为所有工具动作提供类型安全的 scope 查询和检查功能。
 *
 * ## 三个核心概念
 *
 * ### 1. Required Scopes（API 需要的权限）
 * - 定义：每个 API 调用所需的飞书权限列表
 * - 来源：tool-scopes.ts（手动维护的类型化配置）
 * - 示例：`["calendar:calendar.event:create", "calendar:calendar.event:update"]`
 * - 用途：判断应用和用户是否需要申请/授权权限
 *
 * ### 2. App Granted Scopes（应用已开通的权限）
 * - 定义：应用在飞书开放平台配置并获得管理员批准的权限
 * - 来源：通过 API 查询 `/open-apis/application/v6/applications`
 * - 作用：应用级权限前置检查，避免无效的用户授权请求
 * - 检查时机：在请求用户授权前
 *
 * ### 3. User Granted Scopes（用户授权的权限）
 * - 定义：用户通过 OAuth 流程明确授权给应用的权限
 * - 来源：OAuth token 中的 scope 字段
 * - 作用：用户级权限检查，确保用户已授权所需权限
 * - 检查时机：每次 API 调用前
 *
 * ## 权限检查流程
 *
 * ```
 * 1. 获取 Required Scopes (API 需要什么权限？)
 *    ↓
 * 2. 检查 App Granted Scopes (应用开通了吗？)
 *    ↓ 是
 * 3. 检查 User Granted Scopes (用户授权了吗？)
 *    ↓ 是
 * 4. 调用 API
 * ```
 */

import { type ToolActionKey, type ToolScopeMapping, TOOL_SCOPES } from './tool-scopes';

// ===== 导出类型和数据 =====

export type { ToolActionKey, ToolScopeMapping };
export { TOOL_SCOPES };

// ===== 函数：Required Scopes（API 需要的权限）=====

/**
 * 获取单个工具动作所需的 scopes（Required Scopes）
 *
 * @param toolAction - 工具动作键（例如 "feishu_calendar_event.create"）
 * @returns API 需要的 scope 字符串数组
 *
 * @example
 * ```ts
 * const requiredScopes = getRequiredScopes("feishu_calendar_event.create");
 * // 返回: ["calendar:calendar.event:create", "calendar:calendar.event:update"]
 * ```
 */
export function getRequiredScopes(toolAction: ToolActionKey): string[] {
  return TOOL_SCOPES[toolAction] ?? [];
}

/**
 * 获取多个工具动作的合并 Required Scopes（去重）
 *
 * @param toolActions - 工具动作键数组
 * @returns 去重并排序后的 scope 字符串数组
 *
 * @example
 * ```ts
 * const requiredScopes = getRequiredScopesForActions([
 *   "feishu_calendar_event.create",
 *   "feishu_calendar_event.list"
 * ]);
 * // 返回两个动作的所有唯一 scopes
 * ```
 */
export function getRequiredScopesForActions(toolActions: ToolActionKey[]): string[] {
  const scopesSet = new Set<string>();

  for (const action of toolActions) {
    const scopes = getRequiredScopes(action);
    scopes.forEach((scope) => scopesSet.add(scope));
  }

  return Array.from(scopesSet).sort();
}

/**
 * 检查工具动作是否需要任何 scope
 *
 * @param toolAction - 工具动作键
 * @returns 如果动作需要至少一个 scope 则返回 true
 *
 * @example
 * ```ts
 * hasRequiredScopes("feishu_calendar_event.create"); // true
 * hasRequiredScopes("feishu_sheets_spreadsheet.create"); // false (空数组)
 * ```
 */
export function hasRequiredScopes(toolAction: ToolActionKey): boolean {
  return getRequiredScopes(toolAction).length > 0;
}

/**
 * 获取需要特定 scope 的所有工具动作
 *
 * @param scope - Scope 字符串（例如 "calendar:calendar.event:create"）
 * @returns 需要此 scope 的工具动作键数组
 *
 * @example
 * ```ts
 * const actions = getActionsForScope("calendar:calendar.event:create");
 * // 返回: ["feishu_calendar_event.create"]
 * ```
 */
export function getActionsForScope(scope: string): ToolActionKey[] {
  const actions: ToolActionKey[] = [];

  for (const [action, scopes] of Object.entries(TOOL_SCOPES)) {
    if (scopes.includes(scope)) {
      actions.push(action as ToolActionKey);
    }
  }

  return actions;
}

// ===== 函数：App Scope 检查 =====

/**
 * 检查应用是否开通了工具动作所需的所有权限（App Granted Scopes）
 *
 * @param toolAction - 工具动作键
 * @param appGrantedScopes - 应用已开通的 scope 集合（来自开放平台）
 * @returns 如果应用已开通所有必需的 scopes 则返回 true
 *
 * @example
 * ```ts
 * const appScopes = new Set([
 *   "calendar:calendar.event:create",
 *   "calendar:calendar.event:update"
 * ]);
 * checkAppScopes("feishu_calendar_event.create", appScopes); // true
 *
 * const partialAppScopes = new Set(["calendar:calendar.event:create"]);
 * checkAppScopes("feishu_calendar_event.create", partialAppScopes); // false
 * ```
 */
export function checkAppScopes(toolAction: ToolActionKey, appGrantedScopes: Set<string> | string[]): boolean {
  const requiredScopes = getRequiredScopes(toolAction);

  // 如果不需要任何 scope，则总是满足要求
  if (requiredScopes.length === 0) {
    return true;
  }

  const grantedSet = Array.isArray(appGrantedScopes) ? new Set(appGrantedScopes) : appGrantedScopes;

  return requiredScopes.every((scope) => grantedSet.has(scope));
}

/**
 * 获取应用未开通的 scopes
 *
 * @param toolAction - 工具动作键
 * @param appGrantedScopes - 应用已开通的 scope 集合
 * @returns 应用未开通的 scope 字符串数组
 *
 * @example
 * ```ts
 * const appScopes = new Set(["calendar:calendar.event:create"]);
 * const missing = getMissingAppScopes("feishu_calendar_event.create", appScopes);
 * // 返回: ["calendar:calendar.event:update"]
 * ```
 */
export function getMissingAppScopes(toolAction: ToolActionKey, appGrantedScopes: Set<string> | string[]): string[] {
  const requiredScopes = getRequiredScopes(toolAction);
  const grantedSet = Array.isArray(appGrantedScopes) ? new Set(appGrantedScopes) : appGrantedScopes;

  return requiredScopes.filter((scope) => !grantedSet.has(scope));
}

// ===== 函数：User Scope 检查 =====

/**
 * 检查用户是否授权了工具动作所需的所有权限（User Granted Scopes）
 *
 * @param toolAction - 工具动作键
 * @param userGrantedScopes - 用户已授权的 scope 集合（来自 OAuth token）
 * @returns 如果用户已授权所有必需的 scopes 则返回 true
 *
 * @example
 * ```ts
 * const userScopes = new Set([
 *   "calendar:calendar.event:create",
 *   "calendar:calendar.event:update"
 * ]);
 * checkUserScopes("feishu_calendar_event.create", userScopes); // true
 *
 * const partialUserScopes = new Set(["calendar:calendar.event:create"]);
 * checkUserScopes("feishu_calendar_event.create", partialUserScopes); // false
 * ```
 */
export function checkUserScopes(toolAction: ToolActionKey, userGrantedScopes: Set<string> | string[]): boolean {
  const requiredScopes = getRequiredScopes(toolAction);

  // 如果不需要任何 scope，则总是满足要求
  if (requiredScopes.length === 0) {
    return true;
  }

  const grantedSet = Array.isArray(userGrantedScopes) ? new Set(userGrantedScopes) : userGrantedScopes;

  return requiredScopes.every((scope) => grantedSet.has(scope));
}

/**
 * 获取用户未授权的 scopes
 *
 * @param toolAction - 工具动作键
 * @param userGrantedScopes - 用户已授权的 scope 集合
 * @returns 用户未授权的 scope 字符串数组
 *
 * @example
 * ```ts
 * const userScopes = new Set(["calendar:calendar.event:create"]);
 * const missing = getMissingUserScopes("feishu_calendar_event.create", userScopes);
 * // 返回: ["calendar:calendar.event:update"]
 * ```
 */
export function getMissingUserScopes(toolAction: ToolActionKey, userGrantedScopes: Set<string> | string[]): string[] {
  const requiredScopes = getRequiredScopes(toolAction);
  const grantedSet = Array.isArray(userGrantedScopes) ? new Set(userGrantedScopes) : userGrantedScopes;

  return requiredScopes.filter((scope) => !grantedSet.has(scope));
}
