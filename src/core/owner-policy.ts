/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * owner-policy.ts — 应用 Owner 访问控制策略。
 *
 * 从 uat-client.ts 迁移 owner 检查逻辑到独立 policy 层。
 * 提供可配置的 fail-close 策略（安全优先：授权发起路径）。
 */

import type { ConfiguredLarkAccount, FeishuAccountConfig } from './types';
import { getAppOwnerFallback } from './app-owner-fallback';

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * 非应用 owner 尝试执行 owner-only 操作时抛出。
 *
 * 注意：`appOwnerId` 仅用于内部日志，不应序列化到用户可见的响应中，
 * 以避免泄露 owner 的 open_id。
 */
export class OwnerAccessDeniedError extends Error {
  readonly userOpenId: string;
  readonly appOwnerId: string;

  constructor(userOpenId: string, appOwnerId: string) {
    super('Permission denied: Only the app owner is authorized to use this feature.');
    this.name = 'OwnerAccessDeniedError';
    this.userOpenId = userOpenId;
    this.appOwnerId = appOwnerId;
  }
}

// ---------------------------------------------------------------------------
// Policy functions
// ---------------------------------------------------------------------------

/**
 * 是否启用“仅 App Owner 可发起用户授权 / 使用用户态能力”策略。
 *
 * 默认值为 true，保持当前安全策略不变；仅当配置显式设为 false 时关闭。
 */
export function isOwnerOnlyUserAuthEnabled(
  config: Pick<FeishuAccountConfig, 'ownerOnlyUserAuth'> | undefined,
): boolean {
  return config?.ownerOnlyUserAuth !== false;
}

/**
 * 校验用户是否为应用 owner（fail-close 版本）。
 *
 * - 当 `ownerOnlyUserAuth=false` 时 → 直接放行
 * - 获取 owner 失败时 → 拒绝（安全优先）
 * - owner 不匹配时 → 拒绝
 *
 * 适用于：`executeAuthorize`（OAuth 授权发起）、`commands/auth.ts`（批量授权）等
 * 赋予实质性权限的入口。
 */
export async function assertOwnerAccessStrict(
  account: ConfiguredLarkAccount,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sdk: any,
  userOpenId: string,
): Promise<void> {
  if (!isOwnerOnlyUserAuthEnabled(account.config)) {
    return;
  }

  const ownerOpenId = await getAppOwnerFallback(account, sdk);

  if (!ownerOpenId) {
    throw new OwnerAccessDeniedError(userOpenId, 'unknown');
  }

  if (ownerOpenId !== userOpenId) {
    throw new OwnerAccessDeniedError(userOpenId, ownerOpenId);
  }
}
