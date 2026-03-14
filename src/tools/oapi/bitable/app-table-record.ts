/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_bitable_app_table_record tool -- Manage Feishu Bitable records.
 *
 * P0 Actions: create, list, update, delete
 * P1 Actions: batch_create, batch_update, batch_delete
 *
 * Uses the Feishu Bitable v1 API:
 *   - create: POST /open-apis/bitable/v1/apps/:app_token/tables/:table_id/records
 *   - list:   POST /open-apis/bitable/v1/apps/:app_token/tables/:table_id/records/search (旧 list API 已废弃)
 *   - update: PUT  /open-apis/bitable/v1/apps/:app_token/tables/:table_id/records/:record_id
 *   - delete: DELETE /open-apis/bitable/v1/apps/:app_token/tables/:table_id/records/:record_id
 *   - batch_create: POST /open-apis/bitable/v1/apps/:app_token/tables/:table_id/records/batch_create
 *   - batch_update: POST /open-apis/bitable/v1/apps/:app_token/tables/:table_id/records/batch_update
 *   - batch_delete: POST /open-apis/bitable/v1/apps/:app_token/tables/:table_id/records/batch_delete
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';

import { json, createToolContext, assertLarkOk, handleInvokeErrorWithAutoAuth, registerTool, StringEnum } from '../helpers';
import type { PaginatedData } from '../sdk-types';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuBitableAppTableRecordSchema = Type.Union([
  // CREATE (P0)
  Type.Object({
    action: Type.Literal('create'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    fields: Type.Object(
      {},
      {
        additionalProperties: true,
        description:
          "记录字段（单条记录）。键为字段名，值根据字段类型而定：\n- 文本：string\n- 数字：number\n- 单选：string（选项名）\n- 多选：string[]（选项名数组）\n- 日期：number（毫秒时间戳，如 1740441600000）\n- 复选框：boolean\n- 人员：[{id: 'ou_xxx'}]\n- 附件：[{file_token: 'xxx'}]\n⚠️ 注意：create 只创建单条记录；批量创建请使用 batch_create",
      },
    ),
  }),

  // UPDATE (P0)
  Type.Object({
    action: Type.Literal('update'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    record_id: Type.String({ description: '记录 ID' }),
    fields: Type.Object(
      {},
      {
        additionalProperties: true,
        description: '要更新的字段',
      },
    ),
  }),

  // DELETE (P0)
  Type.Object({
    action: Type.Literal('delete'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    record_id: Type.String({ description: '记录 ID' }),
  }),

  // BATCH_CREATE (P1)
  Type.Object({
    action: Type.Literal('batch_create'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    records: Type.Array(
      Type.Object({
        fields: Type.Object({}, { additionalProperties: true }),
      }),
      { description: '要批量创建的记录列表（最多 500 条）' },
    ),
  }),

  // BATCH_UPDATE (P1)
  Type.Object({
    action: Type.Literal('batch_update'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    records: Type.Array(
      Type.Object({
        record_id: Type.String(),
        fields: Type.Object({}, { additionalProperties: true }),
      }),
      { description: '要批量更新的记录列表（最多 500 条）' },
    ),
  }),

  // BATCH_DELETE (P1)
  Type.Object({
    action: Type.Literal('batch_delete'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    record_ids: Type.Array(Type.String(), { description: '要删除的记录 ID 列表（最多 500 条）' }),
  }),

  // LIST (P0) - 使用 search API（旧 list API 已废弃）
  Type.Object({
    action: Type.Literal('list'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    view_id: Type.Optional(Type.String({ description: '视图 ID（可选，建议指定以获得更好的性能）' })),
    field_names: Type.Optional(
      Type.Array(Type.String(), {
        description: '要返回的字段名列表（可选，不指定则返回所有字段）',
      }),
    ),
    filter: Type.Optional(
      Type.Object(
        {
          conjunction: StringEnum(['and', 'or'], {
            description: '条件逻辑：and（全部满足）or（任一满足）',
          }),
          conditions: Type.Array(
            Type.Object({
              field_name: Type.String({ description: '字段名' }),
              operator: StringEnum(
                ['is', 'isNot', 'contains', 'doesNotContain', 'isEmpty', 'isNotEmpty', 'isGreater', 'isGreaterEqual', 'isLess', 'isLessEqual'],
                { description: '运算符' },
              ),
              value: Type.Optional(
                Type.Array(Type.String(), {
                  description: '条件值（isEmpty/isNotEmpty 时可省略）',
                }),
              ),
            }),
            { description: '筛选条件列表' },
          ),
        },
        {
          description:
            "筛选条件（必须是结构化对象）。示例：{conjunction: 'and', conditions: [{field_name: '文本', operator: 'is', value: ['测试']}]}",
        },
      ),
    ),
    sort: Type.Optional(
      Type.Array(
        Type.Object({
          field_name: Type.String({ description: '排序字段名' }),
          desc: Type.Boolean({ description: '是否降序' }),
        }),
        { description: '排序规则' },
      ),
    ),
    automatic_fields: Type.Optional(
      Type.Boolean({
        description: '是否返回自动字段（created_time, last_modified_time, created_by, last_modified_by），默认 false',
      }),
    ),
    page_size: Type.Optional(Type.Number({ description: '每页数量，默认 50，最大 500' })),
    page_token: Type.Optional(Type.String({ description: '分页标记' })),
  }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuBitableAppTableRecordParams =
  | {
      action: 'create';
      app_token: string;
      table_id: string;
      fields: Record<string, any>;
    }
  | {
      action: 'get';
      app_token: string;
      table_id: string;
      record_id: string;
    }
  | {
      action: 'update';
      app_token: string;
      table_id: string;
      record_id: string;
      fields: Record<string, any>;
    }
  | {
      action: 'delete';
      app_token: string;
      table_id: string;
      record_id: string;
    }
  | {
      action: 'batch_create';
      app_token: string;
      table_id: string;
      records: Array<{ fields: Record<string, any> }>;
    }
  | {
      action: 'batch_update';
      app_token: string;
      table_id: string;
      records: Array<{ record_id: string; fields: Record<string, any> }>;
    }
  | {
      action: 'batch_delete';
      app_token: string;
      table_id: string;
      record_ids: string[];
    }
  | {
      action: 'list';
      app_token: string;
      table_id: string;
      view_id?: string;
      field_names?: string[];
      filter?: {
        conjunction: 'and' | 'or';
        conditions: Array<{
          field_name: string;
          operator:
            | 'is'
            | 'isNot'
            | 'contains'
            | 'doesNotContain'
            | 'isEmpty'
            | 'isNotEmpty'
            | 'isGreater'
            | 'isGreaterEqual'
            | 'isLess'
            | 'isLessEqual';
          value?: string[];
        }>;
      };
      sort?: Array<{ field_name: string; desc: boolean }>;
      automatic_fields?: boolean;
      page_size?: number;
      page_token?: string;
    };

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFeishuBitableAppTableRecordTool(api: OpenClawPluginApi) {
  if (!api.config) return;
  const cfg = api.config;

  const { toolClient, log } = createToolContext(api, 'feishu_bitable_app_table_record');

  registerTool(
    api,
    {
      name: 'feishu_bitable_app_table_record',
      label: 'Feishu Bitable Records',
      description:
        '【以用户身份】飞书多维表格记录（行）管理工具。当用户要求创建/查询/更新/删除记录、搜索数据时使用。\n\n' +
        'Actions:\n' +
        '- create（创建单条记录，使用 fields 参数）\n' +
        '- batch_create（批量创建记录，使用 records 数组参数）\n' +
        '- list（列出/搜索记录）\n' +
        '- update（更新记录）\n' +
        '- delete（删除记录）\n' +
        '- batch_update（批量更新）\n' +
        '- batch_delete（批量删除）\n\n' +
        '⚠️ 注意参数区别：\n' +
        "- create 使用 'fields' 对象（单条）\n" +
        "- batch_create 使用 'records' 数组（批量）",
      parameters: FeishuBitableAppTableRecordSchema,
      async execute(_toolCallId, params) {
        const p = params as FeishuBitableAppTableRecordParams;

        try {
          const client = toolClient();

          switch (p.action) {
            // -----------------------------------------------------------------
            // CREATE
            // -----------------------------------------------------------------
            case 'create': {
              // 参数验证：检查是否误用了 batch_create 的参数格式
              if ((p as any).records) {
                return json({
                  error: "create action does not accept 'records' parameter",
                  hint: "Use 'fields' for single record creation. For batch creation, use action: 'batch_create' with 'records' parameter.",
                  correct_format: {
                    action: 'create',
                    fields: { 字段名: '字段值' },
                  },
                  batch_create_format: {
                    action: 'batch_create',
                    records: [{ fields: { 字段名: '字段值' } }],
                  },
                });
              }

              if (!p.fields || Object.keys(p.fields).length === 0) {
                return json({
                  error: 'fields is required and cannot be empty',
                  hint: "create action requires 'fields' parameter, e.g. { 'field_name': 'value', ... }",
                });
              }

              log.info(`create: app_token=${p.app_token}, table_id=${p.table_id}`);

              const res = await client.invoke(
                'feishu_bitable_app_table_record.create',
                (sdk, opts) =>
                  sdk.bitable.appTableRecord.create(
                    {
                      path: {
                        app_token: p.app_token,
                        table_id: p.table_id,
                      },
                      params: {
                        user_id_type: 'open_id' as any,
                      },
                      data: {
                        fields: p.fields,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`create: created record ${res.data?.record?.record_id}`);

              return json({
                record: res.data?.record,
              });
            }

            // -----------------------------------------------------------------
            // UPDATE
            // -----------------------------------------------------------------
            case 'update': {
              // 参数验证：检查是否误用了 batch_update 的参数格式
              if ((p as any).records) {
                return json({
                  error: "update action does not accept 'records' parameter",
                  hint: "Use 'record_id' + 'fields' for single record update. For batch update, use action: 'batch_update' with 'records' parameter.",
                  correct_format: {
                    action: 'update',
                    record_id: 'recXXX',
                    fields: { 字段名: '字段值' },
                  },
                  batch_update_format: {
                    action: 'batch_update',
                    records: [{ record_id: 'recXXX', fields: { 字段名: '字段值' } }],
                  },
                });
              }

              log.info(`update: app_token=${p.app_token}, table_id=${p.table_id}, record_id=${p.record_id}`);

              const res = await client.invoke(
                'feishu_bitable_app_table_record.update',
                (sdk, opts) =>
                  sdk.bitable.appTableRecord.update(
                    {
                      path: {
                        app_token: p.app_token,
                        table_id: p.table_id,
                        record_id: p.record_id,
                      },
                      params: {
                        user_id_type: 'open_id' as any,
                      },
                      data: {
                        fields: p.fields,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`update: updated record ${p.record_id}`);

              return json({
                record: res.data?.record,
              });
            }

            // -----------------------------------------------------------------
            // DELETE
            // -----------------------------------------------------------------
            case 'delete': {
              log.info(`delete: app_token=${p.app_token}, table_id=${p.table_id}, record_id=${p.record_id}`);

              const res = await client.invoke(
                'feishu_bitable_app_table_record.delete',
                (sdk, opts) =>
                  sdk.bitable.appTableRecord.delete(
                    {
                      path: {
                        app_token: p.app_token,
                        table_id: p.table_id,
                        record_id: p.record_id,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`delete: deleted record ${p.record_id}`);

              return json({
                success: true,
              });
            }

            // -----------------------------------------------------------------
            // BATCH_CREATE (P1)
            // -----------------------------------------------------------------
            case 'batch_create': {
              // 参数验证：检查是否误用了 create 的参数格式
              if ((p as any).fields) {
                return json({
                  error: "batch_create action does not accept 'fields' parameter",
                  hint: "Use 'records' array for batch creation. For single record, use action: 'create' with 'fields' parameter.",
                  correct_format: {
                    action: 'batch_create',
                    records: [{ fields: { 字段名: '字段值' } }],
                  },
                  single_create_format: {
                    action: 'create',
                    fields: { 字段名: '字段值' },
                  },
                });
              }

              if (!p.records || p.records.length === 0) {
                return json({
                  error: 'records is required and cannot be empty',
                  hint: "batch_create requires 'records' array, e.g. [{ fields: {...} }, ...]",
                });
              }

              if (p.records.length > 500) {
                return json({
                  error: 'records count exceeds limit (maximum 500)',
                  received_count: p.records.length,
                });
              }

              log.info(
                `batch_create: app_token=${p.app_token}, table_id=${p.table_id}, records_count=${p.records.length}`,
              );

              const res = await client.invoke(
                'feishu_bitable_app_table_record.batch_create',
                (sdk, opts) =>
                  sdk.bitable.appTableRecord.batchCreate(
                    {
                      path: {
                        app_token: p.app_token,
                        table_id: p.table_id,
                      },
                      params: {
                        user_id_type: 'open_id' as any,
                      },
                      data: {
                        records: p.records,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`batch_create: created ${p.records.length} records in table ${p.table_id}`);

              return json({
                records: res.data?.records,
              });
            }

            // -----------------------------------------------------------------
            // BATCH_UPDATE (P1)
            // -----------------------------------------------------------------
            case 'batch_update': {
              // 参数验证：检查是否误用了 update 的参数格式
              if ((p as any).record_id || (p as any).fields) {
                return json({
                  error: "batch_update action does not accept 'record_id' or 'fields' parameters",
                  hint: "Use 'records' array for batch update. For single record, use action: 'update' with 'record_id' + 'fields' parameters.",
                  correct_format: {
                    action: 'batch_update',
                    records: [{ record_id: 'recXXX', fields: { 字段名: '字段值' } }],
                  },
                  single_update_format: {
                    action: 'update',
                    record_id: 'recXXX',
                    fields: { 字段名: '字段值' },
                  },
                });
              }

              if (!p.records || p.records.length === 0) {
                return json({
                  error: 'records is required and cannot be empty',
                  hint: "batch_update requires 'records' array, e.g. [{ record_id: 'recXXX', fields: {...} }, ...]",
                });
              }

              if (p.records.length > 500) {
                return json({
                  error: 'records cannot exceed 500 items',
                });
              }

              log.info(
                `batch_update: app_token=${p.app_token}, table_id=${p.table_id}, records_count=${p.records.length}`,
              );

              const res = await client.invoke(
                'feishu_bitable_app_table_record.batch_update',
                (sdk, opts) =>
                  sdk.bitable.appTableRecord.batchUpdate(
                    {
                      path: {
                        app_token: p.app_token,
                        table_id: p.table_id,
                      },
                      params: {
                        user_id_type: 'open_id' as any,
                      },
                      data: {
                        records: p.records,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`batch_update: updated ${p.records.length} records in table ${p.table_id}`);

              return json({
                records: res.data?.records,
              });
            }

            // -----------------------------------------------------------------
            // BATCH_DELETE (P1)
            // -----------------------------------------------------------------
            case 'batch_delete': {
              if (!p.record_ids || p.record_ids.length === 0) {
                return json({
                  error: 'record_ids is required and cannot be empty',
                });
              }

              if (p.record_ids.length > 500) {
                return json({
                  error: 'record_ids cannot exceed 500 items',
                });
              }

              log.info(
                `batch_delete: app_token=${p.app_token}, table_id=${p.table_id}, record_ids_count=${p.record_ids.length}`,
              );

              const res = await client.invoke(
                'feishu_bitable_app_table_record.batch_delete',
                (sdk, opts) =>
                  sdk.bitable.appTableRecord.batchDelete(
                    {
                      path: {
                        app_token: p.app_token,
                        table_id: p.table_id,
                      },
                      data: {
                        records: p.record_ids,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`batch_delete: deleted ${p.record_ids.length} records from table ${p.table_id}`);

              return json({
                success: true,
              });
            }

            // -----------------------------------------------------------------
            // LIST (P0) - 使用 search API（旧 list API 已废弃）
            // -----------------------------------------------------------------
            case 'list': {
              log.info(
                `list: app_token=${p.app_token}, table_id=${p.table_id}, view_id=${p.view_id ?? 'none'}, field_names=${p.field_names?.length ?? 0}, filter=${p.filter ? 'yes' : 'no'}`,
              );

              const searchData: any = {};
              if (p.view_id !== undefined) searchData.view_id = p.view_id;
              if (p.field_names !== undefined) searchData.field_names = p.field_names;

              // 特殊处理：isEmpty/isNotEmpty 必须带 value=[]（即使逻辑上不需要值）
              if (p.filter !== undefined) {
                const filter = { ...p.filter };
                if (filter.conditions) {
                  filter.conditions = filter.conditions.map((cond: any) => {
                    if ((cond.operator === 'isEmpty' || cond.operator === 'isNotEmpty') && !cond.value) {
                      log.warn(
                        `list: ${cond.operator} operator detected without value. Auto-adding value=[] to avoid API error.`,
                      );
                      return { ...cond, value: [] };
                    }
                    return cond;
                  });
                }
                searchData.filter = filter;
              }

              if (p.sort !== undefined) searchData.sort = p.sort;
              if (p.automatic_fields !== undefined) searchData.automatic_fields = p.automatic_fields;

              const res = await client.invoke(
                'feishu_bitable_app_table_record.list',
                (sdk, opts) =>
                  sdk.bitable.appTableRecord.search(
                    {
                      path: {
                        app_token: p.app_token,
                        table_id: p.table_id,
                      },
                      params: {
                        user_id_type: 'open_id' as any,
                        page_size: p.page_size,
                        page_token: p.page_token,
                      },
                      data: searchData,
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              const data = res.data as PaginatedData | undefined;

              log.info(`list: returned ${data?.items?.length ?? 0} records`);

              return json({
                records: data?.items,
                has_more: data?.has_more ?? false,
                page_token: data?.page_token,
                total: data?.total,
              });
            }

            default:
              return json({
                error: `Unknown action: ${(p as any).action}`,
              });
          }
        } catch (err) {
          return await handleInvokeErrorWithAutoAuth(err, cfg);
        }
      },
    },
    { name: 'feishu_bitable_app_table_record' },
  );

}
