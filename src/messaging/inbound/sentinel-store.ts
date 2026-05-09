/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Per-thread store for unresolved mention feedback. The outbound
 * normalizer records a SentinelEntry whenever an `@Name` cannot be
 * resolved; the next inbound message on the same thread consumes
 * (take and delete) the entries, which buildMentionAnnotation surfaces
 * as a system note so the next reply can disambiguate.
 *
 * Kept separate from UserNameCache because the lifecycle differs:
 * 10-minute TTL, per-thread keying, and take-and-delete consumption.
 */

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 min — short, avoid stale feedback
const DEFAULT_MAX_THREADS = 200; // per-account

export interface SentinelEntry {
  /** Literal name as it appeared in the outbound text. */
  name: string;
  /** Why parsing failed. */
  reason: 'not_found' | 'ambiguous';
  /** Candidate open_ids when reason === 'ambiguous'. */
  candidates?: Array<{ openId: string; kind?: 'user' | 'bot' }>;
}

interface StoredSentinels {
  entries: SentinelEntry[];
  expireAt: number;
}

function dedup(entries: SentinelEntry[]): SentinelEntry[] {
  const seen = new Set<string>();
  const out: SentinelEntry[] = [];
  for (const e of entries) {
    const key = `${e.reason}:${e.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

export class SentinelStore {
  private byThread = new Map<string, StoredSentinels>();
  private maxThreads: number;
  private ttlMs: number;

  constructor(maxThreads = DEFAULT_MAX_THREADS, ttlMs = DEFAULT_TTL_MS) {
    this.maxThreads = maxThreads;
    this.ttlMs = ttlMs;
  }

  recordSentinels(threadKey: string, sentinels: SentinelEntry[]): void {
    if (sentinels.length === 0) return;
    const existing = this.byThread.get(threadKey);
    const merged = existing ? [...existing.entries, ...sentinels] : sentinels;
    this.byThread.delete(threadKey); // bump LRU
    this.byThread.set(threadKey, {
      entries: dedup(merged),
      expireAt: Date.now() + this.ttlMs,
    });
    this.evict();
  }

  consumeSentinels(threadKey: string): SentinelEntry[] {
    const stored = this.byThread.get(threadKey);
    if (!stored) return [];
    this.byThread.delete(threadKey);
    if (stored.expireAt <= Date.now()) return [];
    return stored.entries;
  }

  clear(): void {
    this.byThread.clear();
  }

  private evict(): void {
    while (this.byThread.size > this.maxThreads) {
      const oldest = this.byThread.keys().next().value;
      if (oldest === undefined) break;
      this.byThread.delete(oldest);
    }
  }
}

const registry = new Map<string, SentinelStore>();

export function getSentinelStore(
  accountId: string,
  maxThreads?: number,
  ttlMs?: number,
): SentinelStore {
  let store = registry.get(accountId);
  if (!store) {
    store = new SentinelStore(maxThreads, ttlMs);
    registry.set(accountId, store);
  }
  return store;
}

export function clearSentinelStore(accountId?: string): void {
  if (accountId !== undefined) {
    registry.get(accountId)?.clear();
    registry.delete(accountId);
  } else {
    clearAllSentinelStores();
  }
}

export function clearAllSentinelStores(): void {
  for (const s of registry.values()) s.clear();
  registry.clear();
}
