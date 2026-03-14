/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Feishu target ID parsing and formatting utilities.
 *
 * Feishu uses several namespaced identifier prefixes:
 *   - `oc_*`  -- chat (group / DM) IDs
 *   - `ou_*`  -- open user IDs
 *   - plain alphanumeric strings -- user IDs from the tenant directory
 *
 * This module provides helpers to detect, normalise, and format these IDs
 * for both internal routing and outbound Feishu API calls.
 */

import type { FeishuIdType } from './types';

// ---------------------------------------------------------------------------
// Known prefix patterns
// ---------------------------------------------------------------------------

const CHAT_PREFIX = 'oc_';
const OPEN_ID_PREFIX = 'ou_';

// Canonical routing prefixes used inside OpenClaw (not Feishu-native).
const TAG_CHAT = 'chat:';
const TAG_USER = 'user:';
const TAG_OPEN_ID = 'open_id:';

// Feishu channel prefix (used by SDK for some routing scenarios).
const TAG_FEISHU = 'feishu:';

const ROUTE_META_FRAGMENT_REPLY_TO = '__feishu_reply_to';
const ROUTE_META_FRAGMENT_THREAD_ID = '__feishu_thread_id';

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect the Feishu ID type from a raw identifier string.
 *
 * Returns `null` when the string does not match any known pattern.
 */
export function detectIdType(id: string): FeishuIdType | null {
  if (!id) return null;
  if (id.startsWith(CHAT_PREFIX)) return 'chat_id';
  if (id.startsWith(OPEN_ID_PREFIX)) return 'open_id';
  // Plain alphanumeric strings (no prefix) are treated as tenant user IDs.
  if (/^[a-zA-Z0-9]+$/.test(id)) return 'user_id';
  return null;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Strip OpenClaw routing prefixes (`chat:`, `user:`, `open_id:`) from a
 * raw target string, returning the bare Feishu identifier.
 *
 * Returns `null` when the input is empty or falsy.
 */
export function normalizeFeishuTarget(raw: string): string | null {
  if (!raw) return null;

  const trimmed = parseFeishuRouteTarget(raw).target.trim();
  if (!trimmed) return null;

  // Handle Feishu channel prefix (e.g., "feishu:ou_xxx" -> "ou_xxx")
  if (trimmed.startsWith(TAG_FEISHU)) {
    const inner = trimmed.slice(TAG_FEISHU.length).trim();
    if (inner) return inner;
  }

  if (trimmed.startsWith(TAG_CHAT)) return trimmed.slice(TAG_CHAT.length);
  if (trimmed.startsWith(TAG_USER)) return trimmed.slice(TAG_USER.length);
  if (trimmed.startsWith(TAG_OPEN_ID)) return trimmed.slice(TAG_OPEN_ID.length);

  return trimmed;
}

export interface FeishuRouteTarget {
  target: string;
  replyToMessageId?: string;
  threadId?: string;
}

export function parseFeishuRouteTarget(raw: string): FeishuRouteTarget {
  const trimmed = raw.trim();
  if (!trimmed) return { target: '' };

  const hashIndex = trimmed.indexOf('#');
  if (hashIndex < 0) return { target: trimmed };

  const target = trimmed.slice(0, hashIndex).trim();
  const fragment = trimmed.slice(hashIndex + 1).trim();
  if (!fragment) return { target };

  const params = new URLSearchParams(fragment);
  const replyToMessageId = normalizeMessageId(params.get(ROUTE_META_FRAGMENT_REPLY_TO)?.trim() || undefined);
  const threadId = params.get(ROUTE_META_FRAGMENT_THREAD_ID)?.trim() || undefined;
  return {
    target,
    ...(replyToMessageId ? { replyToMessageId } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

export function encodeFeishuRouteTarget(params: {
  target: string;
  replyToMessageId?: string;
  threadId?: string | number | null;
}): string {
  const target = params.target.trim();
  if (!target) return target;

  const replyToMessageId = normalizeMessageId(params.replyToMessageId?.trim() || undefined);
  const threadId =
    params.threadId != null && String(params.threadId).trim() !== '' ? String(params.threadId).trim() : undefined;
  if (!replyToMessageId && !threadId) return target;

  const fragment = new URLSearchParams();
  if (replyToMessageId) fragment.set(ROUTE_META_FRAGMENT_REPLY_TO, replyToMessageId);
  if (threadId) fragment.set(ROUTE_META_FRAGMENT_THREAD_ID, threadId);
  return `${target}#${fragment.toString()}`;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Add the appropriate OpenClaw routing prefix to a bare Feishu identifier.
 *
 * When `type` is omitted, the prefix is inferred via `detectIdType`.
 */
export function formatFeishuTarget(id: string, type?: FeishuIdType): string {
  const resolved = type ?? detectIdType(id);

  if (resolved === 'chat_id') return `${TAG_CHAT}${id}`;
  return `${TAG_USER}${id}`;
}

// ---------------------------------------------------------------------------
// API receive-ID resolution
// ---------------------------------------------------------------------------

/**
 * Determine the `receive_id_type` query parameter for the Feishu send-message
 * API based on the target identifier.
 */
export function resolveReceiveIdType(id: string): 'chat_id' | 'open_id' | 'user_id' {
  if (id.startsWith(CHAT_PREFIX)) return 'chat_id';
  if (id.startsWith(OPEN_ID_PREFIX)) return 'open_id';
  // Default to open_id for any other pattern (safer for outbound API calls).
  return 'open_id';
}

// ---------------------------------------------------------------------------
// Message ID normalisation
// ---------------------------------------------------------------------------

/**
 * 规范化 message_id，去除合成后缀（如 `om_xxx:auth-complete` → `om_xxx`）。
 */
export function normalizeMessageId(messageId: string): string;
export function normalizeMessageId(messageId: string | undefined): string | undefined;
export function normalizeMessageId(messageId: string | undefined): string | undefined {
  if (!messageId) return undefined;
  const colonIndex = messageId.indexOf(':');
  if (colonIndex >= 0) return messageId.slice(0, colonIndex);
  return messageId;
}

// ---------------------------------------------------------------------------
// Quick predicate
// ---------------------------------------------------------------------------

/**
 * Return `true` when a raw string looks like it could be a Feishu target
 * (either an OpenClaw-tagged form or a native prefix).
 */
export function looksLikeFeishuId(raw: string): boolean {
  if (!raw) return false;
  return (
    raw.startsWith(TAG_CHAT) ||
    raw.startsWith(TAG_USER) ||
    raw.startsWith(TAG_OPEN_ID) ||
    raw.startsWith(CHAT_PREFIX) ||
    raw.startsWith(OPEN_ID_PREFIX)
  );
}
