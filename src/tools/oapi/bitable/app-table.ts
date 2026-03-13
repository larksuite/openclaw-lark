/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_bitable_app_table tool -- Manage Feishu Bitable tables.
 *
 * P0 Actions: create, list, patch, delete
 * P1 Actions: batch_create, batch_delete
 *
 * Uses the Feishu Bitable v1 API:
 *   - create: POST /open-apis/bitable/v1/apps/:app_token/tables
 *   - list:   GET  /open-apis/bitable/v1/apps/:app_token/tables
 *   - patch:  PATCH /open-apis/bitable/v1/apps/:app_token/tables/:table_id
 *   - delete: DELETE /open-apis/bitable/v1/apps/:app_token/tables/:table_id
 *   - batch_create: POST /open-apis/bitable/v1/apps/:app_token/tables/batch_create
 *   - batch_delete: POST /open-apis/bitable/v1/apps/:app_token/tables/batch_delete
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';

import { json, createToolContext, assertLarkOk, handleInvokeErrorWithAutoAuth , registerTool } from '../helpers';
import type { PaginatedData } from '../sdk-types';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuBitableAppTableSchema = Type.Union([
  // CREATE (P0)
  Type.Object({
    action: Type.Literal('create'),
    app_token: Type.String({ description: '多维表格 token' }),
    table: Type.Object({
      name: Type.String({ description: '数据表名称' }),
      default_view_name: Type.Optional(Type.String({ description: '默认视图名称' })),
      fields: Type.Optional(
        Type.Array(
          Type.Object({
            field_name: Type.String({ description: '字段名称' }),
            type: Type.Number({
              description:
                '字段类型（1=文本，2=数字，3=单选，4=多选，5=日期，7=复选框，11=人员，13=电话，15=超链接，17=附件，1001=创建时间，1002=修改时间等）',
            }),
            property: Type.Optional(Type.Any({ description: '字段属性配置（根据类型而定）' })),
          }),
          { description: '字段列表（可选，但强烈建议在创建表时就传入所有字段，避免后续逐个添加）。不传则创建空表。' },
        ),
      ),
    }),
  }),

  // LIST (P0)
  Type.Object({
    action: Type.Literal('list'),
    app_token: Type.String({ description: '多维表格 token' }),
    page_size: Type.Optional(Type.Number({ description: '每页数量，默认 50，最大 100' })),
    page_token: Type.Optional(Type.String({ description: '分页标记' })),
  }),

  // PATCH (P0)
  Type.Object({
    action: Type.Literal('patch'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    name: Type.Optional(Type.String({ description: '新的表名' })),
  }),

  // DELETE (P0)
  Type.Object({
    action: Type.Literal('delete'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
  }),

  // BATCH_CREATE (P1)
  Type.Object({
    action: Type.Literal('batch_create'),
    app_token: Type.String({ description: '多维表格 token' }),
    tables: Type.Array(
      Type.Object({
        name: Type.String({ description: '数据表名称' }),
      }),
      { description: '要批量创建的数据表列表' },
    ),
  }),

  // BATCH_DELETE (P1)
  Type.Object({
    action: Type.Literal('batch_delete'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_ids: Type.Array(Type.String(), { description: '要删除的数据表 ID 列表' }),
  }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuBitableAppTableParams =
  | {
      action: 'create';
      app_token: string;
      table: {
        name: string;
        default_view_name?: string;
        fields?: Array<{
          field_name: string;
          type: number;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          property?: any;
        }>;
      };
    }
  | {
      action: 'list';
      app_token: string;
      page_size?: number;
      page_token?: string;
    }
  | {
      action: 'patch';
      app_token: string;
      table_id: string;
      name?: string;
    }
  | {
      action: 'delete';
      app_token: string;
      table_id: string;
    }
  | {
      action: 'batch_create';
      app_token: string;
      tables: Array<{ name: string }>;
    }
  | {
      action: 'batch_delete';
      app_token: string;
      table_ids: string[];
    };

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFeishuBitableAppTableTool(api: OpenClawPluginApi) {
  if (!api.config) return;

  const cfg = api.config;

  const { toolClient, log } = createToolContext(api, 'feishu_bitable_app_table');

  registerTool(
    api,
    {
      name: 'feishu_bitable_app_table',
      label: 'Feishu Bitable Tables',
      description:
        '【以用户身份】飞书多维表格数据表管理工具。当用户要求创建/查询/管理数据表时使用。' +
        '\n\nActions: create（创建数据表，可选择在创建时传入 fields 数组定义字段，或后续逐个添加）, list（列出所有数据表）, patch（更新数据表）, delete（删除数据表）, batch_create（批量创建）, batch_delete（批量删除）。' +
        '\n\n【字段定义方式】支持两种模式：1) 明确需求时，在 create 中通过 table.fields 一次性定义所有字段（减少 API 调用）；2) 探索式场景时，使用默认表 + feishu_bitable_app_table_field 逐步修改字段（更稳定，易调整）。',
      parameters: FeishuBitableAppTableSchema,
      async execute(_toolCallId, params) {
        const p = params as FeishuBitableAppTableParams;

        try {
          const client = toolClient();

          switch (p.action) {
            // -----------------------------------------------------------------
            // CREATE
            // -----------------------------------------------------------------
            case 'create': {
              log.info(
                `create: app_token=${p.app_token}, table_name=${p.table.name}, fields_count=${p.table.fields?.length ?? 0}`,
              );

              // 特殊处理：复选框（type=7）和超链接（type=15）字段不能传 property
              const tableData = { ...p.table };
              if (tableData.fields) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                tableData.fields = tableData.fields.map((field: any) => {
                  if ((field.type === 7 || field.type === 15) && field.property !== undefined) {
                    const fieldTypeName = field.type === 15 ? 'URL' : 'Checkbox';
                    log.warn(
                      `create: ${fieldTypeName} field (type=${field.type}, name="${field.field_name}") detected with property parameter. ` +
                        `Removing property to avoid API error. ` +
                        `${fieldTypeName} fields must omit the property parameter entirely.`,
                    );
                    const { property: _property, ...fieldWithoutProperty } = field;
                    return fieldWithoutProperty;
                  }
                  return field;
                });
              }

              const res = await client.invoke(
                'feishu_bitable_app_table.create',
                (sdk, opts) =>
                  sdk.bitable.appTable.create(
                    {
                      path: {
                        app_token: p.app_token,
                      },
                      data: {
                        table: tableData,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`create: created table ${res.data?.table_id}`);

              return json({
                table_id: res.data?.table_id,
                default_view_id: res.data?.default_view_id,
                field_id_list: res.data?.field_id_list,
              });
            }

            // -----------------------------------------------------------------
            // LIST
            // -----------------------------------------------------------------
            case 'list': {
              log.info(`list: app_token=${p.app_token}, page_size=${p.page_size ?? 50}`);

              const res = await client.invoke(
                'feishu_bitable_app_table.list',
                (sdk, opts) =>
                  sdk.bitable.appTable.list(
                    {
                      path: {
                        app_token: p.app_token,
                      },
                      params: {
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

              log.info(`list: returned ${data?.items?.length ?? 0} tables`);

              return json({
                tables: data?.items,
                has_more: data?.has_more ?? false,
                page_token: data?.page_token,
              });
            }

            // -----------------------------------------------------------------
            // PATCH
            // -----------------------------------------------------------------
            case 'patch': {
              log.info(`patch: app_token=${p.app_token}, table_id=${p.table_id}, name=${p.name}`);

              const res = await client.invoke(
                'feishu_bitable_app_table.patch',
                (sdk, opts) =>
                  sdk.bitable.appTable.patch(
                    {
                      path: {
                        app_token: p.app_token,
                        table_id: p.table_id,
                      },
                      data: {
                        name: p.name,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`patch: updated table ${p.table_id}`);

              return json({
                name: res.data?.name,
              });
            }

            // -----------------------------------------------------------------
            // DELETE
            // -----------------------------------------------------------------
            case 'delete': {
              log.info(`delete: app_token=${p.app_token}, table_id=${p.table_id}`);

              const res = await client.invoke(
                'feishu_bitable_app_table.delete',
                (sdk, opts) =>
                  sdk.bitable.appTable.delete(
                    {
                      path: {
                        app_token: p.app_token,
                        table_id: p.table_id,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`delete: deleted table ${p.table_id}`);

              return json({
                success: true,
              });
            }

            // -----------------------------------------------------------------
            // BATCH_CREATE (P1)
            // -----------------------------------------------------------------
            case 'batch_create': {
              if (!p.tables || p.tables.length === 0) {
                return json({
                  error: 'tables is required and cannot be empty',
                });
              }

              log.info(`batch_create: app_token=${p.app_token}, tables_count=${p.tables.length}`);

              const res = await client.invoke(
                'feishu_bitable_app_table.batch_create',
                (sdk, opts) =>
                  sdk.bitable.appTable.batchCreate(
                    {
                      path: {
                        app_token: p.app_token,
                      },
                      data: {
                        tables: p.tables,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`batch_create: created ${p.tables.length} tables in app ${p.app_token}`);

              return json({
                table_ids: res.data?.table_ids,
              });
            }

            // -----------------------------------------------------------------
            // BATCH_DELETE (P1)
            // -----------------------------------------------------------------
            case 'batch_delete': {
              if (!p.table_ids || p.table_ids.length === 0) {
                return json({
                  error: 'table_ids is required and cannot be empty',
                });
              }

              log.info(`batch_delete: app_token=${p.app_token}, table_ids_count=${p.table_ids.length}`);

              const res = await client.invoke(
                'feishu_bitable_app_table.batch_delete',
                (sdk, opts) =>
                  sdk.bitable.appTable.batchDelete(
                    {
                      path: {
                        app_token: p.app_token,
                      },
                      data: {
                        table_ids: p.table_ids,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`batch_delete: deleted ${p.table_ids.length} tables from app ${p.app_token}`);

              return json({
                success: true,
              });
            }
          }
        } catch (err) {
          return await handleInvokeErrorWithAutoAuth(err, cfg);
        }
      },
    },
    { name: 'feishu_bitable_app_table' },
  );

}
