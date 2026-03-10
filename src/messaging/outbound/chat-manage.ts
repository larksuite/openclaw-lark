/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Chat management for the Lark/Feishu channel plugin.
 *
 * Provides functions to update chat settings (name, avatar), manage
 * members (add, remove, list) using the IM Chat API.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { OpenClawConfig } from 'openclaw/plugin-sdk';
import { LarkClient } from '../../core/lark-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeishuChatMember {
  /** Member ID (open_id by default). */
  memberId: string;
  /** Display name of the member. */
  name: string;
  /** ID type: "open_id", "union_id", or "user_id". */
  memberIdType: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert that a Lark SDK response has code === 0 (or no code field). */
function assertLarkOk(res: any, context: string): void {
  const code = res?.code;
  if (code !== undefined && code !== 0) {
    const msg = res?.msg ?? 'unknown error';
    throw new Error(`[feishu-chat-manage] ${context}: code=${code}, msg=${msg}`);
  }
}

// ---------------------------------------------------------------------------
// updateChatFeishu
// ---------------------------------------------------------------------------

/**
 * Update chat settings such as name or avatar.
 */
export async function updateChatFeishu(params: {
  cfg: OpenClawConfig;
  chatId: string;
  name?: string;
  avatar?: string;
  accountId?: string;
}): Promise<void> {
  const { cfg, chatId, name, avatar, accountId } = params;
  const client = LarkClient.fromCfg(cfg, accountId).sdk;

  const body: Record<string, unknown> = {};
  if (name) body.name = name;
  if (avatar) body.avatar = avatar;

  const res = await client.im.chat.update({
    path: { chat_id: chatId },
    data: body as any,
  });
  assertLarkOk(res, `updateChat for ${chatId}`);
}

// ---------------------------------------------------------------------------
// addChatMembersFeishu
// ---------------------------------------------------------------------------

/**
 * Add members to a chat by their open_id list.
 */
export async function addChatMembersFeishu(params: {
  cfg: OpenClawConfig;
  chatId: string;
  memberIds: string[];
  accountId?: string;
}): Promise<void> {
  const { cfg, chatId, memberIds, accountId } = params;
  const client = LarkClient.fromCfg(cfg, accountId).sdk;

  const res = await client.im.v1.chatMembers.create({
    path: { chat_id: chatId },
    data: { id_list: memberIds },
    params: { member_id_type: 'open_id' },
  });
  assertLarkOk(res, `addChatMembers for ${chatId}`);
}

// ---------------------------------------------------------------------------
// removeChatMembersFeishu
// ---------------------------------------------------------------------------

/**
 * Remove members from a chat by their open_id list.
 */
export async function removeChatMembersFeishu(params: {
  cfg: OpenClawConfig;
  chatId: string;
  memberIds: string[];
  accountId?: string;
}): Promise<void> {
  const { cfg, chatId, memberIds, accountId } = params;
  const client = LarkClient.fromCfg(cfg, accountId).sdk;

  const res = await client.im.v1.chatMembers.delete({
    path: { chat_id: chatId },
    data: { id_list: memberIds },
    params: { member_id_type: 'open_id' },
  });
  assertLarkOk(res, `removeChatMembers for ${chatId}`);
}

// ---------------------------------------------------------------------------
// listChatMembersFeishu
// ---------------------------------------------------------------------------

/**
 * List members of a chat.
 *
 * Returns a single page (up to 100 members) to avoid unnecessary data
 * overhead for large groups.  Use the returned `pageToken` to fetch
 * subsequent pages when needed.
 */
export async function listChatMembersFeishu(params: {
  cfg: OpenClawConfig;
  chatId: string;
  accountId?: string;
  /** Optional page token for pagination. */
  pageToken?: string;
}): Promise<{ members: FeishuChatMember[]; pageToken?: string; hasMore: boolean }> {
  const { cfg, chatId, accountId, pageToken } = params;
  const client = LarkClient.fromCfg(cfg, accountId).sdk;

  const response = await client.im.v1.chatMembers.get({
    path: { chat_id: chatId },
    params: {
      member_id_type: 'open_id',
      page_size: 100,
      ...(pageToken ? { page_token: pageToken } : {}),
    },
  });
  assertLarkOk(response, `listChatMembers for ${chatId}`);

  const members: FeishuChatMember[] = [];
  const items = (response?.data as any)?.items;
  if (items && Array.isArray(items)) {
    for (const item of items) {
      members.push({
        memberId: item.member_id ?? '',
        name: item.name ?? '',
        memberIdType: item.member_id_type ?? 'open_id',
      });
    }
  }

  const nextPageToken: string | undefined = (response?.data as any)?.page_token ?? undefined;
  const hasMore = (response?.data as any)?.has_more === true && !!nextPageToken;

  return { members, pageToken: nextPageToken, hasMore };
}
