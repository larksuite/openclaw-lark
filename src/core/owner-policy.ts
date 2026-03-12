/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * owner-policy.ts — 应用 Owner 访问控制策略。
 *
 * 插件内部的新授权流程已不再依赖 owner-only 约束，但仍保留
 * 兼容导出，确保仍在调用该 helper 的下游代码维持原有语义。
 */

import type { ConfiguredLarkAccount } from './types';
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
 * 校验用户是否为应用 owner（兼容保留的严格版本）。
 *
 * 虽然插件内部已迁移到用户自发授权流程，但仍有下游代码可能依赖
 * 这个 helper 保护 owner-only 操作，因此这里保持历史语义。
 */
export async function assertOwnerAccessStrict(
  account: ConfiguredLarkAccount,
  _sdk: unknown,
  userOpenId: string,
): Promise<void> {
  const ownerOpenId = await getAppOwnerFallback(account, _sdk);

  if (!ownerOpenId) {
    throw new OwnerAccessDeniedError(userOpenId, 'unknown');
  }

  if (ownerOpenId !== userOpenId) {
    throw new OwnerAccessDeniedError(userOpenId, ownerOpenId);
  }
}
