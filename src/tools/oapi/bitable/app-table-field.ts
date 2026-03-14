/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_bitable_app_table_field tool -- Manage Feishu Bitable fields (columns).
 *
 * P1 Actions: create, list, update, delete
 *
 * Uses the Feishu Bitable v1 API:
 *   - create: POST /open-apis/bitable/v1/apps/:app_token/tables/:table_id/fields
 *   - list:   GET  /open-apis/bitable/v1/apps/:app_token/tables/:table_id/fields
 *   - update: PUT  /open-apis/bitable/v1/apps/:app_token/tables/:table_id/fields/:field_id
 *   - delete: DELETE /open-apis/bitable/v1/apps/:app_token/tables/:table_id/fields/:field_id
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';

import { json, createToolContext, assertLarkOk, handleInvokeErrorWithAutoAuth , registerTool } from '../helpers';
import type { PaginatedData, FieldData } from '../sdk-types';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuBitableAppTableFieldSchema = Type.Union([
  // CREATE (P1)
  Type.Object({
    action: Type.Literal('create'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    field_name: Type.String({ description: '字段名称' }),
    type: Type.Number({
      description:
        '字段类型（1=文本，2=数字，3=单选，4=多选，5=日期，7=复选框，11=人员，13=电话，15=超链接，17=附件，1001=创建时间，1002=修改时间等）',
    }),
    property: Type.Optional(
      Type.Any({
        description:
          '字段属性配置（根据类型而定，例如单选/多选需要options，数字需要formatter等）。' +
          '⚠️ 重要：超链接字段（type=15）必须完全省略此参数，传空对象 {} 也会报错（URLFieldPropertyError）。',
      }),
    ),
  }),

  // LIST (P1)
  Type.Object({
    action: Type.Literal('list'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    view_id: Type.Optional(Type.String({ description: '视图 ID（可选）' })),
    page_size: Type.Optional(Type.Number({ description: '每页数量，默认 50，最大 100' })),
    page_token: Type.Optional(Type.String({ description: '分页标记' })),
  }),

  // UPDATE (P1)
  Type.Object({
    action: Type.Literal('update'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    field_id: Type.String({ description: '字段 ID' }),
    field_name: Type.Optional(Type.String({ description: '字段名（可选，不传则不修改）' })),
    type: Type.Optional(
      Type.Number({
        description:
          '字段类型（可选，不传则自动查询）：1=文本, 2=数字, 3=单选, 4=多选, 5=日期, 7=复选框, 11=人员, 13=电话, 15=超链接, 17=附件等',
      }),
    ),
    property: Type.Optional(Type.Any({ description: '字段属性配置（可选，不传则自动查询）' })),
  }),

  // DELETE (P1)
  Type.Object({
    action: Type.Literal('delete'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    field_id: Type.String({ description: '字段 ID' }),
  }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuBitableAppTableFieldParams =
  | {
      action: 'create';
      app_token: string;
      table_id: string;
      field_name: string;
      type: number;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      property?: any;
    }
  | {
      action: 'list';
      app_token: string;
      table_id: string;
      view_id?: string;
      page_size?: number;
      page_token?: string;
    }
  | {
      action: 'update';
      app_token: string;
      table_id: string;
      field_id: string;
      field_name?: string;
      type?: number;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      property?: any;
    }
  | {
      action: 'delete';
      app_token: string;
      table_id: string;
      field_id: string;
    };

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFeishuBitableAppTableFieldTool(api: OpenClawPluginApi) {
  if (!api.config) return;

  const cfg = api.config;

  const { toolClient, log } = createToolContext(api, 'feishu_bitable_app_table_field');

  registerTool(
    api,
    {
      name: 'feishu_bitable_app_table_field',
      label: 'Feishu Bitable Fields',
      description:
        '【以用户身份】飞书多维表格字段（列）管理工具。当用户要求创建/查询/更新/删除字段、调整表结构时使用。Actions: create（创建字段）, list（列出所有字段）, update（更新字段，支持只传 field_name 改名）, delete（删除字段）。',
      parameters: FeishuBitableAppTableFieldSchema,
      async execute(_toolCallId, params) {
        const p = params as FeishuBitableAppTableFieldParams;

        try {
          const client = toolClient();

          switch (p.action) {
            // -----------------------------------------------------------------
            // CREATE
            // -----------------------------------------------------------------
            case 'create': {
              log.info(
                `create: app_token=${p.app_token}, table_id=${p.table_id}, field_name=${p.field_name}, type=${p.type}`,
              );

              // 特殊处理：超链接字段（type=15）和复选框字段（type=7）不能传 property，即使是空对象也会报错
              let propertyToSend = p.property;
              if ((p.type === 15 || p.type === 7) && p.property !== undefined) {
                const fieldTypeName = p.type === 15 ? 'URL' : 'Checkbox';
                log.warn(
                  `create: ${fieldTypeName} field (type=${p.type}) detected with property parameter. ` +
                    `Removing property to avoid API error. ` +
                    `${fieldTypeName} fields must omit the property parameter entirely.`,
                );
                propertyToSend = undefined;
              }

              const res = await client.invoke(
                'feishu_bitable_app_table_field.create',
                (sdk, opts) =>
                  sdk.bitable.appTableField.create(
                    {
                      path: {
                        app_token: p.app_token,
                        table_id: p.table_id,
                      },
                      data: {
                        field_name: p.field_name,
                        type: p.type,
                        property: propertyToSend,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              const data = res.data as FieldData | undefined;

              log.info(`create: created field ${data?.field?.field_id ?? 'unknown'}`);

              return json({
                field: data?.field ?? res.data,
              });
            }

            // -----------------------------------------------------------------
            // LIST
            // -----------------------------------------------------------------
            case 'list': {
              log.info(`list: app_token=${p.app_token}, table_id=${p.table_id}, view_id=${p.view_id ?? 'none'}`);

              const res = await client.invoke(
                'feishu_bitable_app_table_field.list',
                (sdk, opts) =>
                  sdk.bitable.appTableField.list(
                    {
                      path: {
                        app_token: p.app_token,
                        table_id: p.table_id,
                      },
                      params: {
                        view_id: p.view_id,
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

              log.info(`list: returned ${data?.items?.length ?? 0} fields`);

              return json({
                fields: data?.items,
                has_more: data?.has_more ?? false,
                page_token: data?.page_token,
              });
            }

            // -----------------------------------------------------------------
            // UPDATE
            // -----------------------------------------------------------------
            case 'update': {
              log.info(`update: app_token=${p.app_token}, table_id=${p.table_id}, field_id=${p.field_id}`);

              // 如果缺少 type 或 field_name，自动查询当前字段信息
              let finalFieldName = p.field_name;
              let finalType = p.type;
              let finalProperty = p.property;

              if (!finalType || !finalFieldName) {
                log.info(`update: missing type or field_name, auto-querying field info`);

                const listRes = await client.invoke(
                  'feishu_bitable_app_table_field.update',
                  (sdk, opts) =>
                    sdk.bitable.appTableField.list(
                      {
                        path: {
                          app_token: p.app_token,
                          table_id: p.table_id,
                        },
                        params: {
                          page_size: 500,
                        },
                      },
                      opts,
                    ),
                  { as: 'user' },
                );
                assertLarkOk(listRes);

                 
                const listData = listRes.data as
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  | PaginatedData<{ field_id?: string; field_name?: string; type?: number; property?: any }>
                  | undefined;
                const currentField = listData?.items?.find((f) => f.field_id === p.field_id);

                if (!currentField) {
                  return json({
                    error: `field ${p.field_id} does not exist`,
                    hint: 'Please verify field_id is correct. Use list action to view all fields.',
                  });
                }

                // 合并：用户传的优先，否则用查询到的
                finalFieldName = p.field_name || currentField.field_name;
                finalType = p.type ?? currentField.type;
                finalProperty = p.property !== undefined ? p.property : currentField.property;

                log.info(`update: auto-filled type=${finalType}, field_name=${finalFieldName}`);
              }

              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const updateData: any = {
                field_name: finalFieldName,
                type: finalType,
              };
              if (finalProperty !== undefined) {
                updateData.property = finalProperty;
              }

              const res = await client.invoke(
                'feishu_bitable_app_table_field.update',
                (sdk, opts) =>
                  sdk.bitable.appTableField.update(
                    {
                      path: {
                        app_token: p.app_token,
                        table_id: p.table_id,
                        field_id: p.field_id,
                      },
                      data: updateData,
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`update: updated field ${p.field_id}`);

              const updateData2 = res.data as FieldData | undefined;

              return json({
                field: updateData2?.field ?? res.data,
              });
            }

            // -----------------------------------------------------------------
            // DELETE
            // -----------------------------------------------------------------
            case 'delete': {
              log.info(`delete: app_token=${p.app_token}, table_id=${p.table_id}, field_id=${p.field_id}`);

              const res = await client.invoke(
                'feishu_bitable_app_table_field.delete',
                (sdk, opts) =>
                  sdk.bitable.appTableField.delete(
                    {
                      path: {
                        app_token: p.app_token,
                        table_id: p.table_id,
                        field_id: p.field_id,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`delete: deleted field ${p.field_id}`);

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
    { name: 'feishu_bitable_app_table_field' },
  );

}
