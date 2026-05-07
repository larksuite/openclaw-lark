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
import { getUserNameCache } from './user-name-cache-store';
import { type PermissionError, extractPermissionError } from './permission';

export { UserNameCache, clearUserNameCache, getUserNameCache } from './user-name-cache-store';

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
 * Resolve a single bot's display name via `/open-apis/bot/v3/bots/basic_batch`.
 *
 * Bots are not returned by the contact API, so they have their own endpoint.
 * Names share the same account-scoped cache (keyed by openId) since both
 * bots and users have `ou_` prefixed openIds and a single display name.
 */
export async function resolveBotName(params: {
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
    const res: any = await (client as any).request({
      method: 'GET',
      url: '/open-apis/bot/v3/bots/basic_batch',
      params: { bot_ids: [openId] },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bot: any = res?.data?.bots?.[openId];
    const name: string =
      bot?.name || bot?.i18n_names?.zh_cn || bot?.i18n_names?.en_us || '';

    // Cache even empty names to avoid repeated API calls for bots
    // whose names we cannot resolve.
    cache.set(openId, name);
    return { name: name || undefined };
  } catch (err) {
    // Bot name resolution is best-effort: missing `bot:basic_info` scope
    // should not surface as a permission notification to the agent. Log
    // and cache an empty name so we don't retry, then fall back to openId.
    const permErr = extractPermissionError(err);
    if (permErr) {
      log(`feishu: permission error resolving bot name (best-effort, ignored): code=${permErr.code}`);
    } else {
      log(`feishu: failed to resolve bot name for ${openId}: ${String(err)}`);
    }
    cache.set(openId, '');
    return {};
  }
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
