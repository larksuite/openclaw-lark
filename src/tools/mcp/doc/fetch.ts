/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * MCP fetch-doc 工具
 * 查看云文档内容（返回标题与 Markdown，支持分页）
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type, type Static } from '@sinclair/typebox';
import { registerMcpTool } from '../shared';

// Schema 定义
const FetchDocSchema = Type.Object({
  doc_id: Type.String({
    description: '文档 ID 或 URL（支持自动解析）',
  }),
  offset: Type.Optional(
    Type.Integer({
      description: '字符偏移量（可选，默认0）。用于大文档分页获取。',
      minimum: 0,
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      description: '返回的最大字符数（可选）。仅在用户明确要求分页时使用。',
      minimum: 1,
    }),
  ),
});

type FetchDocParams = Static<typeof FetchDocSchema>;

/**
 * 注册 fetch-doc 工具
 */
export function registerFetchDocTool(api: OpenClawPluginApi): boolean {
  return registerMcpTool<FetchDocParams>(api, {
    name: 'feishu_fetch_doc',
    mcpToolName: 'fetch-doc',
    toolActionKey: 'feishu_fetch_doc.default',
    label: 'Feishu MCP: fetch-doc',
    description: '获取飞书云文档内容，返回文档标题和 Markdown 格式内容。支持分页获取大文档。',
    schema: FetchDocSchema,
  });
}
