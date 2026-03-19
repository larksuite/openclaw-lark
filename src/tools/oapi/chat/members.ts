/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_chat_members tool -- 获取群成员列表
 *
 * 获取指定群组的成员信息，包括成员名字与 ID
 * 使用 sdk.im.v1.chatMembers.get 接口
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';
import { json, createToolContext, assertLarkOk, handleInvokeErrorWithAutoAuth, registerTool, StringEnum } from '../helpers';
import type { ChatMemberListData } from '../sdk-types';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ChatMembersSchema = Type.Object({
  chat_id: Type.String({
    description: '群 ID（格式如 oc_xxx）。' + '可以通过 feishu_chat_search 工具搜索获取',
  }),
  member_id_type: Type.Optional(
    StringEnum(['open_id', 'union_id', 'user_id']),
  ),
  page_size: Type.Optional(
    Type.Integer({
      description: '分页大小（默认20）',
      minimum: 1,
    }),
  ),
  page_token: Type.Optional(
    Type.String({
      description: '分页标记。首次请求无需填写',
    }),
  ),
});

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

interface ChatMembersParams {
  chat_id: string;
  member_id_type?: 'open_id' | 'union_id' | 'user_id';
  page_size?: number;
  page_token?: string;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerChatMembersTool(api: OpenClawPluginApi): boolean {
  if (!api.config) return false;
  const cfg = api.config;

  const { toolClient, log } = createToolContext(api, 'feishu_chat_members');

  return registerTool(
    api,
    {
      name: 'feishu_chat_members',
      label: 'Feishu: Get Chat Members',
      description:
        '以用户的身份获取指定群组的成员列表。' +
        '返回成员信息，包含成员 ID、姓名等。' +
        '注意：不会返回群组内的机器人成员。',
      parameters: ChatMembersSchema,
      async execute(_toolCallId: string, params: unknown) {
        const p = params as ChatMembersParams;
        try {
          const client = toolClient();

          log.info(`chat_members: chat_id="${p.chat_id}", page_size=${p.page_size ?? 20}`);

          const res = await client.invoke(
            'feishu_chat_members.default',
            (sdk, opts) =>
              sdk.im.v1.chatMembers.get(
                {
                  path: { chat_id: p.chat_id },
                  params: {
                    member_id_type: p.member_id_type || 'open_id',
                    page_size: p.page_size,
                    page_token: p.page_token,
                  },
                },
                {
                  ...(opts ?? {}),
                  headers: {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    ...((opts as any)?.headers ?? {}),
                    'X-Chat-Custom-Header': 'enable_chat_list_security_check',
                  },
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any,
              ),
            { as: 'user' },
          );
          assertLarkOk(res);

          const data = res.data as ChatMemberListData | undefined;
          const memberCount = data?.items?.length ?? 0;
          const memberTotal = data?.member_total ?? 0;
          log.info(`chat_members: found ${memberCount} members (total: ${memberTotal})`);

          return json({
            items: data?.items,
            has_more: data?.has_more ?? false,
            page_token: data?.page_token,
            member_total: memberTotal,
          });
        } catch (err) {
          return await handleInvokeErrorWithAutoAuth(err, cfg);
        }
      },
    },
    { name: 'feishu_chat_members' },
  );
}
