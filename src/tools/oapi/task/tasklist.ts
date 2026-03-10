/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_task_tasklist tool -- Manage Feishu task lists.
 *
 * P0 Actions: create, get, list, tasks
 * P1 Actions: patch, delete, add_members, remove_members
 *
 * Uses the Feishu Task v2 API:
 *   - create: POST /open-apis/task/v2/tasklists
 *   - get:    GET  /open-apis/task/v2/tasklists/:tasklist_guid
 *   - list:   GET  /open-apis/task/v2/tasklists
 *   - tasks:  GET  /open-apis/task/v2/tasklists/:tasklist_guid/tasks
 *   - patch:  PATCH /open-apis/task/v2/tasklists/:tasklist_guid
 *   - delete: DELETE /open-apis/task/v2/tasklists/:tasklist_guid
 *   - add_members: POST /open-apis/task/v2/tasklists/:tasklist_guid/add_members
 *   - remove_members: POST /open-apis/task/v2/tasklists/:tasklist_guid/remove_members
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';

import { json, createToolContext, assertLarkOk, handleInvokeErrorWithAutoAuth } from '../helpers';
import type { PaginatedData } from '../sdk-types';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuTaskTasklistSchema = Type.Union([
  // CREATE (P0)
  Type.Object({
    action: Type.Literal('create'),
    name: Type.String({
      description: '清单名称',
    }),
    members: Type.Optional(
      Type.Array(
        Type.Object({
          id: Type.String({ description: '成员 open_id' }),
          role: Type.Optional(Type.Union([Type.Literal('editor'), Type.Literal('viewer')])),
        }),
        {
          description:
            '清单成员列表（editor=可编辑，viewer=可查看）。注意：创建人自动成为 owner，如在 members 中也指定创建人，该用户最终成为 owner 并从 members 中移除（同一用户只能有一个角色）',
        },
      ),
    ),
  }),

  // GET (P0)
  Type.Object({
    action: Type.Literal('get'),
    tasklist_guid: Type.String({ description: '清单 GUID' }),
  }),

  // LIST (P0)
  Type.Object({
    action: Type.Literal('list'),
    page_size: Type.Optional(Type.Number({ description: '每页数量，默认 50，最大 100' })),
    page_token: Type.Optional(Type.String({ description: '分页标记' })),
  }),

  // TASKS (P0) - 列出清单内的任务
  Type.Object({
    action: Type.Literal('tasks'),
    tasklist_guid: Type.String({ description: '清单 GUID' }),
    page_size: Type.Optional(Type.Number({ description: '每页数量，默认 50，最大 100' })),
    page_token: Type.Optional(Type.String({ description: '分页标记' })),
    completed: Type.Optional(Type.Boolean({ description: '是否只返回已完成的任务（默认返回所有）' })),
  }),

  // PATCH (P1)
  Type.Object({
    action: Type.Literal('patch'),
    tasklist_guid: Type.String({ description: '清单 GUID' }),
    name: Type.Optional(Type.String({ description: '新的清单名称' })),
  }),

  // DELETE (P1)
  Type.Object({
    action: Type.Literal('delete'),
    tasklist_guid: Type.String({ description: '清单 GUID' }),
  }),

  // ADD_MEMBERS (P1)
  Type.Object({
    action: Type.Literal('add_members'),
    tasklist_guid: Type.String({ description: '清单 GUID' }),
    members: Type.Array(
      Type.Object({
        id: Type.String({ description: '成员 open_id' }),
        role: Type.Optional(Type.Union([Type.Literal('editor'), Type.Literal('viewer')])),
      }),
      { description: '要添加的成员列表' },
    ),
  }),

  // REMOVE_MEMBERS (P1)
  Type.Object({
    action: Type.Literal('remove_members'),
    tasklist_guid: Type.String({ description: '清单 GUID' }),
    members: Type.Array(
      Type.Object({
        id: Type.String({ description: '成员 open_id' }),
        type: Type.Optional(Type.Union([Type.Literal('user'), Type.Literal('chat'), Type.Literal('app')])),
      }),
      {
        description: '要移除的成员列表。注意：移除成员时不需要传 role 字段',
      },
    ),
  }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuTaskTasklistParams =
  | {
      action: 'create';
      name: string;
      members?: Array<{ id: string; role?: string }>;
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
      action: 'delete';
      tasklist_guid: string;
    }
  | {
      action: 'add_members';
      tasklist_guid: string;
      members: Array<{ id: string; role?: string }>;
    }
  | {
      action: 'remove_members';
      tasklist_guid: string;
      members: Array<{ id: string; type?: string }>;
    };

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFeishuTaskTasklistTool(api: OpenClawPluginApi) {
  if (!api.config) return;
  const cfg = api.config;

  const { toolClient, log } = createToolContext(api, 'feishu_task_tasklist');

  api.registerTool(
    {
      name: 'feishu_task_tasklist',
      label: 'Feishu Task Lists',
      description:
        '【以用户身份】飞书任务清单管理工具。当用户要求创建/查询/管理清单、查看清单内的任务时使用。Actions: create（创建清单）, get（获取清单详情）, list（列出所有可读取的清单，包括我创建的和他人共享给我的）, tasks（列出清单内的任务）, patch（更新清单）, delete（删除清单）, add_members（添加成员）, remove_members（移除成员）。',
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
                  type: 'user',
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
                { as: 'user' },
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
                { as: 'user' },
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
                { as: 'user' },
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
                { as: 'user' },
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
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`patch: updated tasklist ${p.tasklist_guid}`);

              return json({
                tasklist: res.data?.tasklist,
              });
            }

            // -----------------------------------------------------------------
            // DELETE
            // -----------------------------------------------------------------
            case 'delete': {
              log.info(`delete: tasklist_guid=${p.tasklist_guid}`);

              const res = await client.invoke(
                'feishu_task_tasklist.delete',
                (sdk, opts) =>
                  sdk.task.v2.tasklist.delete(
                    {
                      path: {
                        tasklist_guid: p.tasklist_guid,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`delete: deleted tasklist ${p.tasklist_guid}`);

              return json({
                success: true,
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
                type: 'user',
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
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`add_members: added ${p.members.length} members to tasklist ${p.tasklist_guid}`);

              return json({
                tasklist: res.data?.tasklist,
              });
            }

            // -----------------------------------------------------------------
            // REMOVE_MEMBERS
            // -----------------------------------------------------------------
            case 'remove_members': {
              if (!p.members || p.members.length === 0) {
                return json({
                  error: 'members is required and cannot be empty',
                });
              }

              log.info(`remove_members: tasklist_guid=${p.tasklist_guid}, members_count=${p.members.length}`);

              const memberData = p.members.map((m) => ({
                id: m.id,
                type: m.type || 'user',
              }));

              const res = await client.invoke(
                'feishu_task_tasklist.remove_members',
                (sdk, opts) =>
                  sdk.task.v2.tasklist.removeMembers(
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
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`remove_members: removed ${p.members.length} members from tasklist ${p.tasklist_guid}`);

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

  api.logger.info?.('feishu_task_tasklist: Registered feishu_task_tasklist tool');
}
