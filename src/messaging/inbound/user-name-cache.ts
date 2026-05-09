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
import type { ChatMember, PrincipalKind, UserNameCache } from './user-name-cache-store';
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
        cache.setWithKind(openId, name, 'user');
        result.set(openId, name);
        resolved.add(openId);
      }
      // Cache empty names for IDs the API didn't return (no permission, etc.)
      for (const id of chunk) {
        if (!resolved.has(id)) {
          cache.setWithKind(id, '', 'user');
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
    cache.setWithKind(openId, name, 'bot');
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
    cache.setWithKind(openId, '', 'bot');
    return {};
  }
}

// ---------------------------------------------------------------------------
// Lazy chat-member prefetch
// ---------------------------------------------------------------------------

/** Returns the numeric Feishu API error code from a thrown error, or null. */
function extractApiCode(err: unknown): number | null {
  const permErr = extractPermissionError(err);
  if (typeof permErr?.code === 'number') return permErr.code;
  if (err && typeof err === 'object') {
    const code = (err as { response?: { data?: { code?: unknown } } }).response?.data?.code;
    if (typeof code === 'number') return code;
  }
  return null;
}

/** Configuration for one chat-prefetch endpoint. */
interface ChatPrefetchSpec<M> {
  /** Tag used in in-flight key and log lines, e.g. 'bots' or 'members'. */
  tag: string;
  /** API endpoint, given the chatId. */
  url: (chatId: string) => string;
  /** Query string. */
  params: Record<string, unknown>;
  parseItem: (raw: unknown) => M | null;
  /** True iff a fresh snapshot is already in the cache for this chat. */
  isFresh: (cache: UserNameCache, chatId: string) => boolean;
  /** Write a member list (used both on success and on the empty-on-error path). */
  record: (cache: UserNameCache, chatId: string, members: M[]) => void;
}

/**
 * Runs a chat-member prefetch with shared lifecycle:
 *
 * 1. Skip on unconfigured account or empty chatId.
 * 2. Dedup concurrent calls per (tag, chatId) via `cache.inFlight`.
 * 3. Skip when an in-TTL snapshot already exists.
 * 4. On API error, cache an empty list to short-circuit retries; on
 *    transient errors, leave the cache untouched so the next call retries.
 */
async function runChatPrefetch<M>(
  spec: ChatPrefetchSpec<M>,
  account: LarkAccount,
  chatId: string,
  log: (...args: unknown[]) => void,
): Promise<void> {
  if (!account.configured || !chatId) return;

  const cache = getUserNameCache(account.accountId);
  const key = `${spec.tag}:${chatId}`;
  const existing = cache.getInflight(key);
  if (existing) return existing;
  if (spec.isFresh(cache, chatId)) return;

  const promise = (async () => {
    try {
      const client = LarkClient.fromAccount(account).sdk;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await (client as any).request({
        method: 'GET',
        url: spec.url(chatId),
        params: spec.params,
      });
      const items: unknown[] = (res as { data?: { items?: unknown[] } })?.data?.items ?? [];
      const members = items.map(spec.parseItem).filter((m): m is M => m !== null);
      spec.record(cache, chatId, members);
    } catch (err) {
      const apiCode = extractApiCode(err);
      if (apiCode != null) {
        // Application-level refusal: cache an empty list to short-circuit
        // further retries. Persistent errors (e.g. missing scope) will not
        // resolve within the cache TTL anyway.
        log(`prefetchChat${spec.tag}[${chatId}]: API error code=${apiCode}, caching empty`);
        spec.record(cache, chatId, []);
      } else {
        log(`prefetchChat${spec.tag}[${chatId}]: failed: ${String(err)}`);
      }
    } finally {
      cache.clearInflight(key);
    }
  })();

  cache.setInflight(key, promise);
  return promise;
}

interface RawBotMember {
  // /members/bots returns { bot_id, bot_name }; some related endpoints
  // use { open_id, name }. Accept both shapes.
  bot_id?: string;
  bot_name?: string;
  open_id?: string;
  name?: string;
}

const CHAT_BOTS_SPEC: ChatPrefetchSpec<{ openId: string; name: string }> = {
  tag: 'Bots',
  url: (chatId) => `/open-apis/im/v1/chats/${chatId}/members/bots`,
  params: {},
  parseItem: (raw) => {
    const it = raw as RawBotMember;
    const openId = String(it.bot_id ?? it.open_id ?? '');
    if (!openId) return null;
    return { openId, name: String(it.bot_name ?? it.name ?? '') };
  },
  isFresh: (cache, chatId) => cache.getChatBots(chatId) !== null,
  record: (cache, chatId, members) => cache.recordChatBots(chatId, members),
};

interface RawChatMember {
  // /members returns `member_id`; some related endpoints use `open_id`.
  // With `member_id_type=open_id` the value is an ou_-prefixed open_id.
  member_id?: string;
  open_id?: string;
  name?: string;
  // 'user' | 'app'; absent on /members, where every entry is a user.
  member_type?: string;
}

function memberTypeToKind(type: string | undefined): PrincipalKind {
  return type === 'app' ? 'bot' : 'user';
}

const CHAT_MEMBERS_SPEC: ChatPrefetchSpec<ChatMember> = {
  tag: 'Members',
  url: (chatId) => `/open-apis/im/v1/chats/${chatId}/members`,
  params: { member_id_type: 'open_id', page_size: 100 },
  parseItem: (raw) => {
    const it = raw as RawChatMember;
    const openId = String(it.member_id ?? it.open_id ?? '');
    if (!openId) return null;
    return { openId, name: String(it.name ?? ''), kind: memberTypeToKind(it.member_type) };
  },
  isFresh: (cache, chatId) => cache.getChatMembers(chatId) !== null,
  record: (cache, chatId, members) => cache.recordChatMembers(chatId, members),
};

/**
 * Fetches the bot members of a chat via
 * `GET /open-apis/im/v1/chats/{chat_id}/members/bots` and writes them
 * to the per-account cache.
 */
export async function prefetchChatBots(
  account: LarkAccount,
  chatId: string,
  log: (...args: unknown[]) => void,
): Promise<void> {
  return runChatPrefetch(CHAT_BOTS_SPEC, account, chatId, log);
}

/**
 * Fetches the human members of a chat via
 * `GET /open-apis/im/v1/chats/{chat_id}/members` and writes them to
 * the per-account cache.
 */
export async function prefetchChatMembers(
  account: LarkAccount,
  chatId: string,
  log: (...args: unknown[]) => void,
): Promise<void> {
  return runChatPrefetch(CHAT_MEMBERS_SPEC, account, chatId, log);
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
    cache.setWithKind(openId, name, 'user');
    return { name: name || undefined };
  } catch (err) {
    const permErr = extractPermissionError(err);
    if (permErr) {
      log(`feishu: permission error resolving user name: code=${permErr.code}`);
      // Cache empty name so we don't retry a known-failing openId
      cache.setWithKind(openId, '', 'user');
      return { permissionError: permErr };
    }
    log(`feishu: failed to resolve user name for ${openId}: ${String(err)}`);
    return {};
  }
}
