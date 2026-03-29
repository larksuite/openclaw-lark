/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_raw_api tool -- 直接调用任意飞书 Open API
 *
 * 适用于没有专用工具覆盖的 API（如邮件、视频会议、审批、OKR）。
 * 优先使用专用工具（feishu_sheet、feishu_calendar 等）——它们有更好的错误处理和 OAuth 流程。
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';
import { StringEnum, createToolContext, handleInvokeErrorWithAutoAuth, json, registerTool } from '../helpers';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuRawApiSchema = Type.Object({
  method: StringEnum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], {
    description: 'HTTP method',
  }),
  path: Type.String({
    description: 'Feishu API path starting with /open-apis/, e.g. /open-apis/mail/v1/mailgroups',
    pattern: '^/open-apis/',
  }),
  params: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: 'URL query parameters as key-value string pairs',
    }),
  ),
  data: Type.Optional(
    Type.Any({
      description: 'Request body JSON (for POST/PUT/PATCH). Can be object, array, or primitive.',
    }),
  ),
  as: Type.Optional(
    StringEnum(['user', 'tenant'], {
      description: 'Identity type. "tenant" = bot (default), "user" = user (requires OAuth)',
    }),
  ),
  page_token: Type.Optional(Type.String({ description: 'Pagination token from previous response' })),
  page_size: Type.Optional(
    Type.Integer({
      description: 'Page size (API-specific, typically 10-100)',
      minimum: 1,
      maximum: 500,
    }),
  ),
});

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuRawApiParams = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  params?: Record<string, string>;
  data?: unknown;
  as?: 'user' | 'tenant';
  page_token?: string;
  page_size?: number;
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFeishuRawApiTool(api: OpenClawPluginApi): boolean {
  if (!api.config) return false;
  const cfg = api.config;
  const { toolClient, log } = createToolContext(api, 'feishu_raw_api');

  return registerTool(
    api,
    {
      name: 'feishu_raw_api',
      label: 'Feishu: Raw API',
      description:
        '直接调用任意飞书 Open API。适用于没有专用工具覆盖的 API（如邮件、视频会议、审批、OKR）。' +
        '优先使用专用工具（feishu_sheet、feishu_calendar 等）——它们有更好的错误处理和 OAuth 流程。',
      parameters: FeishuRawApiSchema,
      async execute(_toolCallId: string, params: unknown) {
        const p = params as FeishuRawApiParams;
        try {
          const client = toolClient();

          // Build query params, merging pagination if provided
          const query: Record<string, string> = {};
          if (p.params) {
            for (const [k, v] of Object.entries(p.params)) {
              query[k] = v;
            }
          }
          if (p.page_token) query.page_token = p.page_token;
          if (p.page_size) query.page_size = String(p.page_size);

          log.info(`${p.method} ${p.path} as=${p.as ?? 'tenant'}`);

          const res = await client.invokeByPath('feishu_raw_api.call', p.path, {
            method: p.method,
            body: p.data,
            query: Object.keys(query).length > 0 ? query : undefined,
            as: p.as ?? 'tenant',
          });

          return json(res);
        } catch (err) {
          return await handleInvokeErrorWithAutoAuth(err, cfg);
        }
      },
    },
    { name: 'feishu_raw_api' },
  );
}
