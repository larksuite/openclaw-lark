/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * owner-policy.ts — 应用 Owner 访问控制策略。
 *
 * 从 uat-client.ts 迁移 owner 检查逻辑到独立 policy 层。
 * 提供 fail-close 策略（安全优先：授权发起路径）。
 */

import type * as Lark from '@larksuiteoapi/node-sdk';
import type { ConfiguredLarkAccount } from './types';
import { getAppOwnerFallback } from './app-owner-fallback';
import { larkLogger } from './lark-logger';

const log = larkLogger('core/owner-policy');

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export type OwnerAccessDeniedReason = 'strict' | 'not_in_allowlist';

/**
 * 非应用 owner 尝试执行 owner-only 操作时抛出。
 *
 * 注意：`appOwnerId` 仅用于内部日志，不应序列化到用户可见的响应中，
 * 以避免泄露 owner 的 open_id。
 */
export class OwnerAccessDeniedError extends Error {
  readonly userOpenId: string;
  readonly appOwnerId: string;
  readonly reason: OwnerAccessDeniedReason;

  constructor(userOpenId: string, appOwnerId: string, reason: OwnerAccessDeniedReason = 'strict') {
    super('Permission denied: Only the app owner is authorized to use this feature.');
    this.name = 'OwnerAccessDeniedError';
    this.userOpenId = userOpenId;
    this.appOwnerId = appOwnerId;
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Policy functions
// ---------------------------------------------------------------------------

/**
 * 校验用户是否为应用 owner（fail-close 版本）。
 *
 * - 获取 owner 失败时 → 拒绝（安全优先）
 * - owner 不匹配时 → 拒绝
 *
 * 适用于：`executeAuthorize`（OAuth 授权发起）、`commands/auth.ts`（批量授权）等
 * 赋予实质性权限的入口。
 */
export async function assertOwnerAccessStrict(
  account: ConfiguredLarkAccount,
  sdk: Lark.Client,
  userOpenId: string,
): Promise<void> {
  const ownerOnly = account.config.uat?.ownerOnly ?? true;
  const allowedUsers = new Set((account.config.uat?.allowedUsers ?? []).map((entry) => entry.trim()).filter(Boolean));

  if (!ownerOnly && allowedUsers.size === 0) {
    return;
  }

  const ownerOpenId = await getAppOwnerFallback(account, sdk);

  if (!ownerOpenId) {
    if (!ownerOnly && allowedUsers.has(userOpenId)) {
      log.warn(`allowing non-owner user ${userOpenId} for account ${account.accountId} via uat.allowedUsers without owner lookup`);
      return;
    }

    throw new OwnerAccessDeniedError(userOpenId, 'unknown', ownerOnly ? 'strict' : 'not_in_allowlist');
  }

  if (ownerOpenId === userOpenId) {
    return;
  }

  if (!ownerOnly && allowedUsers.has(userOpenId)) {
    log.warn(`allowing non-owner user ${userOpenId} for account ${account.accountId} via uat.allowedUsers`);
    return;
  }

  throw new OwnerAccessDeniedError(userOpenId, ownerOpenId, ownerOnly ? 'strict' : 'not_in_allowlist');
}
