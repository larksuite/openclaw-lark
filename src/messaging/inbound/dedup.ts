/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * FIFO-based message deduplication.
 *
 * Feishu WebSocket connections may redeliver messages on reconnect.
 * This module tracks recently-seen message IDs and filters duplicates.
 *
 * Design choices:
 * - FIFO eviction (not LRU) — message IDs are write-once/check-once,
 *   no hot/cold access pattern.  FIFO naturally expires the oldest entry
 *   first, which matches the dedup semantics.
 * - ES2015 `Map` preserves insertion order, giving us FIFO for free.
 * - Periodic sweep leverages FIFO ordering: iterate from oldest and
 *   `break` at the first non-expired entry → O(expired), not O(n).
 */

export interface MessageDedupOpts {
  /** Time-to-live for each entry in milliseconds (default: 5 min). */
  ttlMs?: number;
  /** Maximum number of tracked entries (default: 10 000). */
  maxEntries?: number;
}

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const DEFAULT_MAX_ENTRIES = 5_000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Message expiry check
// ---------------------------------------------------------------------------

const DEFAULT_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Check whether a message is too old to process.
 *
 * Feishu message `create_time` is a millisecond Unix timestamp encoded
 * as a string.  When a WebSocket reconnects after a long outage, stale
 * messages may be redelivered — this function lets callers discard them
 * before entering the full handling pipeline.
 */
export function isMessageExpired(createTimeStr: string | undefined, expiryMs: number = DEFAULT_EXPIRY_MS): boolean {
  if (!createTimeStr) return false;
  const createTime = parseInt(createTimeStr, 10);
  if (Number.isNaN(createTime)) return false;
  return Date.now() - createTime > expiryMs;
}

// ---------------------------------------------------------------------------
// Message deduplication
// ---------------------------------------------------------------------------

export class MessageDedup {
  private readonly store = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(opts: MessageDedupOpts = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;

    // Periodic sweep — relies on FIFO ordering so we can break early.
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  /**
   * Try to record a message ID.
   *
   * @param id   Unique message identifier (e.g. Feishu `message_id`).
   * @param scope Optional scope prefix (e.g. accountId) to namespace IDs.
   * @returns `true` if the message is **new**; `false` if it is a duplicate.
   */
  tryRecord(id: string, scope?: string): boolean {
    const key = scope ? `${scope}:${id}` : id;
    const now = Date.now();

    const existing = this.store.get(key);
    if (existing !== undefined) {
      // Entry exists — check TTL.
      if (now - existing < this.ttlMs) {
        // Still within TTL → duplicate.
        return false;
      }
      // Expired — remove so we can re-insert at the tail (refresh position).
      this.store.delete(key);
    }

    // Enforce capacity via FIFO: drop the oldest entry.
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) {
        this.store.delete(oldest);
      }
    }

    this.store.set(key, now);
    return true;
  }

  /** Current number of tracked entries (for diagnostics). */
  get size(): number {
    return this.store.size;
  }

  /** Remove all entries and stop the periodic sweep. */
  clear(): void {
    clearInterval(this.sweepTimer);
    this.store.clear();
  }

  /** Stop the periodic sweep timer and clear all tracked entries. */
  dispose(): void {
    clearInterval(this.sweepTimer);
    this.store.clear();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * Sweep expired entries from the front of the map.
   * Because entries are in insertion order (FIFO), we can stop as soon as
   * we hit one that hasn't expired yet.
   */
  private sweep(): void {
    const now = Date.now();
    for (const [key, ts] of this.store) {
      if (now - ts < this.ttlMs) break;
      this.store.delete(key);
    }
  }
}
