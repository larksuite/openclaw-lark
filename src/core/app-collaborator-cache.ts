/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * app-collaborator-cache.ts — 飞书应用协作者角色缓存。
 *
 * 数据来源：GET /open-apis/application/v6/applications/:app_id/collaborators
 * 官方角色枚举：administrator / developer / operator（不含 owner）。
 *
 * 两层缓存：
 *   1. 进程内热缓存（Map，TTL 1 分钟，负缓存 60 秒）
 *   2. 状态目录快照（<stateDir>/feishu/accounts/<accountId>/role-cache.json）
 *
 * 设计约束：
 *   - singleflight：同一 accountId + appId 的并发刷新共享一个 in-flight promise
 *   - maxStaleMs：快照最大陈旧期 30 分钟，超时后不再使用旧数据
 */

import * as Lark from '@larksuiteoapi/node-sdk';
import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { larkLogger } from './lark-logger';
import type { UatConfigurableRole } from './uat-policy';

const log = larkLogger('core/app-collaborator-cache');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 协作者 open_id → 角色映射。 */
export type CollaboratorMap = Map<string, UatConfigurableRole>;

/** 磁盘快照格式。 */
interface RoleCacheSnapshot {
  version: 1;
  appId: string;
  fetchedAt: number;
  collaborators: Record<string, string>;
}

interface MemoryCacheEntry {
  data: CollaboratorMap;
  fetchedAt: number;
  isNegative: boolean;
  nextRetryAt?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MEMORY_TTL_MS = 60 * 1000;           // 热缓存 1 分钟
const NEGATIVE_CACHE_TTL_MS = 60 * 1000;   // 失败负缓存 60 秒
const MAX_STALE_MS = 30 * 60 * 1000;       // 快照最大陈旧期 30 分钟

/** 飞书协作者接口返回的角色字符串 → 内部角色映射。 */
const API_ROLE_MAP: Record<string, UatConfigurableRole> = {
  administrator: 'administrator',
  developer: 'developer',
  operator: 'operator',
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const memoryCache = new Map<string, MemoryCacheEntry>();
const inflight = new Map<string, Promise<CollaboratorMap>>();

function buildCacheKey(accountId: string, appId: string): string {
  return `${accountId}:${appId}`;
}

function getUsableStaleEntry(cacheKey: string, now: number = Date.now()): MemoryCacheEntry | null {
  const cached = memoryCache.get(cacheKey);
  if (!cached || cached.isNegative) {
    return null;
  }
  return now - cached.fetchedAt < MAX_STALE_MS ? cached : null;
}

// ---------------------------------------------------------------------------
// Disk snapshot helpers
// ---------------------------------------------------------------------------

function snapshotPath(stateDir: string, accountId: string): string {
  return join(stateDir, 'feishu', 'accounts', accountId, 'role-cache.json');
}

async function readSnapshot(stateDir: string, accountId: string): Promise<RoleCacheSnapshot | null> {
  try {
    const raw = await readFile(snapshotPath(stateDir, accountId), 'utf-8');
    const parsed = JSON.parse(raw) as RoleCacheSnapshot;
    if (parsed?.version !== 1 || typeof parsed.fetchedAt !== 'number' || !parsed.collaborators) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeSnapshot(stateDir: string, accountId: string, appId: string, data: CollaboratorMap): Promise<void> {
  const filePath = snapshotPath(stateDir, accountId);
  const dir = join(filePath, '..');
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const payload: RoleCacheSnapshot = {
      version: 1,
      appId,
      fetchedAt: Date.now(),
      collaborators: Object.fromEntries(data),
    };
    // 先写临时文件再 rename 以实现原子写入
    const tmpPath = filePath + '.tmp';
    await writeFile(tmpPath, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
    const { rename } = await import('node:fs/promises');
    await rename(tmpPath, filePath);
  } catch (err) {
    log.warn(`failed to write role-cache snapshot: ${err instanceof Error ? err.message : err}`);
  }
}

// ---------------------------------------------------------------------------
// API fetch
// ---------------------------------------------------------------------------

async function fetchCollaboratorsFromApi(sdk: Lark.Client, appId: string): Promise<CollaboratorMap> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await (sdk as any).request({
    method: 'GET',
    url: `/open-apis/application/v6/applications/${appId}/collaborators`,
    params: {
      user_id_type: 'open_id',
    },
  });

  if (res.code !== 0) {
    throw new Error(`collaborator API error: code=${res.code}, msg=${res.msg}`);
  }

  const result: CollaboratorMap = new Map();
  const items: Array<{ user_id?: string; type?: string }> = res.data?.collaborators ?? res.data?.items ?? [];
  for (const item of items) {
    const openId = item.user_id;
    const role = API_ROLE_MAP[item.type ?? ''];
    if (openId && role) {
      result.set(openId, role);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Singleflight fetch + cache update
// ---------------------------------------------------------------------------

async function doFetch(
  cacheKey: string,
  accountId: string,
  appId: string,
  sdk: Lark.Client,
  stateDir?: string,
): Promise<CollaboratorMap> {
  try {
    const data = await fetchCollaboratorsFromApi(sdk, appId);
    // 更新内存缓存
    memoryCache.set(cacheKey, { data, fetchedAt: Date.now(), isNegative: false, nextRetryAt: undefined });
    // 后台写盘（不阻塞返回）
    if (stateDir) {
      writeSnapshot(stateDir, accountId, appId, data).catch(() => {});
    }
    log.info(`fetched ${data.size} collaborators for account ${accountId}`);
    return data;
  } catch (err) {
    log.warn(`failed to fetch collaborators for ${accountId}: ${err instanceof Error ? err.message : err}`);
    // 有正缓存时保留旧数据，并设置短暂退避窗口，避免持续重试打爆低限流接口。
    const existing = memoryCache.get(cacheKey);
    if (existing && !existing.isNegative) {
      memoryCache.set(cacheKey, {
        data: existing.data,
        fetchedAt: existing.fetchedAt,
        isNegative: false,
        nextRetryAt: Date.now() + NEGATIVE_CACHE_TTL_MS,
      });
    } else {
      memoryCache.set(cacheKey, {
        data: new Map(),
        fetchedAt: Date.now(),
        isNegative: true,
        nextRetryAt: Date.now() + NEGATIVE_CACHE_TTL_MS,
      });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 获取应用协作者角色映射。
 *
 * 优先级：内存热缓存 → 磁盘快照 → 远端 API。
 * 并发请求通过 singleflight 去重，避免限流击穿。
 *
 * @returns 协作者 open_id → 角色映射（不含 owner）
 * @throws 当远端 API 不可用且无可用缓存/快照时抛出
 */
export async function getCollaboratorRoles(params: {
  accountId: string;
  appId: string;
  sdk: Lark.Client;
  stateDir?: string;
}): Promise<CollaboratorMap> {
  const { accountId, appId, sdk, stateDir } = params;
  const now = Date.now();
  const cacheKey = buildCacheKey(accountId, appId);

  // 1. 检查内存热缓存
  const cached = memoryCache.get(cacheKey);
  if (cached) {
    const age = now - cached.fetchedAt;
    if (cached.isNegative) {
      // 负缓存：60 秒内不重试
      if ((cached.nextRetryAt ?? cached.fetchedAt + NEGATIVE_CACHE_TTL_MS) > now) {
        throw new Error('collaborator lookup recently failed (negative cache)');
      }
    } else if (age < MEMORY_TTL_MS) {
      return cached.data;
    } else if ((cached.nextRetryAt ?? 0) > now && age < MAX_STALE_MS) {
      log.warn(`using stale cache during retry cooldown for ${accountId}`);
      return cached.data;
    }
  }

  // 2. 尝试 singleflight 去重
  const existing = inflight.get(cacheKey);
  if (existing) {
    try {
      return await existing;
    } catch (err) {
      const stale = getUsableStaleEntry(cacheKey);
      if (stale) {
        log.warn(`using stale cache after shared refresh failure for ${accountId}`);
        return stale.data;
      }
      throw err;
    }
  }

  // 3. 内存缓存过期，先尝试磁盘快照（lazy hydrate）
  if (!cached && stateDir) {
    const snapshot = await readSnapshot(stateDir, accountId);
    if (snapshot && snapshot.appId === appId) {
      const snapshotAge = now - snapshot.fetchedAt;
      if (snapshotAge < MAX_STALE_MS) {
        // 快照仍在陈旧期内，加载到内存并后台刷新
        const data: CollaboratorMap = new Map(
          Object.entries(snapshot.collaborators).filter(
            ([, role]) => role === 'administrator' || role === 'developer' || role === 'operator',
          ) as Array<[string, UatConfigurableRole]>,
        );
        memoryCache.set(cacheKey, { data, fetchedAt: snapshot.fetchedAt, isNegative: false, nextRetryAt: undefined });

        // 后台刷新（不阻塞当前请求）
        const bgPromise = doFetch(cacheKey, accountId, appId, sdk, stateDir).finally(() => inflight.delete(cacheKey));
        inflight.set(cacheKey, bgPromise);
        bgPromise.catch(() => {}); // 不让后台失败影响当前返回

        return data;
      }
      // 快照超出最大陈旧期，不使用
    }
  }

  // 4. 发起远端请求（singleflight）
  const promise = doFetch(cacheKey, accountId, appId, sdk, stateDir).finally(() => inflight.delete(cacheKey));
  inflight.set(cacheKey, promise);

  try {
    return await promise;
  } catch (err) {
    // 远端失败，检查是否有未过期的内存缓存可用（可能是上次成功加载的快照）
    const fallback = getUsableStaleEntry(cacheKey, now);
    if (fallback) {
      log.warn(`using stale cache for ${accountId} (${Math.round((now - fallback.fetchedAt) / 1000)}s old)`);
      return fallback.data;
    }
    throw err;
  }
}

/**
 * 查询指定用户在协作者缓存中的角色。
 *
 * @returns 角色名，不在协作者列表中返回 'normal'
 */
export function getCollaboratorRole(collaborators: CollaboratorMap, userOpenId: string): UatConfigurableRole {
  return collaborators.get(userOpenId) ?? 'normal';
}

/**
 * 清除指定账号或所有账号的内存缓存。
 * 不删除磁盘快照（保留跨重启恢复价值）。
 */
export function clearCollaboratorCache(accountId?: string): void {
  if (accountId !== undefined) {
    const prefix = `${accountId}:`;
    for (const key of memoryCache.keys()) {
      if (key.startsWith(prefix)) {
        memoryCache.delete(key);
      }
    }
    for (const key of inflight.keys()) {
      if (key.startsWith(prefix)) {
        inflight.delete(key);
      }
    }
  } else {
    memoryCache.clear();
    inflight.clear();
  }
}
