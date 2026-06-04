/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Read actions for the Lark/Feishu channel plugin's `message` tool.
 *
 * Adds list / get / search / members actions parallel to the existing
 * send / react / reactions / delete / unsend write actions, so agents
 * can answer "what was just said in chat X" without grepping local
 * cache files.
 */

import type { OpenClawConfig } from 'openclaw/plugin-sdk';
import { readStringParam } from 'openclaw/plugin-sdk/param-readers';

import { jsonResult } from '../../core/sdk-compat';
import { LarkClient } from '../../core/lark-client';
import { larkLogger } from '../../core/lark-logger';
import { getMessageFeishu } from '../shared/message-lookup';
import { listChatMembersFeishu } from './chat-manage';

const log = larkLogger('outbound/read-actions');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readChatId(params: Record<string, unknown>): string {
  return (
    readStringParam(params, 'chatId') ||
    readStringParam(params, 'chat') ||
    readStringParam(params, 'channel') ||
    readStringParam(params, 'to') ||
    ''
  );
}

function readNumberParam(
  params: Record<string, unknown>,
  key: string,
  dflt: number | undefined,
): number | undefined {
  const v = (params as Record<string, unknown>)?.[key];
  if (v == null || v === '') return dflt;
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : dflt;
}

function safeParseJson(s: unknown): Record<string, unknown> | null {
  if (typeof s !== 'string') return null;
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Build a short text excerpt from a raw IM message item. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildExcerpt(item: any, maxLen = 200): string {
  const msgType: string = item?.msg_type || 'text';
  const raw: string = item?.body?.content ?? '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj: any = safeParseJson(raw) || {};
  let out: string;

  try {
    if (msgType === 'text') {
      out = String(obj.text ?? '');
    } else if (msgType === 'post') {
      const blocks = obj?.content || obj?.zh_cn?.content || obj?.en_us?.content || [];
      const lines: string[] = [];
      for (const block of Array.isArray(blocks) ? blocks : []) {
        const parts: string[] = [];
        for (const seg of Array.isArray(block) ? block : []) {
          if (seg && typeof seg === 'object') {
            if (seg.text) parts.push(String(seg.text));
            else if (seg.user_name) parts.push('@' + seg.user_name);
            else if (seg.href) parts.push(String(seg.href));
          }
        }
        if (parts.length) lines.push(parts.join(''));
      }
      const title = obj.title || obj?.zh_cn?.title || obj?.en_us?.title || '';
      out = (title ? `[${title}] ` : '') + lines.join(' / ');
    } else if (msgType === 'interactive' || msgType === 'card') {
      const header = obj?.header?.title?.content || obj?.header?.title?.text || '';
      let bodyText = '';
      const elements = obj?.elements || obj?.body?.elements || [];
      for (const el of Array.isArray(elements) ? elements : []) {
        const t = el?.text?.content || el?.content || '';
        if (t) {
          bodyText = String(t);
          break;
        }
      }
      out = `[card]${header ? ' ' + header : ''}${bodyText ? ' — ' + bodyText : ''}`;
    } else if (msgType === 'image') {
      out = '[image]';
    } else if (msgType === 'file') {
      out = `[file ${obj.file_name || ''}]`.trim();
    } else if (msgType === 'audio') {
      out = '[audio]';
    } else if (msgType === 'sticker') {
      out = '[sticker]';
    } else if (msgType === 'media' || msgType === 'video') {
      out = '[video]';
    } else if (msgType === 'system') {
      out = `[system] ${obj.template || ''}`;
    } else {
      out = `[${msgType}]`;
    }
  } catch {
    out = `[${msgType}]`;
  }

  out = (out || '').replace(/\s+/g, ' ').trim();
  if (out.length > maxLen) out = out.slice(0, maxLen) + '…';
  return out;
}

interface NormalizedMessage {
  messageId: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  createTime?: number;
  updateTime?: number;
  senderId?: string;
  senderType?: string;
  senderIdType?: string;
  msgType?: string;
  chatId?: string;
  deleted?: boolean;
  textExcerpt: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeListItem(item: any): NormalizedMessage {
  return {
    messageId: item?.message_id ?? '',
    rootId: item?.root_id || undefined,
    parentId: item?.parent_id || undefined,
    threadId: item?.thread_id || undefined,
    createTime: item?.create_time ? parseInt(String(item.create_time), 10) : undefined,
    updateTime: item?.update_time ? parseInt(String(item.update_time), 10) : undefined,
    senderId: item?.sender?.id || undefined,
    senderType: item?.sender?.sender_type || undefined,
    senderIdType: item?.sender?.id_type || undefined,
    msgType: item?.msg_type || undefined,
    chatId: item?.chat_id || undefined,
    deleted: item?.deleted === true ? true : undefined,
    textExcerpt: buildExcerpt(item),
  };
}

// ---------------------------------------------------------------------------
// handleList
// ---------------------------------------------------------------------------

/**
 * List recent messages in a chat. Optional sender filter (open_id) is applied
 * client-side after fetching `scan` rows (default 50, capped 200).
 *
 * Params:
 *   chatId (required) | chat (alias) | channel | to
 *   limit  (default 20, max 200)        — final result count after filtering
 *   scan   (default = max(limit*3, 50)) — raw rows pulled from API
 *   sender (optional open_id)
 *   since_hours / since_days (optional, lower-bound on create_time)
 */
export async function handleList(
  cfg: OpenClawConfig,
  params: Record<string, unknown>,
  accountId?: string,
): Promise<ReturnType<typeof jsonResult>> {
  const chatId = readChatId(params);
  if (!chatId) throw new Error('list requires chatId (or chat/channel/to alias).');

  const limit = Math.min(Math.max(readNumberParam(params, 'limit', 20)!, 1), 200);
  const scan = Math.min(
    Math.max(readNumberParam(params, 'scan', Math.max(limit * 3, 50))!, limit),
    200,
  );
  const sender = readStringParam(params, 'sender') || undefined;
  const sinceHours =
    readNumberParam(params, 'since_hours', undefined) ??
    readNumberParam(params, 'sinceHours', undefined);
  const sinceDays =
    readNumberParam(params, 'since_days', undefined) ??
    readNumberParam(params, 'sinceDays', undefined);
  let startTimeMs: number | undefined;
  if (sinceHours) startTimeMs = Date.now() - sinceHours * 3_600_000;
  else if (sinceDays) startTimeMs = Date.now() - sinceDays * 86_400_000;

  log.info(
    `list: chatId=${chatId} limit=${limit} scan=${scan} sender=${sender || '(any)'} ` +
      `since=${startTimeMs ? new Date(startTimeMs).toISOString() : '(none)'}`,
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk = LarkClient.fromCfg(cfg, accountId).sdk as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: any[] = [];
  let pageToken: string | undefined;
  while (items.length < scan) {
    const pageSize = Math.min(scan - items.length, 50);
    const res = await sdk.request({
      method: 'GET',
      url: `/open-apis/im/v1/messages`,
      params: {
        container_id_type: 'chat',
        container_id: chatId,
        sort_type: 'ByCreateTimeDesc',
        page_size: pageSize,
        ...(pageToken ? { page_token: pageToken } : {}),
        ...(startTimeMs ? { start_time: String(Math.floor(startTimeMs / 1000)) } : {}),
      },
    });
    if (res?.code !== undefined && res.code !== 0) {
      throw new Error(`[feishu-actions] list ${chatId}: code=${res.code} msg=${res.msg || ''}`);
    }
    const got = res?.data?.items || [];
    items.push(...got);
    pageToken = res?.data?.page_token;
    if (!res?.data?.has_more || !pageToken) break;
  }

  let normalized = items.map(normalizeListItem);
  if (sender) normalized = normalized.filter((m) => m.senderId === sender);
  const result = normalized.slice(0, limit);

  return jsonResult({
    ok: true,
    chatId,
    count: result.length,
    scanned: items.length,
    hasMore: Boolean(pageToken),
    nextPageToken: pageToken || undefined,
    messages: result,
  });
}

// ---------------------------------------------------------------------------
// handleGet
// ---------------------------------------------------------------------------

/**
 * Fetch a single message by id, returning the rich `FeishuMessageInfo`
 * shape (includes parsed body, sender, root/parent, reactions when
 * `expandForward=true` flips on `getMessageFeishu`'s recursive lookup).
 */
export async function handleGet(
  cfg: OpenClawConfig,
  params: Record<string, unknown>,
  accountId?: string,
): Promise<ReturnType<typeof jsonResult>> {
  const messageId = readStringParam(params, 'messageId', { required: true });
  const expandForward =
    (params as Record<string, unknown>)?.full === true ||
    (params as Record<string, unknown>)?.expand === true ||
    (typeof (params as Record<string, unknown>)?.full === 'string' &&
      (params as Record<string, unknown>).full === 'true');

  log.info(`get: messageId=${messageId} expandForward=${Boolean(expandForward)}`);

  const info = await getMessageFeishu({
    cfg,
    messageId,
    accountId,
    expandForward: Boolean(expandForward),
  });

  if (!info) {
    return jsonResult({ ok: false, messageId, error: 'message not found or API error' });
  }
  return jsonResult({ ok: true, message: info });
}

// ---------------------------------------------------------------------------
// handleSearch
// ---------------------------------------------------------------------------

/**
 * Client-side substring search over recent messages in a chat.
 *
 * Params:
 *   chatId (required)
 *   text | query | q (required)
 *   limit (default 20, max 200)
 *   scan  (default 100, max 500)
 */
export async function handleSearch(
  cfg: OpenClawConfig,
  params: Record<string, unknown>,
  accountId?: string,
): Promise<ReturnType<typeof jsonResult>> {
  const chatId = readChatId(params);
  if (!chatId) throw new Error('search requires chatId.');
  const text = (
    readStringParam(params, 'text') ||
    readStringParam(params, 'query') ||
    readStringParam(params, 'q') ||
    ''
  ).trim();
  if (!text) throw new Error('search requires text/query/q.');

  const limit = Math.min(Math.max(readNumberParam(params, 'limit', 20)!, 1), 200);
  const scan = Math.min(Math.max(readNumberParam(params, 'scan', 100)!, limit), 500);

  log.info(`search: chatId=${chatId} text="${text}" limit=${limit} scan=${scan}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk = LarkClient.fromCfg(cfg, accountId).sdk as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: any[] = [];
  let pageToken: string | undefined;
  while (items.length < scan) {
    const pageSize = Math.min(scan - items.length, 50);
    const res = await sdk.request({
      method: 'GET',
      url: `/open-apis/im/v1/messages`,
      params: {
        container_id_type: 'chat',
        container_id: chatId,
        sort_type: 'ByCreateTimeDesc',
        page_size: pageSize,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });
    if (res?.code !== undefined && res.code !== 0) {
      throw new Error(`[feishu-actions] search ${chatId}: code=${res.code} msg=${res.msg || ''}`);
    }
    const got = res?.data?.items || [];
    items.push(...got);
    pageToken = res?.data?.page_token;
    if (!res?.data?.has_more || !pageToken) break;
  }

  const needle = text.toLowerCase();
  const matches: NormalizedMessage[] = [];
  for (const item of items) {
    const norm = normalizeListItem(item);
    const hay = (norm.textExcerpt || '').toLowerCase();
    if (hay.includes(needle)) matches.push(norm);
    if (matches.length >= limit) break;
  }

  return jsonResult({
    ok: true,
    chatId,
    query: text,
    scanned: items.length,
    count: matches.length,
    messages: matches,
  });
}

// ---------------------------------------------------------------------------
// handleMembers
// ---------------------------------------------------------------------------

/** List human members in a chat (delegates to existing `listChatMembersFeishu`). */
export async function handleMembers(
  cfg: OpenClawConfig,
  params: Record<string, unknown>,
  accountId?: string,
): Promise<ReturnType<typeof jsonResult>> {
  const chatId = readChatId(params);
  if (!chatId) throw new Error('members requires chatId.');
  const pageToken = readStringParam(params, 'pageToken') || undefined;

  log.info(`members: chatId=${chatId} pageToken=${pageToken || '(none)'}`);

  const result = await listChatMembersFeishu({
    cfg,
    chatId,
    accountId,
    pageToken,
  });

  return jsonResult({
    ok: true,
    chatId,
    count: result.members.length,
    hasMore: result.hasMore,
    nextPageToken: result.pageToken,
    members: result.members,
  });
}
