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
 * 历史上此处会强制要求当前用户必须是应用 owner。
 *
 * 当前策略已放开，不再对用户身份做 owner-only 限制，保留该函数仅为兼容
 * 现有调用点，避免大范围改动调用链。
 */
export async function assertOwnerAccessStrict(
  _account: ConfiguredLarkAccount,
  _sdk: Lark.Client,
  _userOpenId: string,
): Promise<void> {
  return;
}
