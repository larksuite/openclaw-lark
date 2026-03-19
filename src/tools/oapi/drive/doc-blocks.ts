/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_doc_blocks tool -- 获取云文档块结构
 *
 * 用于获取文档的块(Block)结构，每个块有唯一的block_id
 * 支持 wiki token 自动转换
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';
import {
  json,
  createToolContext,
  assertLarkOk,
  handleInvokeErrorWithAutoAuth,
  registerTool,
  StringEnum,
} from '../helpers';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const DocBlocksSchema = Type.Object({
  file_token: Type.String({
    description: '云文档token或wiki节点token(可从文档URL获取)。如果是wiki token，会自动转换为实际文档的obj_token',
  }),
  file_type: StringEnum(['docx', 'wiki'], {
    description: '文档类型。wiki类型会自动解析为docx',
  }),
  block_id: Type.Optional(
    Type.String({
      description: '块ID(可选)。如果提供，则只获取该块的信息；否则获取所有块',
    }),
  ),
  page_size: Type.Optional(
    Type.Integer({
      description: '分页大小(默认500)',
      minimum: 1,
      maximum: 500,
    }),
  ),
  page_token: Type.Optional(
    Type.String({
      description: '分页标记',
    }),
  ),
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerDocBlocksTool(api: OpenClawPluginApi) {
  if (!api.config) return;

  const { toolClient, log } = createToolContext(api, 'feishu_doc_blocks');

  registerTool(
    api,
    {
      name: 'feishu_doc_blocks',
      label: 'Feishu: Doc Blocks',
      description:
        '【以用户身份】获取云文档的块结构。返回文档中所有块的block_id列表，用于局部评论等操作。支持 wiki token。',
      parameters: DocBlocksSchema,
      async execute(_toolCallId, params) {
        const p = params;
        try {
          const client = toolClient();

          // 如果是 wiki token，先转换为实际的 obj_token
          let actualFileToken = p.file_token;
          let actualFileType = p.file_type;

          if (p.file_type === 'wiki') {
            log.info(`doc_blocks: detected wiki token="${p.file_token}", converting to obj_token...`);
            try {
              const wikiNodeRes: any = await client.invoke(
                'feishu_wiki_space_node.get',
                (sdk: any, opts: any) =>
                  sdk.wiki.space.getNode(
                    {
                      params: {
                        token: p.file_token,
                        obj_type: 'wiki',
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(wikiNodeRes);
              const node = wikiNodeRes.data?.node;
              if (!node || !node.obj_token || !node.obj_type) {
                return json({
                  error: `failed to resolve wiki token "${p.file_token}" to document object`,
                  wiki_node: node,
                });
              }
              actualFileToken = node.obj_token;
              actualFileType = node.obj_type;
              log.info(`doc_blocks: wiki token converted: obj_token="${actualFileToken}", obj_type="${actualFileType}"`);
            } catch (err) {
              log.error(`doc_blocks: failed to convert wiki token: ${err}`);
              return json({
                error: `failed to resolve wiki token "${p.file_token}": ${err}`,
              });
            }
          }

          // 如果提供了 block_id，获取单个块
          if (p.block_id) {
            log.info(`doc_blocks: getting block "${p.block_id}" from document "${actualFileToken}"`);
            const res: any = await client.invoke(
              'feishu_doc_blocks.get',
              (sdk: any, opts: any) =>
                sdk.docx.v1.documentBlock.get(
                  {
                    path: {
                      document_id: actualFileToken,
                      block_id: p.block_id,
                    },
                  },
                  opts,
                ),
              { as: 'user' },
            );
            assertLarkOk(res);
            return json({
              block: res.data?.block,
            });
          }

          // 否则获取所有块
          log.info(`doc_blocks: listing blocks from document "${actualFileToken}"`);
          const res: any = await client.invoke(
            'feishu_doc_blocks.list',
            (sdk: any, opts: any) =>
              sdk.docx.v1.documentBlock.list(
                {
                  path: {
                    document_id: actualFileToken,
                  },
                  params: {
                    page_size: p.page_size || 500,
                    page_token: p.page_token,
                  },
                },
                opts,
              ),
            { as: 'user' },
          );
          assertLarkOk(res);

          const items = res.data?.items || [];
          log.info(`doc_blocks: found ${items.length} blocks`);

          return json({
            blocks: items,
            has_more: res.data?.has_more ?? false,
            page_token: res.data?.page_token,
          });
        } catch (err) {
          return handleInvokeErrorWithAutoAuth(err, api, log);
        }
      },
    },
    { name: 'feishu_doc_blocks' },
  );
}
