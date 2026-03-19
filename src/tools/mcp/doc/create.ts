/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * MCP create-doc 工具
 * 从 Markdown 创建云文档（支持异步 task_id 查询）
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type, type Static } from '@sinclair/typebox';
import { registerMcpTool } from '../shared';

// Schema 定义
const CreateDocSchema = Type.Object({
  markdown: Type.Optional(Type.String({ description: 'Markdown 内容' })),
  title: Type.Optional(Type.String({ description: '文档标题' })),
  folder_token: Type.Optional(Type.String({ description: '父文件夹 token（可选）' })),
  wiki_node: Type.Optional(Type.String({ description: '知识库节点 token 或 URL（可选，传入则在该节点下创建文档）' })),
  wiki_space: Type.Optional(Type.String({ description: '知识空间 ID（可选，特殊值 my_library）' })),
  task_id: Type.Optional(Type.String({ description: '异步任务 ID。提供此参数将查询任务状态而非创建新文档' })),
});

type CreateDocParams = Static<typeof CreateDocSchema>;

// 参数验证
function validateCreateDocParams(p: CreateDocParams): void {
  if (p.task_id) return;
  if (!p.markdown || !p.title) {
    throw new Error('create-doc：未提供 task_id 时，至少需要提供 markdown 和 title');
  }
  const flags = [p.folder_token, p.wiki_node, p.wiki_space].filter(Boolean);
  if (flags.length > 1) {
    throw new Error('create-doc：folder_token / wiki_node / wiki_space 三者互斥，请只提供一个');
  }
}

/**
 * 注册 create-doc 工具
 */
export function registerCreateDocTool(api: OpenClawPluginApi): boolean {
  return registerMcpTool<CreateDocParams>(api, {
    name: 'feishu_create_doc',
    mcpToolName: 'create-doc',
    toolActionKey: 'feishu_create_doc.default',
    label: 'Feishu MCP: create-doc',
    description: '从 Markdown 创建云文档（支持异步 task_id 查询）',
    schema: CreateDocSchema,
    validate: validateCreateDocParams,
  });
}
