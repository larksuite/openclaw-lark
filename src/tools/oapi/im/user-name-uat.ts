/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * UAT 用户名解析模块
 *
 * 独立于 messaging/inbound 层的 TAT UserNameCache，
 * 用于工具层以用户身份（UAT）批量解析用户显示名。
 *
 * 设计动机：TAT 调用 contact/v3/users/batch 缺少权限导致返回的用户
 * 条目不含 name 字段，而工具层搜索消息等场景运行在 UAT 上下文中，
 * 用户 token 可以读取其他用户的名称。
 */

import type { ToolClient } from '../../../core/tool-client';
import { isInvokeError } from '../helpers';

// ---------------------------------------------------------------------------
// 独立缓存：accountId → Map<openId, { name, expireAt }>
// ---------------------------------------------------------------------------

const UAT_MAX_SIZE = 500;
const UAT_TTL_MS = 30 * 60 * 1000; // 30 分钟

interface CacheEntry {
  name: string;
  expireAt: number;
}

const uatRegistry = new Map<string, Map<string, CacheEntry>>();

function getOrCreateCache(accountId: string): Map<string, CacheEntry> {
  let cache = uatRegistry.get(accountId);
  if (!cache) {
    cache = new Map();
    uatRegistry.set(accountId, cache);
  }
  return cache;
}

function evict(cache: Map<string, CacheEntry>): void {
  while (cache.size > UAT_MAX_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** 从 UAT 缓存中获取用户名 */
export function getUATUserName(accountId: string, openId: string): string | undefined {
  const cache = uatRegistry.get(accountId);
  if (!cache) return undefined;
  const entry = cache.get(openId);
  if (!entry) return undefined;
  if (entry.expireAt <= Date.now()) {
    cache.delete(openId);
    return undefined;
  }
  // LRU refresh
  cache.delete(openId);
  cache.set(openId, entry);
  return entry.name;
}

/** 批量写入 UAT 缓存 */
export function setUATUserNames(accountId: string, entries: Map<string, string>): void {
  const cache = getOrCreateCache(accountId);
  const now = Date.now();
  for (const [openId, name] of entries) {
    cache.delete(openId);
    cache.set(openId, { name, expireAt: now + UAT_TTL_MS });
  }
  evict(cache);
}

// ---------------------------------------------------------------------------
// 以 UAT 身份批量解析用户名
// ---------------------------------------------------------------------------

const BATCH_SIZE = 50;

export async function batchResolveUserNamesAsUser(params: {
  client: ToolClient;
  openIds: string[];
  log: (...args: unknown[]) => void;
}): Promise<Map<string, string>> {
  const { client, openIds, log } = params;
  if (openIds.length === 0) return new Map();

  const accountId = client.account.accountId;
  const cache = getOrCreateCache(accountId);
  const result = new Map<string, string>();
  const now = Date.now();

  // 1. 从缓存读取已有的
  const missing: string[] = [];
  for (const id of openIds) {
    const entry = cache.get(id);
    if (entry && entry.expireAt > now) {
      result.set(id, entry.name);
    } else {
      if (entry) cache.delete(id);
      missing.push(id);
    }
  }

  // 去重
  const uniqueMissing = [...new Set(missing)];
  if (uniqueMissing.length === 0) return result;

  // 2. 分批通过 SDK 调用 contact/v3/users/batch（UAT）
  for (let i = 0; i < uniqueMissing.length; i += BATCH_SIZE) {
    const chunk = uniqueMissing.slice(i, i + BATCH_SIZE);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await client.invoke(
        'feishu_get_user.default', // 注：实际调用 batch API，共享 get_user 的 scope
        (sdk, opts) =>
          sdk.contact.user.batch(
            {
              params: {
                user_ids: chunk,
                user_id_type: 'open_id',
              },
            },
            opts,
          ),
        {
          as: 'user',
        },
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items: any[] = res?.data?.items ?? [];
      for (const item of items) {
        const openId: string | undefined = item.open_id;
        const name: string | undefined = item.name || item.display_name || item.nickname || item.en_name;
        if (openId && name) {
          cache.delete(openId);
          cache.set(openId, { name, expireAt: Date.now() + UAT_TTL_MS });
          result.set(openId, name);
        }
      }
    } catch (err) {
      // 授权/权限错误向上冒泡，由上层 handleInvokeErrorWithAutoAuth 处理自动授权
      if (isInvokeError(err)) throw err;
      log(`batchResolveUserNamesAsUser: failed: ${String(err)}`);
    }
  }

  evict(cache);
  return result;
}
