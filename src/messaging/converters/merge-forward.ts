/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Converter for "merge_forward" message type.
 *
 * Unlike other converters this is async — it fetches sub-messages via
 * the Feishu IM API and recursively expands nested merge_forward messages.
 *
 * The API returns ALL nested sub-messages in a single flat `items`
 * array with `upper_message_id` pointing to the parent container.
 * We build a tree from this flat list and recursively format it —
 * only one API call is needed regardless of nesting depth.
 *
 * This module is a pure "data → format" converter: all API capabilities
 * (`fetchSubMessages`, `batchResolveNames`, `resolveUserName`) are
 * injected via callbacks in `ConvertContext`. Callers are responsible
 * for creating the appropriate callbacks (UAT / TAT / event push).
 */

import type { ApiMessageItem, ContentConverterFn } from './types';
import { convertMessageContent, buildConvertContextFromItem } from './content-converter';
import { larkLogger } from '../../core/lark-logger';

const log = larkLogger('converters/merge-forward');

/**
 * Recursively expand a merge_forward message.
 *
 * Output format aligns with the Go reference implementation:
 * ```
 * <forwarded_messages>
 * [RFC3339] sender_id:
 *     message content
 * </forwarded_messages>
 * ```
 */
export const convertMergeForward: ContentConverterFn = async (_raw, ctx) => {
  const { accountId, messageId, resolveUserName, batchResolveNames, fetchSubMessages } = ctx;

  if (!fetchSubMessages) {
    return { content: '<forwarded_messages/>', resources: [] };
  }

  const content = await expand(accountId, messageId, resolveUserName, batchResolveNames, fetchSubMessages);
  return { content, resources: [] };
};

// ---------------------------------------------------------------------------
// Single-API-call expansion with tree building
// ---------------------------------------------------------------------------

async function expand(
  accountId: string | undefined,
  messageId: string,
  resolveUserName?: (openId: string) => string | undefined,
  batchResolveNames?: (openIds: string[]) => Promise<void>,
  fetchSubMessages?: (messageId: string) => Promise<ApiMessageItem[]>,
): Promise<string> {
  // --- Phase 1: Fetch (single API call via callback) ---
  let items: ApiMessageItem[];
  try {
    items = await fetchSubMessages!(messageId);
  } catch (error) {
    log.error('fetch sub-messages failed', {
      messageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return '<forwarded_messages/>';
  }

  if (items.length === 0) {
    return '<forwarded_messages/>';
  }

  // --- Phase 2: Build children map ---
  const childrenMap = buildChildrenMap(items, messageId);

  // --- Phase 2.5: Batch resolve sender names (via callback) ---
  const senderIds = collectSenderIds(items, messageId);
  if (senderIds.length > 0 && batchResolveNames) {
    try {
      await batchResolveNames(senderIds);
    } catch (err) {
      log.debug('batchResolveNames failed (best-effort)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // --- Phase 3: Format tree recursively ---
  return formatSubTree(messageId, childrenMap, accountId, resolveUserName);
}

// ---------------------------------------------------------------------------
// Tree building
// ---------------------------------------------------------------------------

/**
 * Build a map from parent message ID → ordered child items.
 *
 * The API returns a flat `items` array where each item may carry an
 * `upper_message_id` pointing to its parent container. Items without
 * `upper_message_id` are direct children of the root container.
 *
 * The root container message itself (matching `rootMessageId`) is skipped.
 */
function buildChildrenMap(items: ApiMessageItem[], rootMessageId: string): Map<string, ApiMessageItem[]> {
  const map = new Map<string, ApiMessageItem[]>();

  for (const item of items) {
    // Skip the root container message itself
    if (item.message_id === rootMessageId && !item.upper_message_id) {
      continue;
    }

    const parentId: string = item.upper_message_id ?? rootMessageId;
    let children = map.get(parentId);
    if (!children) {
      children = [];
      map.set(parentId, children);
    }
    children.push(item);
  }

  // Sort each group by create_time ascending
  for (const children of map.values()) {
    children.sort((a, b) => {
      const ta = parseInt(String(a.create_time ?? '0'), 10);
      const tb = parseInt(String(b.create_time ?? '0'), 10);
      return ta - tb;
    });
  }

  return map;
}

// ---------------------------------------------------------------------------
// Sender ID collection
// ---------------------------------------------------------------------------

/**
 * Collect all unique sender IDs from non-root items for batch name resolution.
 */
function collectSenderIds(items: ApiMessageItem[], rootMessageId: string): string[] {
  const ids = new Set<string>();
  for (const item of items) {
    // Skip the root container
    if (item.message_id === rootMessageId && !item.upper_message_id) {
      continue;
    }
    if (item.sender?.sender_type === 'user') {
      const senderId: string | undefined = item.sender.id;
      if (senderId) {
        ids.add(senderId);
      }
    }
  }
  return [...ids];
}

// ---------------------------------------------------------------------------
// Recursive tree formatting
// ---------------------------------------------------------------------------

/**
 * Recursively format a sub-tree of messages rooted at `parentId`.
 *
 * For `merge_forward` children this recurses into `formatSubTree`
 * directly (no additional API calls). For other message types it
 * delegates to `convertMessageContent`.
 */
async function formatSubTree(
  parentId: string,
  childrenMap: Map<string, ApiMessageItem[]>,
  accountId: string | undefined,
  resolveUserName?: (openId: string) => string | undefined,
): Promise<string> {
  const children = childrenMap.get(parentId);
  if (!children || children.length === 0) {
    return '<forwarded_messages/>';
  }

  const parts: string[] = [];

  for (const item of children) {
    try {
      const msgType: string = item.msg_type ?? 'text';
      const senderId: string = item.sender?.id ?? 'unknown';
      const createTime: number | undefined = item.create_time ? parseInt(String(item.create_time), 10) : undefined;
      const timestamp = createTime ? formatTimestamp(createTime) : 'unknown';
      const rawContent: string = item.body?.content ?? '{}';

      let content: string;

      if (msgType === 'merge_forward') {
        // Recurse into nested merge_forward via the tree — no API call
        const nestedId: string | undefined = item.message_id;
        if (nestedId) {
          content = await formatSubTree(nestedId, childrenMap, accountId, resolveUserName);
        } else {
          content = '<forwarded_messages/>';
        }
      } else {
        // Delegate to the unified converter system.
        // Do NOT pass cfg/account here — sub-converters for non-merge_forward
        // types don't need it, and passing it would cause nested
        // merge_forward to re-enter expand() via convertMessageContent.
        const subCtx = {
          ...buildConvertContextFromItem(item, parentId, accountId),
          accountId,
          resolveUserName,
        };
        content = (await convertMessageContent(rawContent, msgType, subCtx)).content;
      }

      const displayName = resolveUserName?.(senderId) ?? senderId;
      const indented = indentLines(content, '    ');
      parts.push(`[${timestamp}] ${displayName}:\n${indented}`);
    } catch (err) {
      log.warn('failed to convert sub-message', {
        messageId: item.message_id,
        msgType: item.msg_type ?? 'unknown',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (parts.length === 0) {
    return '<forwarded_messages/>';
  }

  return `<forwarded_messages>\n${parts.join('\n')}\n</forwarded_messages>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a millisecond timestamp to RFC 3339 format with +08:00 offset
 * (Beijing time).
 */
function formatTimestamp(ms: number): string {
  const date = new Date(ms);
  const utcMs = date.getTime() + date.getTimezoneOffset() * 60_000;
  const bjDate = new Date(utcMs + 8 * 3600_000);

  const y = bjDate.getFullYear();
  const mo = String(bjDate.getMonth() + 1).padStart(2, '0');
  const d = String(bjDate.getDate()).padStart(2, '0');
  const h = String(bjDate.getHours()).padStart(2, '0');
  const mi = String(bjDate.getMinutes()).padStart(2, '0');
  const s = String(bjDate.getSeconds()).padStart(2, '0');

  return `${y}-${mo}-${d}T${h}:${mi}:${s}+08:00`;
}

/** Add a prefix indent to every line of text. */
function indentLines(text: string, indent: string): string {
  return text
    .split('\n')
    .map((line) => `${indent}${line}`)
    .join('\n');
}
