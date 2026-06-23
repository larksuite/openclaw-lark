/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * owner-policy.ts — 应用 Owner 访问控制策略。
 *
 * 从 uat-client.ts 迁移 owner 检查逻辑到独立 policy 层。
 * 提供 fail-close 策略（安全优先：授权发起路径）。
 *
 * 支持通过配置 `uat.allowedUsers` 白名单，让非 owner 用户也能使用 API 功能。
 */

import type * as Lark from '@larksuiteoapi/node-sdk';
import type { ConfiguredLarkAccount } from './types';
import { getAppOwnerFallback } from './app-owner-fallback';
import { larkLogger } from './lark-logger';

const log = larkLogger('core/owner-policy');

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
 * 检查用户是否在 `uat.allowedUsers` 白名单中。
 *
 * - 白名单包含 `"*"` 时，允许所有用户
 * - 白名单包含该用户的 open_id 时，允许该用户
 */
function isUserAllowlisted(account: ConfiguredLarkAccount, userOpenId: string): boolean {
  const allowedUsers = account.config.uat?.allowedUsers;
  if (!allowedUsers || allowedUsers.length === 0) return false;
  return allowedUsers.includes('*') || allowedUsers.includes(userOpenId);
}

/**
 * 校验用户是否为应用 owner 或在白名单中（fail-close 版本）。
 *
 * 检查顺序：
 * 1. 白名单（`uat.allowedUsers`）— 包含 `"*"` 时允许所有用户
 * 2. Owner 匹配 — 获取 owner 失败或不匹配时拒绝
 *
 * 适用于：`executeAuthorize`（OAuth 授权发起）、`commands/auth.ts`（批量授权）等
 * 赋予实质性权限的入口。
 */
export async function assertOwnerAccessStrict(
  account: ConfiguredLarkAccount,
  sdk: Lark.Client,
  userOpenId: string,
): Promise<void> {
  if (isUserAllowlisted(account, userOpenId)) {
    log.info(`user ${userOpenId} granted access via uat.allowedUsers allowlist`);
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
