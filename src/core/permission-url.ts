/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Permission URL extraction utilities.
 *
 * Shared functions for extracting and processing permission grant URLs
 * from Feishu API error messages.
 */

// ---------------------------------------------------------------------------
// Permission priority
// ---------------------------------------------------------------------------

/**
 * Permission priority for sorting.
 * Lower number = higher priority.
 * - read: 1 (highest)
 * - write: 2
 * - other / both read+write: 3 (lowest)
 */
function getPermissionPriority(scope: string): number {
  const lowerScope = scope.toLowerCase();
  const hasRead = lowerScope.includes('read');
  const hasWrite = lowerScope.includes('write');

  if (hasRead && !hasWrite) return 1;
  if (hasWrite && !hasRead) return 2;
  return 3;
}

/**
 * Extract the highest-priority permission from a scope list.
 * Returns the permission with the lowest priority number (read > write > other).
 */
function extractHighestPriorityScope(scopeList: string): string {
  return scopeList.split(',').sort((a, b) => getPermissionPriority(a) - getPermissionPriority(b))[0] ?? '';
}

// ---------------------------------------------------------------------------
// Permission URL extraction
// ---------------------------------------------------------------------------

/**
 * Extract permission grant URL from a Feishu error message and optimize it
 * by keeping only the highest-priority permission.
 *
 * @param msg - The error message containing the grant URL
 * @returns The optimized grant URL with single permission, or empty string if not found
 */
export function extractPermissionGrantUrl(msg: string): string {
  const urlMatch = msg.match(/https:\/\/[^\s]+\/app\/[^\s]+/);
  if (!urlMatch?.[0]) {
    return '';
  }

  try {
    const url = new URL(urlMatch[0]);
    const scopeListParam = url.searchParams.get('q') ?? '';
    const firstScope = extractHighestPriorityScope(scopeListParam);
    if (firstScope) {
      url.searchParams.set('q', firstScope);
    }
    return url.href;
  } catch {
    return urlMatch[0];
  }
}

/**
 * Extract permission scopes from a Feishu error message.
 * Looks for scopes in the format [scope1,scope2,...]
 */
export function extractPermissionScopes(msg: string): string {
  const scopeMatch = msg.match(/\[([^\]]+)\]/);
  return scopeMatch?.[1] ?? 'unknown';
}
