/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * App Scope Checker — 查询应用已开通的 scope 列表。
 *
 * 通过 `GET /open-apis/application/v6/applications/:app_id` (TAT) 获取
 * 应用信息，从 `app.scopes` 中提取已开通的 scope 字符串列表。
 *
 * 结果带 30 秒内存缓存，避免每次 invoke() 都调远程 API。
 * scope 检查失败后可调 {@link invalidateAppScopeCache} 清缓存重查。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type * as Lark from '@larksuiteoapi/node-sdk';
import { larkLogger } from './lark-logger';

const log = larkLogger('core/app-scope-checker');
import { AppScopeCheckFailedError } from './auth-errors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppInfo {
  appId: string;
  creatorId?: string; // ou_xxx
  ownerOpenId?: string; // owner.owner_id (ou_xxx)（原样保留，兼容性）
  ownerType?: number; // 0=飞书科技, 1=合作伙伴, 2=企业内成员（原样保留，兼容性）
  /**
   * 统一的 owner 判定结果。所有需要判定"谁是应用 owner"的场景都应使用此字段。
   *
   * 规则：owner_type=2（企业内成员）时取 owner_id，否则回退 creator_id。
   * 兼容 owner.owner_type 和 owner.type 两种字段名。
   */
  effectiveOwnerOpenId?: string;
  scopes: Array<{ scope: string; token_types?: string[] }>;
}

interface CacheEntry {
  rawScopes: Array<{ scope: string; token_types?: string[] }>;
  rawApp?: Record<string, unknown>;
  fetchedAt: number;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30 * 1000; // 30 秒

/** 清除指定 appId 的缓存。 */
export function invalidateAppScopeCache(appId: string): void {
  cache.delete(appId);
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * 获取应用已开通的 scope 列表。
 *
 * 需要应用自身有 `application:application:self_manage` 权限。
 * `appId` 可传 `"me"` 查自己。
 *
 * @param sdk - Lark SDK 实例
 * @param appId - 应用 ID
 * @param tokenType - token 类型，用于过滤只支持特定 token 类型的 scope
 * @returns scope 字符串数组，如 `["calendar:calendar", "task:task:write"]`
 */
export async function getAppGrantedScopes(
  sdk: Lark.Client,
  appId: string,
  tokenType?: 'user' | 'tenant',
): Promise<string[]> {
  // 1. 检查缓存
  const cached = cache.get(appId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    // 从缓存中过滤出支持当前 token 类型的 scope
    return cached.rawScopes
      .filter((s) => {
        if (tokenType && s.token_types && Array.isArray(s.token_types)) {
          return s.token_types.includes(tokenType);
        }
        return true;
      })
      .map((s) => s.scope);
  }

  // 2. 调用 API
  try {
    const res = await (sdk as any).request({
      method: 'GET',
      url: `/open-apis/application/v6/applications/${appId}`,
      params: { lang: 'zh_cn' },
    });

    if (res.code !== 0) {
      // 任何 API 错误都认为是应用缺少 application:application:self_manage 权限
      throw new AppScopeCheckFailedError(appId);
    }

    // 响应结构: res.data.app.scopes → [{ scope: "xxx", description, level, token_types?: string[] }]
    // 或者从 app_version 中获取 scopes
    const app = res.data?.app ?? res.app ?? res.data;
    const rawScopes: Array<{ scope?: string; token_types?: string[] }> =
      app?.scopes ?? app?.online_version?.scopes ?? [];

    // 提取并验证 scope 字符串
    const validScopes = rawScopes
      .filter((s) => typeof s.scope === 'string' && s.scope.length > 0)
      .map((s) => ({ scope: s.scope!, token_types: s.token_types }));

    // 3. 写缓存（缓存完整数据，包含 token_types 和原始 app 对象）
    cache.set(appId, { rawScopes: validScopes, rawApp: app, fetchedAt: Date.now() });
    log.info(`fetched ${validScopes.length} scopes for app ${appId}`);

    // 4. 根据 tokenType 过滤
    const scopes = validScopes
      .filter((s) => {
        if (tokenType && s.token_types && Array.isArray(s.token_types)) {
          return s.token_types.includes(tokenType);
        }
        return true;
      })
      .map((s) => s.scope);

    log.info(`returning ${scopes.length} scopes${tokenType ? ` for ${tokenType} token` : ''}`);

    return scopes;
  } catch (err) {
    // 如果是 AppScopeCheckFailedError，重新抛出（不吞掉）
    if (err instanceof AppScopeCheckFailedError) {
      throw err;
    }

    // 检查是否是权限相关的 HTTP 错误（400/403）
    // axios/SDK 异常对象通常包含 response.status 或 status 字段
    const statusCode = (err as any)?.response?.status || (err as any)?.status || (err as any)?.statusCode;

    const isPermissionError =
      statusCode === 400 ||
      statusCode === 403 ||
      (err instanceof Error && (err.message.includes('status code 400') || err.message.includes('status code 403')));

    if (isPermissionError) {
      throw new AppScopeCheckFailedError(appId);
    }

    log.warn(`failed to fetch scopes for ${appId}: ${err instanceof Error ? err.message : err}`);
    // 其他查询失败不阻塞调用，返回空数组（后续 API 调用如果缺 scope 会被服务端拒绝）
    return [];
  }
}

// ---------------------------------------------------------------------------
// App info
// ---------------------------------------------------------------------------

/**
 * 获取应用信息，包括 owner 信息。
 *
 * 复用 getAppGrantedScopes 的 API 调用和缓存。
 * 如果缓存中已有数据且未过期，直接从缓存提取。
 *
 * @param sdk - Lark SDK 实例
 * @param appId - 应用 ID（可传 "me"）
 */
export async function getAppInfo(sdk: Lark.Client, appId: string): Promise<AppInfo> {
  // 先确保缓存已填充（调一次 getAppGrantedScopes 来触发 API + 缓存）
  await getAppGrantedScopes(sdk, appId);

  const cached = cache.get(appId);
  const rawApp = cached?.rawApp as Record<string, unknown> | undefined;

  // 提取 owner 信息
  const owner = rawApp?.owner as
    | { owner_id?: string; owner_type?: number; type?: number; owner_id_type?: string }
    | undefined;
  const creatorId = rawApp?.creator_id as string | undefined;

  // 统一 owner 定义：type=2（企业内成员）用 owner_id，否则回退 creator_id
  // 兼容两种字段名（owner_type 和 type）
  const ownerTypeValue = owner?.owner_type ?? (owner as any)?.type;
  const effectiveOwnerOpenId =
    ownerTypeValue === 2 && owner?.owner_id ? owner.owner_id : (creatorId ?? owner?.owner_id);

  return {
    appId,
    creatorId,
    ownerOpenId: owner?.owner_id,
    ownerType: owner?.owner_type,
    effectiveOwnerOpenId,
    scopes: cached?.rawScopes ?? [],
  };
}

// ---------------------------------------------------------------------------
// Scope intersection
// ---------------------------------------------------------------------------

/**
 * 计算 APP 已有 ∩ OAPI 需要 的交集。
 *
 * 用于传给 OAuth 的 scope 参数 — 只请求 APP 已开通且 API 需要的 scope。
 *
 * @param appGranted - 应用已开通的 scope 列表
 * @param apiRequired - OAPI 要求的 scope 列表
 * @returns 交集 scope 列表
 */
export function intersectScopes(appGranted: string[], apiRequired: string[]): string[] {
  const grantedSet = new Set(appGranted);
  return apiRequired.filter((s) => grantedSet.has(s));
}

/**
 * 计算 OAPI 需要但 APP 未开通的 scope（差集）。
 *
 * 用于 AppScopeMissingError 的 missingScopes。
 *
 * @param appGranted - 应用已开通的 scope 列表
 * @param apiRequired - OAPI 要求的 scope 列表
 * @returns 缺失的 scope 列表
 */
export function missingScopes(appGranted: string[], apiRequired: string[]): string[] {
  const grantedSet = new Set(appGranted);
  return apiRequired.filter((s) => !grantedSet.has(s));
}

/**
 * 校验应用已开通的 scope 是否满足要求。
 *
 * 与 tool-client.ts invoke() 的 scope 校验逻辑完全一致，作为唯一真值来源：
 *   - `scopeNeedType === "all"`: appScopes 必须包含 requiredScopes 的全部项
 *   - 其他（默认 "one"）:        appScopes 与 requiredScopes 的交集非空即可
 *   - appScopes 为空:            视为满足（API 查询失败，退回服务端判断）
 *
 * @param appScopes      - 应用已开通的 scope 列表（由 getAppGrantedScopes 返回）
 * @param requiredScopes - 需要的 scope 列表
 * @param scopeNeedType  - "all" 表示全部必须，undefined/"one" 表示任一即可
 */
export function isAppScopeSatisfied(
  appScopes: string[],
  requiredScopes: string[],
  scopeNeedType?: 'one' | 'all',
): boolean {
  if (appScopes.length === 0) return true; // API 查询失败 → 退回服务端判断
  if (requiredScopes.length === 0) return true;
  if (scopeNeedType === 'all') {
    return missingScopes(appScopes, requiredScopes).length === 0;
  }
  return intersectScopes(appScopes, requiredScopes).length > 0;
}
