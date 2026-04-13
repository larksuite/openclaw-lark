/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_task_tasklist tool -- Manage Feishu task lists.
 *
 * P0 Actions: create, get, list, tasks 支持通过 auth_type 参数切换用户(user)或应用(tenant)身份。
 * P1 Actions: patch, add_members
 *
 * Uses the Feishu Task v2 API:
 *   - create: POST /open-apis/task/v2/tasklists
 *   - get:    GET  /open-apis/task/v2/tasklists/:tasklist_guid
 *   - list:   GET  /open-apis/task/v2/tasklists
 *   - tasks:  GET  /open-apis/task/v2/tasklists/:tasklist_guid/tasks
 *   - patch:  PATCH /open-apis/task/v2/tasklists/:tasklist_guid
 *   - add_members: POST /open-apis/task/v2/tasklists/:tasklist_guid/add_members
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';

import { StringEnum, assertLarkOk, createToolContext, handleInvokeErrorWithAutoAuth, json, registerTool } from '../helpers';
import type { PaginatedData } from '../sdk-types';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuTaskTasklistAuthType = Type.Optional(
  StringEnum(['tenant', 'user'], {
    description: '调用 API 时使用的 Token 类型。可选值："tenant"（应用身份） 或 "user"（用户身份）。默认使用 "user"。',
  }),
);

const FeishuTaskTasklistSchema = Type.Union([
    // CREATE (P0)
    Type.Object({
      action: Type.Literal('create'),
      auth_type: FeishuTaskTasklistAuthType,
      name: Type.String({
        description: '清单名称',
      }),
      members: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.String({ description: '成员 ID（通常为 open_id）' }),
            type: Type.Optional(StringEnum(['user', 'app'])),
            role: Type.Optional(StringEnum(['editor', 'viewer'])),
          }),
          {
            description:
              '清单成员列表（editor=可编辑，viewer=可查看）。注意：创建人自动成为 owner，如在 members 中也指定创建人，该用户最终成为 owner 并从 members 中移除（同一用户只能有一个角色）。成员类型支持 user 和 app，默认为 user。',
          },
        ),
      ),
      user_id_type: Type.Optional(StringEnum(['open_id', 'union_id', 'user_id'])),
    }),

    // GET (P0)
    Type.Object({
      action: Type.Literal('get'),
      auth_type: FeishuTaskTasklistAuthType,
      tasklist_guid: Type.String({ description: '清单 GUID' }),
      user_id_type: Type.Optional(StringEnum(['open_id', 'union_id', 'user_id'])),
    }),

    // LIST (P0)
    Type.Object({
      action: Type.Literal('list'),
      auth_type: FeishuTaskTasklistAuthType,
      page_size: Type.Optional(Type.Number({ description: '每页数量，默认 50，最大 100' })),
      page_token: Type.Optional(Type.String({ description: '分页标记' })),
      user_id_type: Type.Optional(StringEnum(['open_id', 'union_id', 'user_id'])),
    }),

    // TASKS (P0) - 列出清单内的任务
    Type.Object({
      action: Type.Literal('tasks'),
      auth_type: FeishuTaskTasklistAuthType,
      tasklist_guid: Type.String({ description: '清单 GUID' }),
      page_size: Type.Optional(Type.Number({ description: '每页数量，默认 50，最大 100' })),
      page_token: Type.Optional(Type.String({ description: '分页标记' })),
      completed: Type.Optional(Type.Boolean({ description: '是否只返回已完成的任务（默认返回所有）' })),
      user_id_type: Type.Optional(StringEnum(['open_id', 'union_id', 'user_id'])),
    }),

    // PATCH (P1)
    Type.Object({
      action: Type.Literal('patch'),
      auth_type: FeishuTaskTasklistAuthType,
      tasklist_guid: Type.String({ description: '清单 GUID' }),
      name: Type.Optional(Type.String({ description: '新的清单名称' })),
      user_id_type: Type.Optional(StringEnum(['open_id', 'union_id', 'user_id'])),
    }),

    // ADD_MEMBERS (P1)
    Type.Object({
      action: Type.Literal('add_members'),
      auth_type: FeishuTaskTasklistAuthType,
      tasklist_guid: Type.String({ description: '清单 GUID' }),
      members: Type.Array(
        Type.Object({
          id: Type.String({ description: '成员 ID（通常为 open_id）' }),
          type: Type.Optional(StringEnum(['user', 'app'])),
          role: Type.Optional(StringEnum(['editor', 'viewer'])),
        }),
        { description: '要添加的成员列表' },
      ),
      user_id_type: Type.Optional(StringEnum(['open_id', 'union_id', 'user_id'])),
    }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuTaskTasklistParams = { auth_type?: 'tenant' | 'user' } & (
  | {
      action: 'create';
      name: string;
      members?: Array<{ id: string;
        type?: 'user' | 'app';
        role?: string }>;
    }
  | {
      action: 'get';
      tasklist_guid: string;
    }
  | {
      action: 'list';
      page_size?: number;
      page_token?: string;
    }
  | {
      action: 'tasks';
      tasklist_guid: string;
      page_size?: number;
      page_token?: string;
      completed?: boolean;
    }
  | {
      action: 'patch';
      tasklist_guid: string;
      name?: string;
    }
  | {
      action: 'add_members';
      tasklist_guid: string;
      members: Array<{ id: string;
        type?: 'user' | 'app';
        role?: string }>;
      }
);

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFeishuTaskTasklistTool(api: OpenClawPluginApi): void {
  if (!api.config) return;
  const cfg = api.config;

  const { toolClient, log } = createToolContext(api, 'feishu_task_tasklist');

  registerTool(
    api,
    {
      name: 'feishu_task_tasklist',
      label: 'Feishu Task Lists',
      description:
        '【以用户或应用身份】飞书任务清单管理工具。当用户要求创建/查询/管理清单、查看清单内的任务时使用。Actions: create（创建清单）, get（获取清单详情）, list（列出所有可读取的清单，包括我创建的和他人共享给我的）, tasks（列出清单内的任务）, patch（更新清单）, add_members（添加成员）。',
      parameters: FeishuTaskTasklistSchema,
      async execute(_toolCallId, params) {
        const p = params as FeishuTaskTasklistParams;

        try {
          const client = toolClient();

          switch (p.action) {
            // -----------------------------------------------------------------
            // CREATE
            // -----------------------------------------------------------------
            case 'create': {
              log.info(`create: name=${p.name}, members_count=${p.members?.length ?? 0}`);

              const data: any = { name: p.name };

              // 转换成员格式
              if (p.members && p.members.length > 0) {
                data.members = p.members.map((m) => ({
                  id: m.id,
                  type: m.type || 'user',
                  role: m.role || 'editor',
                }));
              }

              const res = await client.invoke(
                'feishu_task_tasklist.create',
                (sdk, opts) =>
                  sdk.task.v2.tasklist.create(
                    {
                      params: {
                        user_id_type: 'open_id' as any,
                      },
                      data,
                    },
                    opts,
                  ),
                { as: p.auth_type || 'user' },
              );
              assertLarkOk(res);

              log.info(`create: created tasklist ${res.data?.tasklist?.guid}`);

              return json({
                tasklist: res.data?.tasklist,
              });
            }

            // -----------------------------------------------------------------
            // GET
            // -----------------------------------------------------------------
            case 'get': {
              log.info(`get: tasklist_guid=${p.tasklist_guid}`);

              const res = await client.invoke(
                'feishu_task_tasklist.get',
                (sdk, opts) =>
                  sdk.task.v2.tasklist.get(
                    {
                      path: {
                        tasklist_guid: p.tasklist_guid,
                      },
                      params: {
                        user_id_type: 'open_id' as any,
                      },
                    },
                    opts,
                  ),
                { as: p.auth_type || 'user' },
              );
              assertLarkOk(res);

              log.info(`get: returned tasklist ${p.tasklist_guid}`);

              return json({
                tasklist: res.data?.tasklist,
              });
            }

            // -----------------------------------------------------------------
            // LIST
            // -----------------------------------------------------------------
            case 'list': {
              log.info(`list: page_size=${p.page_size ?? 50}`);

              const res = await client.invoke(
                'feishu_task_tasklist.list',
                (sdk, opts) =>
                  sdk.task.v2.tasklist.list(
                    {
                      params: {
                        page_size: p.page_size,
                        page_token: p.page_token,
                        user_id_type: 'open_id' as any,
                      },
                    },
                    opts,
                  ),
                { as: p.auth_type || 'user' },
              );
              assertLarkOk(res);

              const data = res.data as PaginatedData | undefined;
              log.info(`list: returned ${data?.items?.length ?? 0} tasklists`);

              return json({
                tasklists: data?.items,
                has_more: data?.has_more ?? false,
                page_token: data?.page_token,
              });
            }

            // -----------------------------------------------------------------
            // TASKS - 列出清单内的任务
            // -----------------------------------------------------------------
            case 'tasks': {
              log.info(`tasks: tasklist_guid=${p.tasklist_guid}, completed=${p.completed ?? 'all'}`);

              const res = await client.invoke(
                'feishu_task_tasklist.tasks',
                (sdk, opts) =>
                  sdk.task.v2.tasklist.tasks(
                    {
                      path: {
                        tasklist_guid: p.tasklist_guid,
                      },
                      params: {
                        page_size: p.page_size,
                        page_token: p.page_token,
                        completed: p.completed,
                        user_id_type: 'open_id' as any,
                      },
                    },
                    opts,
                  ),
                { as: p.auth_type || 'user' },
              );
              assertLarkOk(res);

              const data = res.data as PaginatedData | undefined;
              log.info(`tasks: returned ${data?.items?.length ?? 0} tasks`);

              return json({
                tasks: data?.items,
                has_more: data?.has_more ?? false,
                page_token: data?.page_token,
              });
            }

            // -----------------------------------------------------------------
            // PATCH
            // -----------------------------------------------------------------
            case 'patch': {
              log.info(`patch: tasklist_guid=${p.tasklist_guid}, name=${p.name}`);

              // 飞书 Task API 要求特殊的更新格式
              const tasklistData: any = {};
              const updateFields: string[] = [];

              if (p.name !== undefined) {
                tasklistData.name = p.name;
                updateFields.push('name');
              }

              if (updateFields.length === 0) {
                return json({
                  error: 'No fields to update',
                });
              }

              const res = await client.invoke(
                'feishu_task_tasklist.patch',
                (sdk, opts) =>
                  sdk.task.v2.tasklist.patch(
                    {
                      path: {
                        tasklist_guid: p.tasklist_guid,
                      },
                      params: {
                        user_id_type: 'open_id' as any,
                      },
                      data: {
                        tasklist: tasklistData,
                        update_fields: updateFields,
                      },
                    },
                    opts,
                  ),
                { as: p.auth_type || 'user' },
              );
              assertLarkOk(res);

              log.info(`patch: updated tasklist ${p.tasklist_guid}`);

              return json({
                tasklist: res.data?.tasklist,
              });
            }

            // -----------------------------------------------------------------
            // ADD_MEMBERS
            // -----------------------------------------------------------------
            case 'add_members': {
              if (!p.members || p.members.length === 0) {
                return json({
                  error: 'members is required and cannot be empty',
                });
              }

              log.info(`add_members: tasklist_guid=${p.tasklist_guid}, members_count=${p.members.length}`);

              const memberData = p.members.map((m) => ({
                id: m.id,
                type: m.type || 'user',
                role: m.role || 'editor',
              }));

              const res = await client.invoke(
                'feishu_task_tasklist.add_members',
                (sdk, opts) =>
                  sdk.task.v2.tasklist.addMembers(
                    {
                      path: {
                        tasklist_guid: p.tasklist_guid,
                      },
                      params: {
                        user_id_type: 'open_id' as any,
                      },
                      data: {
                        members: memberData,
                      },
                    },
                    opts,
                  ),
                { as: p.auth_type || 'user' },
              );
              assertLarkOk(res);

              log.info(`add_members: added ${p.members.length} members to tasklist ${p.tasklist_guid}`);

              return json({
                tasklist: res.data?.tasklist,
              });
            }

          }
        } catch (err) {
          return await handleInvokeErrorWithAutoAuth(err, cfg);
        }
      },
    },
    { name: 'feishu_task_tasklist' },
  );

}
