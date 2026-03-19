/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_wiki_space tool -- Manage Feishu Wiki spaces.
 *
 * Actions: list, get, create
 *
 * Uses the Feishu Wiki API:
 *   - list:   GET  /open-apis/wiki/v2/spaces
 *   - get:    GET  /open-apis/wiki/v2/spaces/:space_id
 *   - create: POST /open-apis/wiki/v2/spaces
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';

import {
  json,
  createToolContext,
  assertLarkOk,
  handleInvokeErrorWithAutoAuth,
  registerTool,
} from '../helpers';
import type { PaginatedData } from '../sdk-types';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuWikiSpaceSchema = Type.Union([
  // LIST SPACES
  Type.Object({
    action: Type.Literal('list'),
    page_size: Type.Optional(
      Type.Integer({
        description: '分页大小（默认 10，最大 50）',
        minimum: 1,
        maximum: 50,
      }),
    ),
    page_token: Type.Optional(
      Type.String({
        description: '分页标记。首次请求无需填写',
      }),
    ),
  }),

  // GET SPACE
  Type.Object({
    action: Type.Literal('get'),
    space_id: Type.String({
      description: '知识空间 ID（必填）',
    }),
  }),

  // CREATE SPACE
  Type.Object({
    action: Type.Literal('create'),
    name: Type.Optional(
      Type.String({
        description: '知识空间名称',
      }),
    ),
    description: Type.Optional(
      Type.String({
        description: '知识空间描述',
      }),
    ),
  }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuWikiSpaceParams =
  | {
      action: 'list';
      page_size?: number;
      page_token?: string;
    }
  | {
      action: 'get';
      space_id: string;
    }
  | {
      action: 'create';
      name?: string;
      description?: string;
    };

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFeishuWikiSpaceTool(api: OpenClawPluginApi): boolean {
  if (!api.config) return false;
  const cfg = api.config;

  const { toolClient, log } = createToolContext(api, 'feishu_wiki_space');

  return registerTool(
    api,
    {
      name: 'feishu_wiki_space',
      label: 'Feishu Wiki Spaces',
      description:
        '飞书知识空间管理工具。当用户要求查看知识库列表、获取知识库信息、创建知识库时使用。Actions: list（列出知识空间）, get（获取知识空间信息）, create（创建知识空间）。' +
        '【重要】space_id 可以从浏览器 URL 中获取，或通过 list 接口获取。' +
        '【重要】知识空间（Space）是知识库的基本组成单位，包含多个具有层级关系的文档节点。',
      parameters: FeishuWikiSpaceSchema,
      async execute(_toolCallId: string, params: unknown) {
        const p = params as FeishuWikiSpaceParams;
        try {
          const client = toolClient();

          switch (p.action) {
            // -----------------------------------------------------------------
            // LIST SPACES
            // -----------------------------------------------------------------
            case 'list': {
              log.info(`list: page_size=${p.page_size ?? 10}`);

              const res = await client.invoke(
                'feishu_wiki_space.list',
                (sdk, opts) =>
                  sdk.wiki.space.list(
                    {
                      params: {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        page_size: p.page_size as any,
                        page_token: p.page_token,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              const data = res.data as PaginatedData | undefined;
              log.info(`list: returned ${data?.items?.length ?? 0} spaces`);

              return json({
                spaces: data?.items,
                has_more: data?.has_more,
                page_token: data?.page_token,
              });
            }

            // -----------------------------------------------------------------
            // GET SPACE
            // -----------------------------------------------------------------
            case 'get': {
              log.info(`get: space_id=${p.space_id}`);

              const res = await client.invoke(
                'feishu_wiki_space.get',
                (sdk, opts) =>
                  sdk.wiki.space.get(
                    {
                      path: { space_id: p.space_id },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`get: retrieved space ${p.space_id}`);

              return json({
                space: res.data?.space,
              });
            }

            // -----------------------------------------------------------------
            // CREATE SPACE
            // -----------------------------------------------------------------
            case 'create': {
              log.info(`create: name=${p.name ?? '(empty)'}, description=${p.description ?? '(empty)'}`);

              const res = await client.invoke(
                'feishu_wiki_space.create',
                (sdk, opts) =>
                  sdk.wiki.space.create(
                    {
                      data: {
                        name: p.name,
                        description: p.description,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              log.info(`create: created space_id=${(res.data?.space as any)?.space_id}`);

              return json({
                space: res.data?.space,
              });
            }
          }
        } catch (err) {
          return await handleInvokeErrorWithAutoAuth(err, cfg);
        }
      },
    },
    { name: 'feishu_wiki_space' },
  );
}
