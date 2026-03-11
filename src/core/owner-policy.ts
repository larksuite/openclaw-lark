/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * owner-policy.ts — 历史上的应用 Owner 访问控制策略。
 *
 * 当前插件已放开 owner-only 限制；本文件仅保留兼容导出，
 * 避免下游旧代码 import 时报错。
 */

import type { ConfiguredLarkAccount } from './types';

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * 兼容保留：历史上用于表示 owner-only 访问被拒绝。
 *
 * 当前版本已不再抛出该错误。
 */
export class OwnerAccessDeniedError extends Error {
  readonly userOpenId: string;
  readonly appOwnerId: string;

  constructor(userOpenId: string, appOwnerId: string) {
    super('Owner-only access control is disabled.');
    this.name = 'OwnerAccessDeniedError';
    this.userOpenId = userOpenId;
    this.appOwnerId = appOwnerId;
  }
}

// ---------------------------------------------------------------------------
// Policy functions
// ---------------------------------------------------------------------------

/**
 * 兼容保留：当前版本不再启用 owner-only 校验。
 */
export async function assertOwnerAccessStrict(
  _account: ConfiguredLarkAccount,
  _sdk: unknown,
  _userOpenId: string,
): Promise<void> {
  return;
}
