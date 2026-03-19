/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_chat tool -- 管理飞书群聊
 *
 * Actions:
 *   - search: 搜索对用户或机器人可见的群列表
 *   - get:    获取指定群的详细信息
 *
 * Uses the Feishu IM v1 API:
 *   - search: GET /open-apis/im/v1/chats/search
 *   - get:    GET /open-apis/im/v1/chats/:chat_id
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';
import { json, createToolContext, assertLarkOk, handleInvokeErrorWithAutoAuth, registerTool, StringEnum } from '../helpers';
import type { PaginatedData } from '../sdk-types';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuChatSchema = Type.Union([
  // SEARCH
  Type.Object({
    action: Type.Literal('search'),
    query: Type.String({
      description: '搜索关键词（必填）。支持匹配群名称、群成员名称。' + '支持多语种、拼音、前缀等模糊搜索。',
    }),
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
    user_id_type: Type.Optional(
      StringEnum(['open_id', 'union_id', 'user_id'], {
        description: '用户 ID 类型（默认 open_id）',
      }),
    ),
  }),

  // GET
  Type.Object({
    action: Type.Literal('get'),
    chat_id: Type.String({
      description: '群 ID（格式如 oc_xxx）',
    }),
    user_id_type: Type.Optional(
      StringEnum(['open_id', 'union_id', 'user_id'], {
        description: '用户 ID 类型（默认 open_id）',
      }),
    ),
  }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuChatParams =
  | {
      action: 'search';
      query: string;
      page_size?: number;
      page_token?: string;
      user_id_type?: 'open_id' | 'union_id' | 'user_id';
    }
  | {
      action: 'get';
      chat_id: string;
      user_id_type?: 'open_id' | 'union_id' | 'user_id';
    };

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerChatSearchTool(api: OpenClawPluginApi): boolean {
  if (!api.config) return false;
  const cfg = api.config;

  const { toolClient, log } = createToolContext(api, 'feishu_chat');

  return registerTool(
    api,
    {
      name: 'feishu_chat',
      label: 'Feishu: Chat Management',
      description:
        '以用户身份调用飞书群聊管理工具。Actions: search（搜索群列表，支持关键词匹配群名称、群成员）, get（获取指定群的详细信息，包括群名称、描述、头像、群主、权限配置等）。',
      parameters: FeishuChatSchema,
      async execute(_toolCallId: string, params: unknown) {
        const p = params as FeishuChatParams;
        try {
          const client = toolClient();

          switch (p.action) {
            // -----------------------------------------------------------------
            // SEARCH
            // -----------------------------------------------------------------
            case 'search': {
              log.info(`search: query="${p.query}", page_size=${p.page_size ?? 20}`);

              const res = await client.invoke(
                'feishu_chat.search',
                (sdk, opts) =>
                  sdk.im.v1.chat.search(
                    {
                      params: {
                        user_id_type: p.user_id_type || 'open_id',
                        query: p.query,
                        page_size: p.page_size,
                        page_token: p.page_token,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              const data = res.data as PaginatedData | undefined;
              const chatCount = data?.items?.length ?? 0;
              log.info(`search: found ${chatCount} chats`);

              return json({
                items: data?.items,
                has_more: data?.has_more ?? false,
                page_token: data?.page_token,
              });
            }

            // -----------------------------------------------------------------
            // GET
            // -----------------------------------------------------------------
            case 'get': {
              log.info(`get: chat_id=${p.chat_id}, user_id_type=${p.user_id_type ?? 'open_id'}`);

              const res = await client.invoke(
                'feishu_chat.get',
                (sdk, opts) =>
                  sdk.im.v1.chat.get(
                    {
                      path: {
                        chat_id: p.chat_id,
                      },
                      params: {
                        user_id_type: p.user_id_type || 'open_id',
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

              log.info(`get: retrieved chat info for ${p.chat_id}`);

              return json({
                chat: res.data,
              });
            }
          }
        } catch (err) {
          return await handleInvokeErrorWithAutoAuth(err, cfg);
        }
      },
    },
    { name: 'feishu_chat' },
  );
}
