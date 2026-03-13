/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_bitable_app tool -- Manage Feishu Bitable apps (multidimensional tables).
 *
 * P0 Actions: create, get, list, patch
 * P1 Actions: copy
 *
 * Uses the Feishu Bitable v1 API:
 *   - create: POST /open-apis/bitable/v1/apps
 *   - get:    GET  /open-apis/bitable/v1/apps/:app_token
 *   - list:   GET  /open-apis/drive/v1/files (filtered by type=bitable)
 *   - patch:  PATCH /open-apis/bitable/v1/apps/:app_token
 *   - copy:   POST /open-apis/bitable/v1/apps/:app_token/copy
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';
import { json, createToolContext, assertLarkOk, handleInvokeErrorWithAutoAuth , registerTool } from '../helpers';
import type { BitableAppListData } from '../sdk-types';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuBitableAppSchema = Type.Union([
  // CREATE (P0)
  Type.Object({
    action: Type.Literal('create'),
    name: Type.String({ description: '多维表格名称' }),
    folder_token: Type.Optional(Type.String({ description: '所在文件夹 token（默认创建在我的空间）' })),
  }),

  // GET (P0)
  Type.Object({
    action: Type.Literal('get'),
    app_token: Type.String({ description: '多维表格的唯一标识 token' }),
  }),

  // LIST (P0) - 通过 Drive API 获取
  Type.Object({
    action: Type.Literal('list'),
    folder_token: Type.Optional(Type.String({ description: '文件夹 token（默认列出我的空间）' })),
    page_size: Type.Optional(Type.Number({ description: '每页数量，默认 50，最大 200' })),
    page_token: Type.Optional(Type.String({ description: '分页标记' })),
  }),

  // PATCH (P0)
  Type.Object({
    action: Type.Literal('patch'),
    app_token: Type.String({ description: '多维表格 token' }),
    name: Type.Optional(Type.String({ description: '新的名称' })),
    is_advanced: Type.Optional(Type.Boolean({ description: '是否开启高级权限' })),
  }),

  // COPY (P1)
  Type.Object({
    action: Type.Literal('copy'),
    app_token: Type.String({ description: '源多维表格 token' }),
    name: Type.String({ description: '新的名称' }),
    folder_token: Type.Optional(Type.String({ description: '目标文件夹 token' })),
  }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuBitableAppParams =
  | {
      action: 'create';
      name: string;
      folder_token?: string;
    }
  | {
      action: 'get';
      app_token: string;
    }
  | {
      action: 'list';
      folder_token?: string;
      page_size?: number;
      page_token?: string;
    }
  | {
      action: 'patch';
      app_token: string;
      name?: string;
      is_advanced?: boolean;
    }
  | {
      action: 'copy';
      app_token: string;
      name: string;
      folder_token?: string;
    };

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFeishuBitableAppTool(api: OpenClawPluginApi) {
  if (!api.config) return;
  const cfg = api.config;

  const { toolClient, log } = createToolContext(api, 'feishu_bitable_app');

  registerTool(
    api,
    {
      name: 'feishu_bitable_app',
      label: 'Feishu Bitable Apps',
      description:
        '【以用户身份】飞书多维表格应用管理工具。当用户要求创建/查询/管理多维表格时使用。Actions: create（创建多维表格）, get（获取多维表格元数据）, list（列出多维表格）, patch（更新元数据）, delete（删除多维表格）, copy（复制多维表格）。',
      parameters: FeishuBitableAppSchema,
      async execute(_toolCallId, params) {
        const p = params as FeishuBitableAppParams;

        try {
          const client = toolClient();

          switch (p.action) {
            // -----------------------------------------------------------------
            // CREATE
            // -----------------------------------------------------------------
            case 'create': {
              log.info(`create: name=${p.name}, folder_token=${p.folder_token ?? 'my_space'}`);

              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const data: any = { name: p.name };
              if (p.folder_token) {
                data.folder_token = p.folder_token;
              }

              const res = await client.invoke(
                'feishu_bitable_app.create',
                (sdk, opts) =>
                  sdk.bitable.app.create(
                    {
                      data,
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`create: created app ${res.data?.app?.app_token}`);

              return json({
                app: res.data?.app,
              });
            }

            // -----------------------------------------------------------------
            // GET
            // -----------------------------------------------------------------
            case 'get': {
              log.info(`get: app_token=${p.app_token}`);

              const res = await client.invoke(
                'feishu_bitable_app.get',
                (sdk, opts) =>
                  sdk.bitable.app.get(
                    {
                      path: {
                        app_token: p.app_token,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`get: returned app ${p.app_token}`);

              return json({
                app: res.data?.app,
              });
            }

            // -----------------------------------------------------------------
            // LIST - 使用 Drive API 筛选 bitable 类型文件
            // -----------------------------------------------------------------
            case 'list': {
              log.info(`list: folder_token=${p.folder_token ?? 'my_space'}, page_size=${p.page_size ?? 50}`);

              const res = await client.invoke(
                'feishu_bitable_app.list',
                (sdk, opts) =>
                  sdk.drive.v1.file.list(
                    {
                      params: {
                        folder_token: p.folder_token || '',
                        page_size: p.page_size,
                        page_token: p.page_token,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              // 筛选出 type === "bitable" 的文件
              const data = res.data as BitableAppListData | undefined;
              const bitables =
                data?.files?.filter(
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  (f: any) => f.type === 'bitable',
                ) || [];

              log.info(`list: returned ${bitables.length} bitable apps`);

              return json({
                apps: bitables,
                has_more: data?.has_more ?? false,
                page_token: data?.page_token,
              });
            }

            // -----------------------------------------------------------------
            // PATCH
            // -----------------------------------------------------------------
            case 'patch': {
              log.info(`patch: app_token=${p.app_token}, name=${p.name}, is_advanced=${p.is_advanced}`);

              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const updateData: any = {};
              if (p.name !== undefined) updateData.name = p.name;
              if (p.is_advanced !== undefined) updateData.is_advanced = p.is_advanced;

              const res = await client.invoke(
                'feishu_bitable_app.patch',
                (sdk, opts) =>
                  sdk.bitable.app.update(
                    {
                      path: {
                        app_token: p.app_token,
                      },
                      data: updateData,
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`patch: updated app ${p.app_token}`);

              return json({
                app: res.data?.app,
              });
            }

            // -----------------------------------------------------------------
            // COPY (P1)
            // -----------------------------------------------------------------
            case 'copy': {
              log.info(`copy: app_token=${p.app_token}, name=${p.name}, folder_token=${p.folder_token ?? 'my_space'}`);

              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const data: any = { name: p.name };
              if (p.folder_token) {
                data.folder_token = p.folder_token;
              }

              const res = await client.invoke(
                'feishu_bitable_app.copy',
                (sdk, opts) =>
                  sdk.bitable.app.copy(
                    {
                      path: {
                        app_token: p.app_token,
                      },
                      data,
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`copy: created copy ${res.data?.app?.app_token}`);

              return json({
                app: res.data?.app,
              });
            }
          }
        } catch (err) {
          return await handleInvokeErrorWithAutoAuth(err, cfg);
        }
      },
    },
    { name: 'feishu_bitable_app' },
  );

}
