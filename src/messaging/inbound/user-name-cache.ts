/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Account-scoped LRU cache for Feishu user display names.
 *
 * Provides:
 * - `UserNameCache` — per-account LRU Map with TTL
 * - `getUserNameCache(accountId)` — singleton registry
 * - `batchResolveUserNames()` — batch API via `contact/v3/users/batch`
 * - `resolveUserName()` — single-user fallback via `contact.user.get`
 * - `clearUserNameCache()` — teardown hook (called from LarkClient.clearCache)
 */

import type { LarkAccount } from '../../core/types';
import { LarkClient } from '../../core/lark-client';
import { extractPermissionError, type PermissionError } from './permission';

// ---------------------------------------------------------------------------
// UserNameCache
// ---------------------------------------------------------------------------

const DEFAULT_MAX_SIZE = 500;
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface CacheEntry {
  name: string;
  expireAt: number;
}

export class UserNameCache {
  private map = new Map<string, CacheEntry>();
  private maxSize: number;
  private ttlMs: number;

  constructor(maxSize = DEFAULT_MAX_SIZE, ttlMs = DEFAULT_TTL_MS) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  /** Check whether the cache holds a (possibly empty) entry for this openId. */
  has(openId: string): boolean {
    const entry = this.map.get(openId);
    if (!entry) return false;
    if (entry.expireAt <= Date.now()) {
      this.map.delete(openId);
      return false;
    }
    return true;
  }

  /** Get a cached name (refreshes LRU position). Returns `undefined` on miss or expiry. */
  get(openId: string): string | undefined {
    const entry = this.map.get(openId);
    if (!entry) return undefined;
    if (entry.expireAt <= Date.now()) {
      this.map.delete(openId);
      return undefined;
    }
    // LRU refresh: delete + re-insert to move to end
    this.map.delete(openId);
    this.map.set(openId, entry);
    return entry.name;
  }

  /** Write a single entry (evicts oldest if over capacity). */
  set(openId: string, name: string): void {
    this.map.delete(openId); // ensure fresh insertion order
    this.map.set(openId, { name, expireAt: Date.now() + this.ttlMs });
    this.evict();
  }

  /** Write multiple entries at once. */
  setMany(entries: Iterable<[string, string]>): void {
    for (const [openId, name] of entries) {
      this.map.delete(openId);
      this.map.set(openId, { name, expireAt: Date.now() + this.ttlMs });
    }
    this.evict();
  }

  /** Return openIds that are NOT present (or expired) in the cache. */
  filterMissing(openIds: string[]): string[] {
    return openIds.filter((id) => !this.has(id));
  }

  /** Bulk read — returns a Map of openId→name for all hits (including empty-string names). */
  getMany(openIds: string[]): Map<string, string> {
    const result = new Map<string, string>();
    for (const id of openIds) {
      if (this.has(id)) {
        result.set(id, this.get(id) ?? '');
      }
    }
    return result;
  }

  /** Clear all entries. */
  clear(): void {
    this.map.clear();
  }

  private evict(): void {
    while (this.map.size > this.maxSize) {
      // Map iterator yields in insertion order — first key is the oldest
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}

// ---------------------------------------------------------------------------
// Account-scoped singleton registry
// ---------------------------------------------------------------------------

const registry = new Map<string, UserNameCache>();

/** Get (or create) the UserNameCache for a given account. */
export function getUserNameCache(accountId: string): UserNameCache {
  let c = registry.get(accountId);
  if (!c) {
    c = new UserNameCache();
    registry.set(accountId, c);
  }
  return c;
}

/**
 * Clear user-name caches.
 * - With `accountId`: clear that single cache.
 * - Without: clear all caches.
 */
export function clearUserNameCache(accountId?: string): void {
  if (accountId !== undefined) {
    registry.get(accountId)?.clear();
    registry.delete(accountId);
  } else {
    for (const c of registry.values()) c.clear();
    registry.clear();
  }
}

// ---------------------------------------------------------------------------
// Batch resolve via contact/v3/users/batch
// ---------------------------------------------------------------------------

/** Max user_ids per API call (Feishu limit). */
const BATCH_SIZE = 50;

/**
 * Batch-resolve user display names.
 *
 * 1. Check cache → collect misses
 * 2. Deduplicate
 * 3. Call `GET /open-apis/contact/v3/users/batch` in chunks of 50
 * 4. Write results back to cache
 * 5. Return full Map<openId, name> (cache hits + API results)
 *
 * Best-effort: API errors are logged but never thrown.
 */
export async function batchResolveUserNames(params: {
  account: LarkAccount;
  openIds: string[];
  log: (...args: unknown[]) => void;
}): Promise<Map<string, string>> {
  const { account, openIds, log } = params;
  if (!account.configured || openIds.length === 0) {
    return new Map();
  }

  const cache = getUserNameCache(account.accountId);
  const result = cache.getMany(openIds);

  // Deduplicate missing IDs
  const missing = [...new Set(cache.filterMissing(openIds))];
  if (missing.length === 0) return result;

  const client = LarkClient.fromAccount(account).sdk;

  // Split into chunks of BATCH_SIZE and call SDK method
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const chunk = missing.slice(i, i + BATCH_SIZE);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await client.contact.user.batch({
        params: {
          user_ids: chunk,
          user_id_type: 'open_id',
        },
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items: any[] = res?.data?.items ?? [];
      const resolved = new Set<string>();
      for (const item of items) {
        const openId: string | undefined = item.open_id;
        if (!openId) continue;
        const name: string = item.name || item.display_name || item.nickname || item.en_name || '';
        cache.set(openId, name);
        result.set(openId, name);
        resolved.add(openId);
      }
      // Cache empty names for IDs the API didn't return (no permission, etc.)
      for (const id of chunk) {
        if (!resolved.has(id)) {
          cache.set(id, '');
          result.set(id, '');
        }
      }
    } catch (err) {
      log(`batchResolveUserNames: failed: ${String(err)}`);
    }
  }

  return result;
}

/**
 * Create a `batchResolveNames` callback for use in `ConvertContext`.
 *
 * The returned function calls `batchResolveUserNames` with the given
 * account and log function, populating the TAT user-name cache.
 */
export function createBatchResolveNames(
  account: LarkAccount,
  log: (...args: unknown[]) => void,
): (openIds: string[]) => Promise<void> {
  return async (openIds) => {
    await batchResolveUserNames({ account, openIds, log });
  };
}

// ---------------------------------------------------------------------------
// Single-user resolve (fallback)
// ---------------------------------------------------------------------------

export interface ResolveUserNameResult {
  name?: string;
  permissionError?: PermissionError;
}

/**
 * Resolve a single user's display name.
 *
 * Checks the account-scoped cache first, then falls back to the
 * `contact.user.get` API (same as the old `resolveFeishuSenderName`).
 */
export async function resolveUserName(params: {
  account: LarkAccount;
  openId: string;
  log: (...args: unknown[]) => void;
}): Promise<ResolveUserNameResult> {
  const { account, openId, log } = params;
  if (!account.configured || !openId) return {};

  const cache = getUserNameCache(account.accountId);
  if (cache.has(openId)) return { name: cache.get(openId) ?? '' };

  try {
    const client = LarkClient.fromAccount(account).sdk;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await client.contact.user.get({
      path: { user_id: openId },
      params: { user_id_type: 'open_id' },
    });

    const name: string =
      res?.data?.user?.name ||
      res?.data?.user?.display_name ||
      res?.data?.user?.nickname ||
      res?.data?.user?.en_name ||
      '';

    // Cache even empty names to avoid repeated API calls for users
    // whose names we cannot resolve (e.g. due to permissions).
    cache.set(openId, name);
    return { name: name || undefined };
  } catch (err) {
    const permErr = extractPermissionError(err);
    if (permErr) {
      log(`feishu: permission error resolving user name: code=${permErr.code}`);
      // Cache empty name so we don't retry a known-failing openId
      cache.set(openId, '');
      return { permissionError: permErr };
    }
    log(`feishu: failed to resolve user name for ${openId}: ${String(err)}`);
    return {};
  }
}
