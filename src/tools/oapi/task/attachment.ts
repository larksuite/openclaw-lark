/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_task_attachment tool -- Manage task attachments.
 *
 * Actions:
 * - upload: Upload task attachment (tenant identity)
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';

import { StringEnum, createToolContext, handleInvokeErrorWithAutoAuth, json, registerTool } from '../helpers';
import { rawLarkRequest } from '../../../core/raw-request';


// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuTaskAttachmentSchema = Type.Union([
  Type.Object({
    action: Type.Literal('upload'),
    resource_type: Type.Optional(
      StringEnum(['task', 'task_delivery'], {
        description: '资源类型，可选值：task、task_delivery。默认 task。',
        default: 'task',
      }),
    ),
    resource_id: Type.String({
      description: '资源 ID。',
    }),
    file: Type.String({
      description: '文件内容base64编码字符串',
    }),
    name: Type.Optional(Type.String({
      description: '文件名。',
    })),
  }),
]);

export interface FeishuTaskAttachmentParams {
  action: 'upload';
  resource_type?: 'task' | 'task_delivery';
  resource_id: string;
  file: string;
  name?: string;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolvePathForAction(action: FeishuTaskAttachmentParams['action']): { path: string; env: string[] } {
  if (action === 'upload') {
    return { path: '/open-apis/task/v2/attachments/upload', env: [] };
  }
  return { path: '/open-apis/task/v2/attachments/upload', env: [] };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFeishuTaskAttachmentTool(api: OpenClawPluginApi): void {
    if (!api.config) return;
    const cfg = api.config;

    const { toolClient } = createToolContext(api, 'feishu_task_attachment');

    registerTool(
        api,
        {
            name: 'feishu_task_attachment',
            label: 'Feishu Task Attachment',
            description: '飞书任务附件工具。当前提供 upload action，用于上传任务附件。',
            parameters: FeishuTaskAttachmentSchema,
            async execute(_toolCallId: string, params: unknown) {
                const p = params as FeishuTaskAttachmentParams;
                try {
                    const resolved = resolvePathForAction(p.action);
                    const client = toolClient();

                    const resourceType = p.resource_type ?? 'task';
                    const formData = new FormData();

                    formData.append('resource_type', resourceType);
                    formData.append('resource_id', p.resource_id);

                    // 将 base64 字符串解码为二进制文件
                    const fileBuffer = Buffer.from(p.file, 'base64');
                    // 创建 File 对象并添加到 FormData

                    const file = new File([fileBuffer], p.name ?? 'attachment');
                    formData.append('file', file);

                    const as = 'tenant';

                    const tatRes = await rawLarkRequest<{
                        tenant_access_token?: string;
                        [k: string]: unknown;
                    }>({
                        brand: client.account.brand,
                        path: '/open-apis/auth/v3/tenant_access_token/internal/',
                        method: 'POST',
                        body: {
                            app_id: client.account.appId,
                            app_secret: client.account.appSecret,
                        },
                    });
                    const token = tatRes?.tenant_access_token;
                    if (!token) {
                        return json({
                            error: 'Failed to get tenant_access_token.',
                            response: tatRes,
                        });
                    }

                    const res = await client.invokeByPath('feishu_task_attachment.upload', resolved.path, {
                        method: 'POST',
                        as,
                        body: formData,
                        headers: {
                            'Authorization': `Bearer ${token}`,
                        },
                    });
                    return json(res);
                } catch (err) {
                    return await handleInvokeErrorWithAutoAuth(err, cfg);
                }
            },
        },
        { name: 'feishu_task_attachment' },
    );
}