/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Directory listing for Feishu peers (users) and groups.
 *
 * Provides both config-based (offline) and live API directory
 * lookups so the outbound subsystem and UI can resolve targets.
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import { getLarkAccount } from '../core/accounts';
import { LarkClient } from '../core/lark-client';
import { normalizeFeishuTarget } from '../core/targets';
import type { FeishuDirectoryPeer, FeishuDirectoryGroup } from './types';

// Re-export types for backward compatibility
export type { FeishuDirectoryPeer, FeishuDirectoryGroup } from './types';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Case-insensitive substring match on id and optional name. */
function matchesQuery(id: string, name: string | undefined, query: string): boolean {
  if (!query) return true;
  return id.toLowerCase().includes(query) || (name?.toLowerCase().includes(query) ?? false);
}

/** Filter items and apply optional limit. */
function applyLimitSlice<T>(items: T[], limit?: number): T[] {
  return limit && limit > 0 ? items.slice(0, limit) : items;
}

// ---------------------------------------------------------------------------
// Config-based (offline) directory
// ---------------------------------------------------------------------------

/**
 * List users known from the channel config (allowFrom + dms fields).
 *
 * Does not make any API calls -- useful when the bot is not yet
 * connected or when credentials are unavailable.
 */
export async function listFeishuDirectoryPeers(params: {
  cfg: ClawdbotConfig;
  query?: string;
  limit?: number;
  accountId?: string;
}): Promise<FeishuDirectoryPeer[]> {
  const account = getLarkAccount(params.cfg, params.accountId);
  const feishuCfg = account.config;
  const q = params.query?.trim().toLowerCase() || '';
  const ids = new Set<string>();

  // Collect from allowFrom entries.
  for (const entry of feishuCfg?.allowFrom ?? []) {
    const trimmed = String(entry).trim();
    if (trimmed && trimmed !== '*') {
      ids.add(trimmed);
    }
  }

  // Collect from per-user DM config keys.
  for (const userId of Object.keys(feishuCfg?.dms ?? {})) {
    const trimmed = userId.trim();
    if (trimmed) {
      ids.add(trimmed);
    }
  }

  const peers = Array.from(ids)
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => normalizeFeishuTarget(raw) ?? raw)
    .filter((id) => matchesQuery(id, undefined, q))
    .map((id) => ({ kind: 'user' as const, id }));

  return applyLimitSlice(peers, params.limit);
}

/**
 * List groups known from the channel config (groups + groupAllowFrom).
 */
export async function listFeishuDirectoryGroups(params: {
  cfg: ClawdbotConfig;
  query?: string;
  limit?: number;
  accountId?: string;
}): Promise<FeishuDirectoryGroup[]> {
  const account = getLarkAccount(params.cfg, params.accountId);
  const feishuCfg = account.config;
  const q = params.query?.trim().toLowerCase() || '';
  const ids = new Set<string>();

  // Collect from per-group config keys.
  for (const groupId of Object.keys(feishuCfg?.groups ?? {})) {
    const trimmed = groupId.trim();
    if (trimmed && trimmed !== '*') {
      ids.add(trimmed);
    }
  }

  // Collect from groupAllowFrom entries.
  for (const entry of feishuCfg?.groupAllowFrom ?? []) {
    const trimmed = String(entry).trim();
    if (trimmed && trimmed !== '*') {
      ids.add(trimmed);
    }
  }

  const groups = Array.from(ids)
    .map((raw) => raw.trim())
    .filter(Boolean)
    .filter((id) => matchesQuery(id, undefined, q))
    .map((id) => ({ kind: 'group' as const, id }));

  return applyLimitSlice(groups, params.limit);
}

// ---------------------------------------------------------------------------
// Live API directory
// ---------------------------------------------------------------------------

/**
 * List users via the Feishu contact/v3/users API.
 *
 * Falls back to config-based listing when credentials are missing or
 * the API call fails.
 */
export async function listFeishuDirectoryPeersLive(params: {
  cfg: ClawdbotConfig;
  query?: string;
  limit?: number;
  accountId?: string;
}): Promise<FeishuDirectoryPeer[]> {
  const account = getLarkAccount(params.cfg, params.accountId);
  if (!account.configured) {
    return listFeishuDirectoryPeers(params);
  }

  try {
    const client = LarkClient.fromAccount(account).sdk;
    const peers: FeishuDirectoryPeer[] = [];
    const limit = params.limit ?? 50;
    if (limit <= 0) return [];
    const q = params.query?.trim().toLowerCase() || '';
    let pageToken: string | undefined;

    do {
      const remaining = limit - peers.length;
      const response = await client.contact.user.list({
        params: {
          page_size: Math.min(remaining, 50),
          page_token: pageToken,
        },
      });

      if (response.code !== 0 || !response.data?.items) break;

      for (const user of response.data.items) {
        if (user.open_id && matchesQuery(user.open_id, user.name, q)) {
          peers.push({
            kind: 'user',
            id: user.open_id,
            name: user.name || undefined,
          });
        }
        if (peers.length >= limit) break;
      }

      pageToken = response.data?.page_token;
    } while (pageToken && peers.length < limit);

    return peers;
  } catch {
    // Fallback to config-based listing on API failure.
    return listFeishuDirectoryPeers(params);
  }
}

/**
 * List groups via the Feishu im/v1/chats API.
 *
 * Falls back to config-based listing when credentials are missing or
 * the API call fails.
 */
export async function listFeishuDirectoryGroupsLive(params: {
  cfg: ClawdbotConfig;
  query?: string;
  limit?: number;
  accountId?: string;
}): Promise<FeishuDirectoryGroup[]> {
  const account = getLarkAccount(params.cfg, params.accountId);
  if (!account.configured) {
    return listFeishuDirectoryGroups(params);
  }

  try {
    const client = LarkClient.fromAccount(account).sdk;
    const groups: FeishuDirectoryGroup[] = [];
    const limit = params.limit ?? 50;
    if (limit <= 0) return [];
    const q = params.query?.trim().toLowerCase() || '';
    let pageToken: string | undefined;

    do {
      const remaining = limit - groups.length;
      const response = await client.im.chat.list({
        params: {
          page_size: Math.min(remaining, 100),
          page_token: pageToken,
        },
      });

      if (response.code !== 0 || !response.data?.items) break;

      for (const chat of response.data.items) {
        if (chat.chat_id && matchesQuery(chat.chat_id, chat.name, q)) {
          groups.push({
            kind: 'group',
            id: chat.chat_id,
            name: chat.name || undefined,
          });
        }
        if (groups.length >= limit) break;
      }

      pageToken = response.data?.page_token;
    } while (pageToken && groups.length < limit);

    return groups;
  } catch {
    // Fallback to config-based listing on API failure.
    return listFeishuDirectoryGroups(params);
  }
}
