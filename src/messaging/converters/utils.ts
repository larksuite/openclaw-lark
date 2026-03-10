/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Shared utilities for content converters.
 */

/** Escape a string for safe use inside a RegExp. */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Safely parse a JSON string, returning undefined on failure.
 */
export function safeParse(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * Examples: 1500 → "1.5s", 65000 → "65s"
 */
export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 1) return `${ms}ms`;
  if (Number.isInteger(seconds)) return `${seconds}s`;
  return `${seconds.toFixed(1)}s`;
}

/**
 * Convert a millisecond timestamp to "YYYY-MM-DD HH:mm" in UTC+8 (Beijing time).
 */
export function millisToDatetime(ms: string | number): string {
  const num = Number(ms);
  if (!Number.isFinite(num)) return String(ms);

  // UTC+8 offset in milliseconds
  const utc8Offset = 8 * 60 * 60 * 1000;
  const d = new Date(num + utc8Offset);

  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hour = String(d.getUTCHours()).padStart(2, '0');
  const minute = String(d.getUTCMinutes()).padStart(2, '0');

  return `${year}-${month}-${day} ${hour}:${minute}`;
}
