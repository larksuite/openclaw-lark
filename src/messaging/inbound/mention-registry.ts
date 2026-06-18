/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Per-chat name → openId registry.
 *
 * Backs `normalizeOutboundMentions` / `ensureMention` on the outbound side:
 * when the LLM writes "@Alice" in a reply, the outbound layer needs to look
 * up which `ou_xxx` "Alice" maps to in this specific chat to produce a real
 * Feishu `<at user_id="ou_xxx">` element that actually triggers delivery.
 *
 * Two ingestion paths feed the registry:
 *   1. `recordSender(chatId, openId, name)` — every inbound message's sender
 *   2. `recordMention(chatId, openId, name)` — every @-target in inbound text
 *
 * Entries decay with TTL so stale display names (renames, departed members)
 * don't pollute future lookups indefinitely. The registry is process-local;
 * it's a best-effort cache, not a source of truth, and a cache miss simply
 * means the outbound mention falls back to plain "@Name" text (which Feishu
 * won't deliver as a notification — that's a graceful degradation, not a
 * functional failure).
 */

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

interface Entry {
  openId: string;
  name: string;
  recordedAt: number;
}

// chatId -> lowercased name -> Entry
const registry = new Map<string, Map<string, Entry>>();

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function getChatMap(chatId: string): Map<string, Entry> {
  let chatMap = registry.get(chatId);
  if (!chatMap) {
    chatMap = new Map();
    registry.set(chatId, chatMap);
  }
  return chatMap;
}

function recordEntry(chatId: string, openId: string, name: string): void {
  if (!chatId || !openId || !name) return;
  const key = normalizeName(name);
  if (!key) return;
  getChatMap(chatId).set(key, { openId, name, recordedAt: Date.now() });
}

/**
 * Record an @-mention target observed in inbound text.
 *
 * The name passed here should be the human-readable display name as parsed
 * out of the Feishu mention element, not the raw `@user_xxx` placeholder.
 */
export function recordMention(chatId: string, openId: string, name: string): void {
  recordEntry(chatId, openId, name);
}

/**
 * Record the sender of an inbound message.
 *
 * Even when the sender is never @-mentioned, recording lets the outbound
 * layer @ them back by name. In bot↔bot flows this is the only way the
 * receiving bot learns the peer bot's name → openId mapping.
 */
export function recordSender(chatId: string, openId: string, name: string): void {
  recordEntry(chatId, openId, name);
}

/**
 * Look up the openId for a name in a given chat. Returns `undefined` when
 * the name has never been seen, or when the entry has aged out past TTL.
 *
 * Caller may pass either the raw mention spelling ("alice", "Alice", "
 *  Alice ") — name comparison is case-insensitive and ignores surrounding
 * whitespace.
 */
export function lookupByName(
  chatId: string,
  name: string,
  opts: { ttlMs?: number } = {},
): string | undefined {
  const chatMap = registry.get(chatId);
  if (!chatMap) return undefined;
  const entry = chatMap.get(normalizeName(name));
  if (!entry) return undefined;
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  if (Date.now() - entry.recordedAt > ttl) {
    chatMap.delete(normalizeName(name));
    return undefined;
  }
  return entry.openId;
}

/**
 * Reset the registry. Intended for tests; production code should rely on
 * TTL expiry instead.
 */
export function resetMentionRegistry(): void {
  registry.clear();
}

/**
 * Drop all entries older than `ttlMs` across every chat. Optional helper
 * for callers that want a deterministic cleanup tick — `lookupByName`
 * already does lazy eviction on read.
 */
export function purgeStaleEntries(ttlMs: number = DEFAULT_TTL_MS): void {
  const cutoff = Date.now() - ttlMs;
  for (const [chatId, chatMap] of registry) {
    for (const [key, entry] of chatMap) {
      if (entry.recordedAt < cutoff) chatMap.delete(key);
    }
    if (chatMap.size === 0) registry.delete(chatId);
  }
}
