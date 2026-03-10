/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * 应用所有者查询 — 复用 app-scope-checker 的 API 调用和统一 owner 定义。
 *
 * 所有 owner 判定统一使用 {@link getAppInfo} 返回的 `effectiveOwnerOpenId`。
 * 不维护独立缓存，完全依赖 app-scope-checker 的 30s 缓存。
 */

import type { ConfiguredLarkAccount } from './types';
import { getAppInfo } from './app-scope-checker';
import { larkLogger } from './lark-logger';

const log = larkLogger('core/app-owner-fallback');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 获取应用的 effectiveOwnerOpenId。
 *
 * 复用 app-scope-checker 的 API 调用、缓存和统一 owner 定义（effectiveOwnerOpenId）。
 * 查询失败时返回 undefined（fail-open）。
 *
 * @param account - 已配置的飞书账号信息
 * @param sdk - 飞书 SDK 实例（必须已初始化 TAT）
 * @returns 应用所有者的 open_id，如果查询失败则返回 undefined
 */
export async function getAppOwnerFallback(
  account: ConfiguredLarkAccount,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sdk: any,
): Promise<string | undefined> {
  const { appId } = account;

  try {
    const appInfo = await getAppInfo(sdk, appId);
    return appInfo.effectiveOwnerOpenId;
  } catch (err) {
    log.warn(`failed to get owner for ${appId}: ${err instanceof Error ? err.message : err}`);
    return undefined; // fail-open: 获取失败不阻塞业务
  }
}
