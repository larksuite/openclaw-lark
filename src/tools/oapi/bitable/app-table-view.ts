/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_bitable_app_table_view tool -- Manage Feishu Bitable views.
 *
 * P1 Actions: create, get, list, patch, delete
 *
 * Uses the Feishu Bitable v1 API:
 *   - create: POST /open-apis/bitable/v1/apps/:app_token/tables/:table_id/views
 *   - get:    GET  /open-apis/bitable/v1/apps/:app_token/tables/:table_id/views/:view_id
 *   - list:   GET  /open-apis/bitable/v1/apps/:app_token/tables/:table_id/views
 *   - patch:  PATCH /open-apis/bitable/v1/apps/:app_token/tables/:table_id/views/:view_id
 *   - delete: DELETE /open-apis/bitable/v1/apps/:app_token/tables/:table_id/views/:view_id
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';

import { json, createToolContext, assertLarkOk, handleInvokeErrorWithAutoAuth , registerTool } from '../helpers';
import type { PaginatedData } from '../sdk-types';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuBitableAppTableViewSchema = Type.Union([
  // CREATE (P1)
  Type.Object({
    action: Type.Literal('create'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    view_name: Type.String({ description: '视图名称' }),
    view_type: Type.Optional(
      Type.Union([
        Type.Literal('grid'), // 表格视图
        Type.Literal('kanban'), // 看板视图
        Type.Literal('gallery'), // 画册视图
        Type.Literal('gantt'), // 甘特图
        Type.Literal('form'), // 表单视图
      ]),
    ),
  }),

  // GET (P1)
  Type.Object({
    action: Type.Literal('get'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    view_id: Type.String({ description: '视图 ID' }),
  }),

  // LIST (P1)
  Type.Object({
    action: Type.Literal('list'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    page_size: Type.Optional(Type.Number({ description: '每页数量，默认 50，最大 100' })),
    page_token: Type.Optional(Type.String({ description: '分页标记' })),
  }),

  // PATCH (P1)
  Type.Object({
    action: Type.Literal('patch'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    view_id: Type.String({ description: '视图 ID' }),
    view_name: Type.Optional(Type.String({ description: '新的视图名称' })),
  }),

  // DELETE (P1)
  Type.Object({
    action: Type.Literal('delete'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    view_id: Type.String({ description: '视图 ID' }),
  }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuBitableAppTableViewParams =
  | {
      action: 'create';
      app_token: string;
      table_id: string;
      view_name: string;
      view_type?: string;
    }
  | {
      action: 'get';
      app_token: string;
      table_id: string;
      view_id: string;
    }
  | {
      action: 'list';
      app_token: string;
      table_id: string;
      page_size?: number;
      page_token?: string;
    }
  | {
      action: 'patch';
      app_token: string;
      table_id: string;
      view_id: string;
      view_name?: string;
    }
  | {
      action: 'delete';
      app_token: string;
      table_id: string;
      view_id: string;
    };

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFeishuBitableAppTableViewTool(api: OpenClawPluginApi) {
  if (!api.config) return;

  const cfg = api.config;

  const { toolClient, log } = createToolContext(api, 'feishu_bitable_app_table_view');

  registerTool(
    api,
    {
      name: 'feishu_bitable_app_table_view',
      label: 'Feishu Bitable Views',
      description:
        '【以用户身份】飞书多维表格视图管理工具。当用户要求创建/查询/更新/删除视图、切换展示方式时使用。Actions: create（创建视图）, get（获取视图详情）, list（列出所有视图）, patch（更新视图）, delete（删除视图）。',
      parameters: FeishuBitableAppTableViewSchema,
      async execute(_toolCallId, params) {
        const p = params as FeishuBitableAppTableViewParams;

        try {
          const client = toolClient();

          switch (p.action) {
            // -----------------------------------------------------------------
            // CREATE
            // -----------------------------------------------------------------
            case 'create': {
              log.info(
                `create: app_token=${p.app_token}, table_id=${p.table_id}, view_name=${p.view_name}, view_type=${p.view_type ?? 'grid'}`,
              );

              const res = await client.invoke(
                'feishu_bitable_app_table_view.create',
                (sdk, opts) =>
                  sdk.bitable.appTableView.create(
                    {
                      path: {
                        app_token: p.app_token,
                        table_id: p.table_id,
                      },
                      data: {
                        view_name: p.view_name,
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        view_type: (p.view_type || 'grid') as any,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`create: created view ${res.data?.view?.view_id}`);

              return json({
                view: res.data?.view,
              });
            }

            // -----------------------------------------------------------------
            // GET
            // -----------------------------------------------------------------
            case 'get': {
              log.info(`get: app_token=${p.app_token}, table_id=${p.table_id}, view_id=${p.view_id}`);

              const res = await client.invoke(
                'feishu_bitable_app_table_view.get',
                (sdk, opts) =>
                  sdk.bitable.appTableView.get(
                    {
                      path: {
                        app_token: p.app_token,
                        table_id: p.table_id,
                        view_id: p.view_id,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`get: returned view ${p.view_id}`);

              return json({
                view: res.data?.view,
              });
            }

            // -----------------------------------------------------------------
            // LIST
            // -----------------------------------------------------------------
            case 'list': {
              log.info(`list: app_token=${p.app_token}, table_id=${p.table_id}`);

              const res = await client.invoke(
                'feishu_bitable_app_table_view.list',
                (sdk, opts) =>
                  sdk.bitable.appTableView.list(
                    {
                      path: {
                        app_token: p.app_token,
                        table_id: p.table_id,
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

              log.info(`list: returned ${data?.items?.length ?? 0} views`);

              return json({
                views: data?.items,
                has_more: data?.has_more ?? false,
                page_token: data?.page_token,
              });
            }

            // -----------------------------------------------------------------
            // PATCH
            // -----------------------------------------------------------------
            case 'patch': {
              log.info(
                `patch: app_token=${p.app_token}, table_id=${p.table_id}, view_id=${p.view_id}, view_name=${p.view_name}`,
              );

              const res = await client.invoke(
                'feishu_bitable_app_table_view.patch',
                (sdk, opts) =>
                  sdk.bitable.appTableView.patch(
                    {
                      path: {
                        app_token: p.app_token,
                        table_id: p.table_id,
                        view_id: p.view_id,
                      },
                      data: {
                        view_name: p.view_name,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`patch: updated view ${p.view_id}`);

              return json({
                view: res.data?.view,
              });
            }

            // -----------------------------------------------------------------
            // DELETE
            // -----------------------------------------------------------------
            case 'delete': {
              log.info(`delete: app_token=${p.app_token}, table_id=${p.table_id}, view_id=${p.view_id}`);

              const res = await client.invoke(
                'feishu_bitable_app_table_view.delete',
                (sdk, opts) =>
                  sdk.bitable.appTableView.delete(
                    {
                      path: {
                        app_token: p.app_token,
                        table_id: p.table_id,
                        view_id: p.view_id,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`delete: deleted view ${p.view_id}`);

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
    { name: 'feishu_bitable_app_table_view' },
  );

}
