/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_task_comment tool -- Manage Feishu task comments.
 *
 * P1 Actions: create, list, get
 *
 * Uses the Feishu Task v2 API:
 *   - create: POST /open-apis/task/v2/tasks/:task_guid/comments
 *   - list:   GET  /open-apis/task/v2/tasks/:task_guid/comments
 *   - get:    GET  /open-apis/task/v2/comments/:comment_id
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';

import { json, createToolContext, assertLarkOk, handleInvokeErrorWithAutoAuth, registerTool, StringEnum } from '../helpers';
import type { PaginatedData } from '../sdk-types';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuTaskCommentSchema = Type.Union([
  // CREATE (P1)
  Type.Object({
    action: Type.Literal('create'),
    task_guid: Type.String({ description: '任务 GUID' }),
    content: Type.String({ description: '评论内容（纯文本，最长 3000 字符）' }),
    reply_to_comment_id: Type.Optional(Type.String({ description: '要回复的评论 ID（用于回复评论）' })),
  }),

  // LIST (P1)
  Type.Object({
    action: Type.Literal('list'),
    resource_id: Type.String({ description: '要获取评论的资源 ID（任务 GUID）' }),
    direction: Type.Optional(
      StringEnum(['asc', 'desc'], {
        description: '排序方式（asc=从旧到新，desc=从新到旧，默认 asc）',
      }),
    ),
    page_size: Type.Optional(Type.Number({ description: '每页数量，默认 50，最大 100' })),
    page_token: Type.Optional(Type.String({ description: '分页标记' })),
  }),

  // GET (P1)
  Type.Object({
    action: Type.Literal('get'),
    comment_id: Type.String({ description: '评论 ID' }),
  }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuTaskCommentParams =
  | {
      action: 'create';
      task_guid: string;
      content: string;
      reply_to_comment_id?: string;
    }
  | {
      action: 'list';
      resource_id: string;
      direction?: 'asc' | 'desc';
      page_size?: number;
      page_token?: string;
    }
  | {
      action: 'get';
      comment_id: string;
    };

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFeishuTaskCommentTool(api: OpenClawPluginApi) {
  if (!api.config) return;
  const cfg = api.config;

  const { toolClient, log } = createToolContext(api, 'feishu_task_comment');

  registerTool(
    api,
    {
      name: 'feishu_task_comment',
      label: 'Feishu Task Comments',
      description:
        '【以用户身份】飞书任务评论管理工具。当用户要求添加/查询任务评论、回复评论时使用。Actions: create（添加评论）, list（列出任务的所有评论）, get（获取单个评论详情）。',
      parameters: FeishuTaskCommentSchema,
      async execute(_toolCallId, params) {
        const p = params as FeishuTaskCommentParams;

        try {
          const client = toolClient();

          switch (p.action) {
            // -----------------------------------------------------------------
            // CREATE
            // -----------------------------------------------------------------
            case 'create': {
              log.info(`create: task_guid=${p.task_guid}, reply_to=${p.reply_to_comment_id ?? 'none'}`);

              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const data: any = {
                content: p.content,
                resource_type: 'task',
                resource_id: p.task_guid,
              };

              if (p.reply_to_comment_id) {
                data.reply_to_comment_id = p.reply_to_comment_id;
              }

              const res = await client.invoke(
                'feishu_task_comment.create',
                (sdk, opts) =>
                  sdk.task.v2.comment.create(
                    {
                      params: {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        user_id_type: 'open_id' as any,
                      },
                      data,
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`create: created comment ${res.data?.comment?.id}`);

              return json({
                comment: res.data?.comment,
              });
            }

            // -----------------------------------------------------------------
            // LIST
            // -----------------------------------------------------------------
            case 'list': {
              log.info(
                `list: resource_id=${p.resource_id}, direction=${p.direction ?? 'asc'}, page_size=${p.page_size ?? 50}`,
              );

              const res = await client.invoke(
                'feishu_task_comment.list',
                (sdk, opts) =>
                  sdk.task.v2.comment.list(
                    {
                      params: {
                        resource_type: 'task',
                        resource_id: p.resource_id,
                        direction: p.direction,
                        page_size: p.page_size,
                        page_token: p.page_token,
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        user_id_type: 'open_id' as any,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              const data = res.data as PaginatedData | undefined;
              log.info(`list: returned ${data?.items?.length ?? 0} comments`);

              return json({
                comments: data?.items,
                has_more: data?.has_more ?? false,
                page_token: data?.page_token,
              });
            }

            // -----------------------------------------------------------------
            // GET
            // -----------------------------------------------------------------
            case 'get': {
              log.info(`get: comment_id=${p.comment_id}`);

              const res = await client.invoke(
                'feishu_task_comment.get',
                (sdk, opts) =>
                  sdk.task.v2.comment.get(
                    {
                      path: {
                        comment_id: p.comment_id,
                      },
                      params: {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        user_id_type: 'open_id' as any,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`get: returned comment ${p.comment_id}`);

              return json({
                comment: res.data?.comment,
              });
            }
          }
        } catch (err) {
          return await handleInvokeErrorWithAutoAuth(err, cfg);
        }
      },
    },
    { name: 'feishu_task_comment' },
  );

}
