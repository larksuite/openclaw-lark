/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * MCP update-doc 工具
 * 更新云文档（overwrite/append/replace_range/replace_all/insert_before/insert_after/delete_range，支持异步 task_id 查询）
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type, type Static } from '@sinclair/typebox';
import { registerMcpTool } from '../shared';

// Schema 定义
const UpdateDocSchema = Type.Object({
  doc_id: Type.Optional(Type.String({ description: '文档 ID 或 URL' })),
  markdown: Type.Optional(Type.String({ description: 'Markdown 内容' })),
  mode: Type.Union(
    [
      Type.Literal('overwrite'),
      Type.Literal('append'),
      Type.Literal('replace_range'),
      Type.Literal('replace_all'),
      Type.Literal('insert_before'),
      Type.Literal('insert_after'),
      Type.Literal('delete_range'),
    ],
    { description: '更新模式（必填）' },
  ),
  selection_with_ellipsis: Type.Optional(
    Type.String({ description: '定位表达式：开头内容...结尾内容（与 selection_by_title 二选一）' }),
  ),
  selection_by_title: Type.Optional(
    Type.String({ description: '标题定位：例如 ## 章节标题（与 selection_with_ellipsis 二选一）' }),
  ),
  new_title: Type.Optional(Type.String({ description: '新的文档标题（可选）' })),
  task_id: Type.Optional(Type.String({ description: '异步任务 ID，用于查询任务状态' })),
});

type UpdateDocParams = Static<typeof UpdateDocSchema>;

// 参数验证
function validateUpdateDocParams(p: UpdateDocParams): void {
  if (p.task_id) return;
  if (!p.doc_id) {
    throw new Error('update-doc：未提供 task_id 时必须提供 doc_id');
  }
  const needSelection =
    p.mode === 'replace_range' || p.mode === 'insert_before' || p.mode === 'insert_after' || p.mode === 'delete_range';

  if (needSelection) {
    const hasEllipsis = Boolean(p.selection_with_ellipsis);
    const hasTitle = Boolean(p.selection_by_title);
    if ((hasEllipsis && hasTitle) || (!hasEllipsis && !hasTitle)) {
      throw new Error(
        'update-doc：mode 为 replace_range/insert_before/insert_after/delete_range 时，selection_with_ellipsis 与 selection_by_title 必须二选一',
      );
    }
  }

  const needMarkdown = p.mode !== 'delete_range';
  if (needMarkdown && !p.markdown) {
    throw new Error(`update-doc：mode=${p.mode} 时必须提供 markdown`);
  }
}

/**
 * 注册 update-doc 工具
 */
export function registerUpdateDocTool(api: OpenClawPluginApi) {
  registerMcpTool<UpdateDocParams>(api, {
    name: 'feishu_update_doc',
    mcpToolName: 'update-doc',
    toolActionKey: 'feishu_update_doc.default',
    label: 'Feishu MCP: update-doc',
    description:
      '更新云文档（overwrite/append/replace_range/replace_all/insert_before/insert_after/delete_range，支持异步 task_id 查询）',
    schema: UpdateDocSchema,
    validate: validateUpdateDocParams,
  });
}
