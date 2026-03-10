/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_wiki_space_node tool -- Manage Feishu Wiki space nodes.
 *
 * Actions: list, get, create, move, copy
 *
 * Uses the Feishu Wiki API:
 *   - list:   GET  /open-apis/wiki/v2/spaces/:space_id/nodes
 *   - get:    GET  /open-apis/wiki/v2/spaces/get_node
 *   - create: POST /open-apis/wiki/v2/spaces/:space_id/nodes
 *   - move:   POST /open-apis/wiki/v2/spaces/:space_id/nodes/:node_token/move
 *   - copy:   POST /open-apis/wiki/v2/spaces/:space_id/nodes/:node_token/copy
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';

import {
  json,
  createToolContext,
  assertLarkOk,
  handleInvokeErrorWithAutoAuth,
} from '../helpers';
import type { PaginatedData } from '../sdk-types';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuWikiSpaceNodeSchema = Type.Union([
  // LIST NODES
  Type.Object({
    action: Type.Literal('list'),
    space_id: Type.String({
      description: 'space_id',
    }),
    parent_node_token: Type.Optional(
      Type.String({
        description: 'parent_node_token',
      }),
    ),
    page_size: Type.Optional(
      Type.Integer({
        description: 'page_size',
        minimum: 1,
      }),
    ),
    page_token: Type.Optional(
      Type.String({
        description: 'page_token',
      }),
    ),
  }),

  // GET NODE
  Type.Object({
    action: Type.Literal('get'),
    token: Type.String({
      description: 'node token',
    }),
    obj_type: Type.Optional(
      Type.Union(
        [
          Type.Literal('doc'),
          Type.Literal('sheet'),
          Type.Literal('mindnote'),
          Type.Literal('bitable'),
          Type.Literal('file'),
          Type.Literal('docx'),
          Type.Literal('slides'),
          Type.Literal('wiki'),
        ],
        {
          description: 'obj_type',
        },
      ),
    ),
  }),

  // CREATE NODE
  Type.Object({
    action: Type.Literal('create'),
    space_id: Type.String({
      description: 'space_id',
    }),
    obj_type: Type.Union(
      [
        Type.Literal('doc'),
        Type.Literal('sheet'),
        Type.Literal('mindnote'),
        Type.Literal('bitable'),
        Type.Literal('file'),
        Type.Literal('docx'),
        Type.Literal('slides'),
      ],
      {
        description: 'obj_type',
      },
    ),
    parent_node_token: Type.Optional(
      Type.String({
        description: 'parent_node_token',
      }),
    ),
    node_type: Type.Optional(
      Type.Union([Type.Literal('origin'), Type.Literal('shortcut')], {
        description: 'node_type',
      }),
    ),
    origin_node_token: Type.Optional(
      Type.String({
        description: 'origin_node_token',
      }),
    ),
    title: Type.Optional(
      Type.String({
        description: 'title',
      }),
    ),
  }),

  // MOVE NODE
  Type.Object({
    action: Type.Literal('move'),
    space_id: Type.String({
      description: 'space_id',
    }),
    node_token: Type.String({
      description: 'node_token',
    }),
    target_parent_token: Type.Optional(
      Type.String({
        description: 'target_parent_token',
      }),
    ),
  }),

  // COPY NODE
  Type.Object({
    action: Type.Literal('copy'),
    space_id: Type.String({
      description: 'space_id',
    }),
    node_token: Type.String({
      description: 'node_token',
    }),
    target_space_id: Type.Optional(
      Type.String({
        description: 'target_space_id',
      }),
    ),
    target_parent_token: Type.Optional(
      Type.String({
        description: 'target_parent_token',
      }),
    ),
    title: Type.Optional(
      Type.String({
        description: 'title',
      }),
    ),
  }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuWikiSpaceNodeParams =
  | {
      action: 'list';
      space_id: string;
      parent_node_token?: string;
      page_size?: number;
      page_token?: string;
    }
  | {
      action: 'get';
      token: string;
      obj_type?: string;
    }
  | {
      action: 'create';
      space_id: string;
      obj_type: string;
      parent_node_token?: string;
      node_type?: 'origin' | 'shortcut';
      origin_node_token?: string;
      title?: string;
    }
  | {
      action: 'move';
      space_id: string;
      node_token: string;
      target_parent_token?: string;
    }
  | {
      action: 'copy';
      space_id: string;
      node_token: string;
      target_space_id?: string;
      target_parent_token?: string;
      title?: string;
    };

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFeishuWikiSpaceNodeTool(api: OpenClawPluginApi) {
  if (!api.config) return;
  const cfg = api.config;

  const { toolClient, log } = createToolContext(api, 'feishu_wiki_space_node');

  api.registerTool(
    {
      name: 'feishu_wiki_space_node',
      label: 'Feishu Wiki Space Nodes',
      description:
        '飞书知识库节点管理工具。操作：list（列表）、get（获取）、create（创建）、move（移动）、copy（复制）。' +
        '节点是知识库中的文档，包括 doc、bitable(多维表表格)、sheet(电子表格) 等类型。' +
        'node_token 是节点的唯一标识符，obj_token 是实际文档的 token。可通过 get 操作将 wiki 类型的 node_token 转换为实际文档的 obj_token。',
      parameters: FeishuWikiSpaceNodeSchema,
      async execute(_toolCallId: string, params: unknown) {
        const p = params as FeishuWikiSpaceNodeParams;
        try {
          const client = toolClient();

          switch (p.action) {
            // -----------------------------------------------------------------
            // LIST NODES
            // -----------------------------------------------------------------
            case 'list': {
              log.info(
                `list: space_id=${p.space_id}, parent=${p.parent_node_token ?? '(root)'}, page_size=${p.page_size ?? 50}`,
              );

              const res = await client.invoke(
                'feishu_wiki_space_node.list',
                (sdk, opts) =>
                  sdk.wiki.spaceNode.list(
                    {
                      path: { space_id: p.space_id },
                      params: {
                        page_size: p.page_size as any,
                        page_token: p.page_token,
                        parent_node_token: p.parent_node_token,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              const data = res.data as PaginatedData | undefined;
              log.info(`list: returned ${data?.items?.length ?? 0} nodes`);

              return json({
                nodes: data?.items,
                has_more: data?.has_more,
                page_token: data?.page_token,
              });
            }

            // -----------------------------------------------------------------
            // GET NODE
            // -----------------------------------------------------------------
            case 'get': {
              log.info(`get: token=${p.token}, obj_type=${p.obj_type ?? 'wiki'}`);

              const res = await client.invoke(
                'feishu_wiki_space_node.get',
                (sdk, opts) =>
                  sdk.wiki.space.getNode(
                    {
                      params: {
                        token: p.token,
                        obj_type: (p.obj_type || 'wiki') as any,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`get: retrieved node ${p.token}`);

              return json({
                node: res.data?.node,
              });
            }

            // -----------------------------------------------------------------
            // CREATE NODE
            // -----------------------------------------------------------------
            case 'create': {
              log.info(
                `create: space_id=${p.space_id}, obj_type=${p.obj_type}, parent=${p.parent_node_token ?? '(root)'}, title=${p.title ?? '(empty)'}`,
              );

              const res = await client.invoke(
                'feishu_wiki_space_node.create',
                (sdk, opts) =>
                  sdk.wiki.spaceNode.create(
                    {
                      path: { space_id: p.space_id },
                      data: {
                        obj_type: p.obj_type as any,
                        parent_node_token: p.parent_node_token,
                        node_type: p.node_type as any,
                        origin_node_token: p.origin_node_token,
                        title: p.title,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`create: created node_token=${(res.data?.node as any)?.node_token}`);

              return json({
                node: res.data?.node,
              });
            }

            // -----------------------------------------------------------------
            // MOVE NODE
            // -----------------------------------------------------------------
            case 'move': {
              log.info(
                `move: space_id=${p.space_id}, node_token=${p.node_token}, target_parent=${p.target_parent_token ?? '(root)'}`,
              );

              const res = await client.invoke(
                'feishu_wiki_space_node.move',
                (sdk, opts) =>
                  sdk.wiki.spaceNode.move(
                    {
                      path: {
                        space_id: p.space_id,
                        node_token: p.node_token,
                      },
                      data: {
                        target_parent_token: p.target_parent_token,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`move: moved node ${p.node_token}`);

              return json({
                node: res.data?.node,
              });
            }

            // -----------------------------------------------------------------
            // COPY NODE
            // -----------------------------------------------------------------
            case 'copy': {
              log.info(
                `copy: space_id=${p.space_id}, node_token=${p.node_token}, target_space=${p.target_space_id ?? '(same)'}, target_parent=${p.target_parent_token ?? '(root)'}`,
              );

              const res = await client.invoke(
                'feishu_wiki_space_node.copy',
                (sdk, opts) =>
                  sdk.wiki.spaceNode.copy(
                    {
                      path: {
                        space_id: p.space_id,
                        node_token: p.node_token,
                      },
                      data: {
                        target_space_id: p.target_space_id,
                        target_parent_token: p.target_parent_token,
                        title: p.title,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`copy: copied to node_token=${(res.data?.node as any)?.node_token}`);

              return json({
                node: res.data?.node,
              });
            }
          }
        } catch (err) {
          return await handleInvokeErrorWithAutoAuth(err, cfg);
        }
      },
    },
    { name: 'feishu_wiki_space_node' },
  );

  api.logger.info?.('feishu_wiki_space_node: Registered feishu_wiki_space_node tool');
}
