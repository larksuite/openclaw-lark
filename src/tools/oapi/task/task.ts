/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_task_task tool -- Manage Feishu tasks.
 *
 * P0 Actions: create, get, list, patch
 * P1 Actions: add_members, append_steps
 *
 * Uses the Feishu Task v2 API:
 *   - create: POST /open-apis/task/v2/tasks
 *   - get:    GET  /open-apis/task/v2/tasks/:task_guid
 *   - list:   GET  /open-apis/task/v2/tasks
 *   - patch:  PATCH /open-apis/task/v2/tasks/:task_guid
 *   - add_members: POST /open-apis/task/v2/tasks/:task_guid/add_members
 *   - append_steps: POST /open-apis/task/v2/agent_task_step_info/append_task_steps
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';
import {
  StringEnum,
  assertLarkOk,
  createToolContext,
  handleInvokeErrorWithAutoAuth,
  json,
  parseTimeToTimestampMs,
  registerTool,
} from '../helpers';
import type { PaginatedData, TaskCreateData } from '../sdk-types';
import { rawLarkRequest } from '../../../core/raw-request';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuTaskTaskSchema = Type.Union([
  // CREATE
  Type.Object({
    action: Type.Literal('create'),
    summary: Type.String({
      description: '任务标题',
    }),
    current_user_id: Type.Optional(
      Type.String({
        description:
          '当前用户的 open_id（强烈建议，从消息上下文的 SenderId 获取）。如果 members 中不包含此用户，工具会自动添加为 follower，确保创建者可以编辑任务。',
      }),
    ),
    description: Type.Optional(
      Type.String({
        description: '任务描述',
      }),
    ),
    due: Type.Optional(
      Type.Object({
        timestamp: Type.String({
          description: "截止时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）",
        }),
        is_all_day: Type.Optional(
          Type.Boolean({
            description: '是否为全天任务',
          }),
        ),
      }),
    ),
    start: Type.Optional(
      Type.Object({
        timestamp: Type.String({
          description: "开始时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）",
        }),
        is_all_day: Type.Optional(
          Type.Boolean({
            description: '是否为全天',
          }),
        ),
      }),
    ),
    members: Type.Optional(
      Type.Array(
        Type.Object({
          id: Type.String({
            description: '成员 ID（通常为 open_id）',
          }),
          type: Type.Optional(StringEnum(['user', 'app'])),
          role: Type.Optional(StringEnum(['assignee', 'follower'])),
        }),
        {
          description:
            '任务成员列表（assignee=负责人，follower=关注人）。成员类型（type）支持 user 和 app，默认为 user。机器人和应用应该使用app',
        },
      ),
    ),
    repeat_rule: Type.Optional(
      Type.String({
        description: '重复规则（RRULE 格式）',
      }),
    ),
    tasklists: Type.Optional(
      Type.Array(
        Type.Object({
          tasklist_guid: Type.String({
            description: '清单 GUID',
          }),
          section_guid: Type.Optional(
            Type.String({
              description: '分组 GUID',
            }),
          ),
        }),
        {
          description: '任务所属清单列表',
        },
      ),
    ),
    auth_type: Type.Optional(
      StringEnum(['tenant', 'user'], {
        description:
          '授权类型，默认 user。使用 user 时为用户身份（只能查看/操作自己有权限的任务），使用 tenant 时为应用身份。',
      }),
    ),
    user_id_type: Type.Optional(
      StringEnum(['open_id', 'union_id', 'user_id']),
    ),
  }),

  // GET
  Type.Object({
    action: Type.Literal('get'),
    task_guid: Type.String({
      description: 'Task GUID',
    }),
    auth_type: Type.Optional(
      StringEnum(['tenant', 'user'], {
        description: '授权类型，默认 user。',
      }),
    ),
    user_id_type: Type.Optional(
      StringEnum(['open_id', 'union_id', 'user_id']),
    ),
  }),

  // LIST
  Type.Object({
    action: Type.Literal('list'),
    page_size: Type.Optional(
      Type.Number({
        description: '每页数量（默认 50，最大 100）。',
      }),
    ),
    page_token: Type.Optional(
      Type.String({
        description: '分页标记',
      }),
    ),
    completed: Type.Optional(
      Type.Boolean({
        description: '是否筛选已完成任务',
      }),
    ),
    agent_task_status: Type.Optional(
      Type.Integer({
        description: 'Agent 任务状态',
      }),
    ),
    auth_type: Type.Optional(
      StringEnum(['tenant', 'user'], {
        description: '授权类型，默认 user。',
      }),
    ),
    user_id_type: Type.Optional(
      StringEnum(['open_id', 'union_id', 'user_id']),
    ),
  }),

  // PATCH
  Type.Object({
    action: Type.Literal('patch'),
    task_guid: Type.String({
      description: 'Task GUID',
    }),
    summary: Type.Optional(
      Type.String({
        description: '新的任务标题',
      }),
    ),
    description: Type.Optional(
      Type.String({
        description: '新的任务描述',
      }),
    ),
    due: Type.Optional(
      Type.Object({
        timestamp: Type.String({
          description: "新的截止时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）",
        }),
        is_all_day: Type.Optional(
          Type.Boolean({
            description: '是否为全天任务',
          }),
        ),
      }),
    ),
    start: Type.Optional(
      Type.Object({
        timestamp: Type.String({
          description: "新的开始时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）",
        }),
        is_all_day: Type.Optional(
          Type.Boolean({
            description: '是否为全天',
          }),
        ),
      }),
    ),
    completed_at: Type.Optional(
      Type.String({
        description:
          "完成时间。支持三种格式：1) ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'（设为已完成）；2) '0'（反完成，任务变为未完成）；3) 毫秒时间戳字符串。",
      }),
    ),
    agent_task_progress: Type.Optional(
      Type.String({
        description: 'Agent 任务进度',
      }),
    ),
    agent_task_status: Type.Optional(
      Type.Integer({
        description: 'Agent 任务状态',
      }),
    ),
    text_deliveries: Type.Optional(
      Type.Array(Type.String(), {
        description: '文本交付列表',
      }),
    ),
    members: Type.Optional(
      Type.Array(
        Type.Object({
          id: Type.String({
            description: '成员 ID（通常为 open_id）',
          }),
          type: Type.Optional(StringEnum(['user', 'app'])),
          role: Type.Optional(StringEnum(['assignee', 'follower'])),
        }),
        {
          description: '新的任务成员列表。成员类型支持 user 和 app，默认为 user。',
        },
      ),
    ),
    repeat_rule: Type.Optional(
      Type.String({
        description: '新的重复规则（RRULE 格式）',
      }),
    ),
    auth_type: Type.Optional(
      StringEnum(['tenant', 'user'], {
        description: '授权类型，默认 user。',
      }),
    ),
    user_id_type: Type.Optional(
      StringEnum(['open_id', 'union_id', 'user_id']),
    ),
  }),

  // ADD_MEMBERS
  Type.Object({
    action: Type.Literal('add_members'),
    task_guid: Type.String({
      description: 'Task GUID',
    }),
    members: Type.Array(
      Type.Object({
        id: Type.String({
          description: '成员 ID（通常为 open_id）',
        }),
        type: Type.Optional(StringEnum(['user', 'app'])),
        role: Type.Optional(StringEnum(['assignee', 'follower'])),
      }),
      {
        description:
          '要添加的成员列表（assignee=负责人，follower=关注人）。成员类型支持 user 和 app，默认为 user。',
      },
    ),
    client_token: Type.Optional(
      Type.String({
        description: '幂等token，如果提供则实现幂等行为',
      }),
    ),
    auth_type: Type.Optional(
      StringEnum(['tenant', 'user'], {
        description: '授权类型，默认 user。',
      }),
    ),
    user_id_type: Type.Optional(
      StringEnum(['open_id', 'union_id', 'user_id']),
    ),
  }),

  // APPEND_STEPS
  Type.Object({
    action: Type.Literal('append_steps'),
    task_guid: Type.String({
      description: '任务 GUID',
    }),
    idempotent_key: Type.String({
      description: '幂等键',
    }),
    task_steps: Type.Array(
      Type.Object({
        quote: Type.String({
          description: '步骤引用信息',
        }),
        content: Type.String({
          description: '步骤内容',
        }),
        timestamp: Type.Integer({
          description: '步骤时间戳',
        }),
      }),
      {
        description: '要追加的任务步骤列表',
        minItems: 1,
      },
    ),
  }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuTaskTaskParams =
  | {
    action: 'create';
    summary: string;
    current_user_id?: string;
    description?: string;
    due?: {
      timestamp: string;
      is_all_day?: boolean;
    };
    start?: {
      timestamp: string;
      is_all_day?: boolean;
    };
    members?: Array<{
      id: string;
      type?: 'user' | 'app';
      role?: 'assignee' | 'follower';
    }>;
    repeat_rule?: string;
    tasklists?: Array<{
      tasklist_guid: string;
      section_guid?: string;
    }>;
    auth_type?: 'tenant' | 'user';
    user_id_type?: 'open_id' | 'union_id' | 'user_id';
  }
  | {
    action: 'get';
    task_guid: string;
    auth_type?: 'tenant' | 'user';
    user_id_type?: 'open_id' | 'union_id' | 'user_id';
  }
  | {
    action: 'list';
    page_size?: number;
    page_token?: string;
    completed?: boolean;
    agent_task_status?: number;
    auth_type?: 'tenant' | 'user';
    user_id_type?: 'open_id' | 'union_id' | 'user_id';
  }
  | {
    action: 'patch';
    task_guid: string;
    summary?: string;
    description?: string;
    due?: {
      timestamp: string;
      is_all_day?: boolean;
    };
    start?: {
      timestamp: string;
      is_all_day?: boolean;
    };
    completed_at?: string;
    agent_task_progress?: string;
    agent_task_status?: number;
    text_deliveries?: string[];
    members?: Array<{
      id: string;
      type?: 'user' | 'app';
      role?: 'assignee' | 'follower';
    }>;
    repeat_rule?: string;
    auth_type?: 'tenant' | 'user';
    user_id_type?: 'open_id' | 'union_id' | 'user_id';
  }
  | {
    action: 'add_members';
    task_guid: string;
    members: Array<{
      id: string;
      type?: 'user' | 'app';
      role?: 'assignee' | 'follower';
    }>;
    client_token?: string;
    auth_type?: 'tenant' | 'user';
    user_id_type?: 'open_id' | 'union_id' | 'user_id';
  }
  | {
    action: 'append_steps';
    task_guid: string;
    idempotent_key: string;
    task_steps: Array<{
      quote: string;
      content: string;
      timestamp: number;
    }>;
  };

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFeishuTaskTaskTool(api: OpenClawPluginApi): void {
  if (!api.config) return;
  const cfg = api.config;

  const { toolClient, log } = createToolContext(api, 'feishu_task_task');

  registerTool(
    api,
    {
      name: 'feishu_task_task',
      label: 'Feishu Task Management',
      description:
        "【以用户或应用身份】飞书任务管理工具。用于创建、查询、更新任务。Actions: create（创建任务）, get（获取任务详情）, list（查询任务列表，仅返回我负责的任务）, patch（更新任务）, add_members（添加任务成员）, append_steps（追加任务步骤记录）。时间参数使用ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'。支持通过 auth_type 参数切换用户(user)或应用(tenant)身份；append_steps 固定使用应用身份。",
      parameters: FeishuTaskTaskSchema,
      async execute(_toolCallId: string, params: unknown) {
        const p = params as FeishuTaskTaskParams;
        try {
          const client = toolClient();

          switch (p.action) {
            // -----------------------------------------------------------------
            // CREATE TASK
            // -----------------------------------------------------------------
            case 'create': {
              log.info(`create: summary=${p.summary}`);

              const taskData: any = {
                summary: p.summary,
              };

              if (p.description) taskData.description = p.description;

              // Handle due time conversion
              if (p.due?.timestamp) {
                const dueTs = parseTimeToTimestampMs(p.due.timestamp);
                if (!dueTs) {
                  return json({
                    error:
                      "due 时间格式错误！必须使用ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'，例如 '2026-02-25 18:00'。",
                    received: p.due.timestamp,
                  });
                }
                taskData.due = {
                  timestamp: dueTs,
                  is_all_day: p.due.is_all_day ?? false,
                };
                log.info(`create: due time converted: ${p.due.timestamp} -> ${dueTs}ms`);
              }

              // Handle start time conversion
              if (p.start?.timestamp) {
                const startTs = parseTimeToTimestampMs(p.start.timestamp);
                if (!startTs) {
                  return json({
                    error:
                      "start 时间格式错误！必须使用ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'。",
                    received: p.start.timestamp,
                  });
                }
                taskData.start = {
                  timestamp: startTs,
                  is_all_day: p.start.is_all_day ?? false,
                };
              }

              if (p.members) taskData.members = p.members;
              if (p.repeat_rule) taskData.repeat_rule = p.repeat_rule;
              if (p.tasklists) taskData.tasklists = p.tasklists;

              const authType = p.auth_type || 'user';
              const res = await client.invoke(
                'feishu_task_task.create',
                (sdk, opts) =>
                  sdk.task.v2.task.create(
                    {
                      data: taskData,
                      params: {
                        user_id_type: (p.user_id_type || 'open_id') as any,
                      },
                    },
                    opts,
                  ),
                { as: authType },
              );
              assertLarkOk(res);

              const data = res.data as TaskCreateData | undefined;
              log.info(`create: task created: task_guid=${data?.task?.guid}`);

              return json({
                task: res.data?.task,
              });
            }

            // -----------------------------------------------------------------
            // GET TASK
            // -----------------------------------------------------------------
            case 'get': {
              log.info(`get: task_guid=${p.task_guid}`);

              const authType = p.auth_type || 'user';
              const res = await client.invoke(
                'feishu_task_task.get',
                (sdk, opts) =>
                  sdk.task.v2.task.get(
                    {
                      path: { task_guid: p.task_guid },
                      params: {
                        user_id_type: (p.user_id_type || 'open_id') as any,
                      },
                    },
                    opts,
                  ),
                { as: authType },
              );
              assertLarkOk(res);

              log.info(`get: retrieved task ${p.task_guid}`);

              return json({
                task: res.data?.task,
              });
            }

            // -----------------------------------------------------------------
            // LIST TASKS
            // -----------------------------------------------------------------
            case 'list': {
              log.info(`list: page_size=${p.page_size ?? 50}, completed=${p.completed ?? false}`);

              const authType = p.auth_type || 'user';
              const res = await client.invoke(
                'feishu_task_task.list',
                (sdk, opts) =>
                  sdk.task.v2.task.list(
                    {
                      params: {
                        page_size: p.page_size,
                        page_token: p.page_token,
                        completed: p.completed,
                        agent_task_status: p.agent_task_status,
                        user_id_type: (p.user_id_type || 'open_id') as any,
                      },
                    },
                    opts,
                  ),
                { as: authType },
              );
              assertLarkOk(res);

              const data = res.data as PaginatedData | undefined;
              log.info(`list: returned ${data?.items?.length ?? 0} tasks`);

              return json({
                tasks: data?.items,
                has_more: data?.has_more ?? false,
                page_token: data?.page_token,
              });
            }

            // -----------------------------------------------------------------
            // PATCH TASK
            // -----------------------------------------------------------------
            case 'patch': {
              log.info(`patch: task_guid=${p.task_guid}`);

              const updateData: any = {};

              if (p.summary) updateData.summary = p.summary;
              if (p.description !== undefined) updateData.description = p.description;

              // Handle due time conversion
              if (p.due?.timestamp) {
                const dueTs = parseTimeToTimestampMs(p.due.timestamp);
                if (!dueTs) {
                  return json({
                    error:
                      "due 时间格式错误！必须使用ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'。",
                    received: p.due.timestamp,
                  });
                }
                updateData.due = {
                  timestamp: dueTs,
                  is_all_day: p.due.is_all_day ?? false,
                };
              }

              // Handle start time conversion
              if (p.start?.timestamp) {
                const startTs = parseTimeToTimestampMs(p.start.timestamp);
                if (!startTs) {
                  return json({
                    error:
                      "start 时间格式错误！必须使用ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'。",
                    received: p.start.timestamp,
                  });
                }
                updateData.start = {
                  timestamp: startTs,
                  is_all_day: p.start.is_all_day ?? false,
                };
              }

              // Handle completed_at conversion
              if (p.completed_at !== undefined) {
                // 特殊值：反完成（设为未完成）
                if (p.completed_at === '0') {
                  updateData.completed_at = '0';
                }
                // 数字字符串时间戳（直通）
                else if (/^\d+$/.test(p.completed_at)) {
                  updateData.completed_at = p.completed_at;
                }
                // 时间格式字符串（需要转换）
                else {
                  const completedTs = parseTimeToTimestampMs(p.completed_at);
                  if (!completedTs) {
                    return json({
                      error:
                        "completed_at 格式错误！支持：1) ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'；2) '0'（反完成）；3) 毫秒时间戳字符串。",
                      received: p.completed_at,
                    });
                  }
                  updateData.completed_at = completedTs;
                }
              }

              if (p.agent_task_progress !== undefined) {
                updateData.agent_task_progress = p.agent_task_progress;
              }
              if (p.agent_task_status !== undefined) {
                updateData.agent_task_status = p.agent_task_status;
              }
              if (p.text_deliveries !== undefined) {
                updateData.text_deliveries = p.text_deliveries;
              }

              if (p.members) updateData.members = p.members;
              if (p.repeat_rule) updateData.repeat_rule = p.repeat_rule;

              // Build update_fields list (required by Task API)
              const updateFields = Object.keys(updateData);
              if (updateFields.length === 0) {
                return json({
                  error:
                    'patch 至少需要提供一个可更新字段：summary、description、due、start、completed_at、agent_task_progress、agent_task_status、text_deliveries、members、repeat_rule',
                });
              }

              const authType = p.auth_type || 'user';
              const res = await client.invoke(
                'feishu_task_task.patch',
                (sdk, opts) =>
                  sdk.task.v2.task.patch(
                    {
                      path: { task_guid: p.task_guid },
                      data: {
                        task: updateData,
                        update_fields: updateFields,
                      },
                      params: {
                        user_id_type: (p.user_id_type || 'open_id') as any,
                      },
                    },
                    opts,
                  ),
                { as: authType },
              );
              assertLarkOk(res);

              log.info(`patch: task ${p.task_guid} updated`);

              return json({
                task: res.data?.task,
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

              log.info(`add_members: task_guid=${p.task_guid}, members_count=${p.members.length}`);

              const memberData = p.members.map((m) => ({
                id: m.id,
                type: m.type || 'user',
                role: m.role || 'follower',
              }));

              const requestData: any = { members: memberData };
              if (p.client_token) {
                requestData.client_token = p.client_token;
              }

              const authType = p.auth_type || 'user';
              const res = await client.invoke(
                'feishu_task_task.add_members',
                (sdk, opts) =>
                  sdk.task.v2.task.addMembers(
                    {
                      path: {
                        task_guid: p.task_guid,
                      },
                      params: {
                        user_id_type: (p.user_id_type || 'open_id') as any,
                      },
                      data: requestData,
                    },
                    opts,
                  ),
                { as: authType },
              );
              assertLarkOk(res);

              log.info(`add_members: added ${p.members.length} members to task ${p.task_guid}`);

              return json({
                task: res.data?.task,
              });
            }

            // -----------------------------------------------------------------
            // APPEND TASK STEPS
            // -----------------------------------------------------------------
            case 'append_steps': {
              if (!p.task_steps.length) {
                return json({
                  error: 'task_steps is required and cannot be empty',
                });
              }

              const tatRes = await rawLarkRequest(
                {
                  brand: client.account.brand,
                  path: '/open-apis/auth/v3/tenant_access_token/internal/',
                  method: 'POST',
                  body: {
                    app_id: client.sdk.appId,
                    app_secret: client.sdk.appSecret,
                  },
                },
              );;
              const token = (tatRes as any)?.tenant_access_token ?? "";

              const res = await client.invokeByPath(
                'feishu_task_task.append_steps',
                '/open-apis/task/v2/agent_task_step_info/append_task_steps',
                {
                  method: 'POST',
                  as: 'tenant',
                  body: {
                    task_guid: p.task_guid,
                    idempotent_key: p.idempotent_key,
                    task_steps: p.task_steps,
                  },
                  headers: {
                    'authorization': `Bearer ${token}`,
                  },
                },
              );
              return json(res);
            }
          }
        } catch (err) {
          return await handleInvokeErrorWithAutoAuth(err, cfg);
        }
      },
    },
    { name: 'feishu_task_task' },
  );
}
