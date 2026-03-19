/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_search_doc_wiki tool -- Search Feishu documents and wikis.
 *
 * Actions: search
 *
 * Uses the Feishu Search API:
 *   - search: POST /open-apis/search/v2/doc_wiki/search
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';
import {
  json,
  createToolContext,
  handleInvokeErrorWithAutoAuth,
  convertTimeRange,
  unixTimestampToISO8601,
  registerTool,
  StringEnum,
} from '../helpers';

// ---------------------------------------------------------------------------
// Schema - Helper types
// ---------------------------------------------------------------------------

const TimeRangeSchema = Type.Object({
  start: Type.Optional(
    Type.String({
      description: "时间范围的起始时间，ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'",
    }),
  ),
  end: Type.Optional(
    Type.String({
      description: "时间范围的截止时间，ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'",
    }),
  ),
});

const DocTypeEnum = StringEnum([
  'DOC',
  'SHEET',
  'BITABLE',
  'MINDNOTE',
  'FILE',
  'WIKI',
  'DOCX',
  'FOLDER',
  'CATALOG',
  'SLIDES',
  'SHORTCUT',
]);

const SortTypeEnum = StringEnum(
  ['DEFAULT_TYPE', 'OPEN_TIME', 'EDIT_TIME', 'EDIT_TIME_ASC', 'CREATE_TIME'],
  {
    description:
      '排序方式。EDIT_TIME=编辑时间降序（最新文档在前，推荐），EDIT_TIME_ASC=编辑时间升序，CREATE_TIME=按文档创建时间排序，OPEN_TIME=打开时间，DEFAULT_TYPE=默认排序',
  },
);

// ---------------------------------------------------------------------------
// Schema - Main
// ---------------------------------------------------------------------------

const FeishuSearchDocWikiSchema = Type.Object({
  action: Type.Literal('search'),
  query: Type.Optional(
    Type.String({
      description:
        '搜索关键词（可选）。不传或传空字符串表示空搜，也可以支持排序规则与筛选，默认根据最近浏览时间返回结果',
      maxLength: 50,
    }),
  ),
  filter: Type.Optional(
    Type.Object(
      {
        creator_ids: Type.Optional(
          Type.Array(Type.String(), {
            description: '创建者 OpenID 列表（最多 20 个）',
            maxItems: 20,
          }),
        ),
        doc_types: Type.Optional(
          Type.Array(DocTypeEnum, {
            description:
              '文档类型列表：DOC（文档）、SHEET（表格）、BITABLE（多维表格）、MINDNOTE（思维导图）、FILE（文件）、WIKI（维基）、DOCX（新版文档）、FOLDER（space文件夹）、CATALOG（wiki2.0文件夹）、SLIDES（新版幻灯片）、SHORTCUT（快捷方式）',
            maxItems: 10,
          }),
        ),
        only_title: Type.Optional(
          Type.Boolean({
            description: '仅搜索标题（默认 false，搜索标题和正文）',
          }),
        ),
        open_time: Type.Optional(TimeRangeSchema),
        sort_type: Type.Optional(SortTypeEnum),
        create_time: Type.Optional(TimeRangeSchema),
      },
      {
        description: '搜索过滤条件（可选）。不传则搜索所有文档和 Wiki；传了则同时对文档和 Wiki 应用相同的过滤条件。',
      },
    ),
  ),
  page_token: Type.Optional(
    Type.String({
      description: '分页标记。首次请求不填；当返回结果中 has_more 为 true 时，可传入返回的 page_token 继续请求下一页',
    }),
  ),
  page_size: Type.Optional(
    Type.Integer({
      description: '分页大小（默认 15，最大 20）',
      minimum: 0,
      maximum: 20,
    }),
  ),
});

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

interface TimeRange {
  start?: string;
  end?: string;
}

interface SearchFilter {
  creator_ids?: string[];
  doc_types?: string[];
  only_title?: boolean;
  open_time?: TimeRange;
  sort_type?: string;
  create_time?: TimeRange;
}

interface FeishuSearchDocWikiParams {
  action: 'search';
  query?: string;
  filter?: SearchFilter;
  page_token?: string;
  page_size?: number;
}

function normalizeSearchResultTimeFields<T>(value: T, converted: { count: number }): T {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeSearchResultTimeFields(item, converted)) as T;
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const source = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(source)) {
    if (key.endsWith('_time')) {
      const iso = unixTimestampToISO8601(item as string | number | undefined);
      if (iso) {
        normalized[key] = iso;
        converted.count += 1;
        continue;
      }
    }
    normalized[key] = normalizeSearchResultTimeFields(item, converted);
  }

  return normalized as T;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFeishuSearchDocWikiTool(api: OpenClawPluginApi): boolean {
  if (!api.config) return false;
  const cfg = api.config;

  const { toolClient, log } = createToolContext(api, 'feishu_search_doc_wiki');

  return registerTool(
    api,
    {
      name: 'feishu_search_doc_wiki',
      label: 'Feishu Document & Wiki Search',
      description:
        '【以用户身份】飞书文档与 Wiki 统一搜索工具。同时搜索云空间文档和知识库 Wiki。Actions: search。' +
        '【重要】query 参数是搜索关键词（必填），filter 参数可选。' +
        '【重要】filter 不传时，搜索所有文档和 Wiki；传了则同时对文档和 Wiki 应用相同的过滤条件。' +
        '【重要】支持按文档类型、创建者、创建时间、打开时间等多维度筛选。' +
        '【重要】返回结果包含标题和摘要高亮（<h>标签包裹匹配关键词）。',
      parameters: FeishuSearchDocWikiSchema,
      async execute(_toolCallId: string, params: unknown) {
        const p = params as FeishuSearchDocWikiParams;
        try {
          const client = toolClient();

          switch (p.action) {
            // -----------------------------------------------------------------
            // SEARCH DOCUMENTS AND WIKIS
            // -----------------------------------------------------------------
            case 'search': {
              // query 为可选参数，默认使用空字符串（表示空搜）
              const query = p.query ?? '';

              log.info(`search: query="${query}", has_filter=${!!p.filter}, page_size=${p.page_size ?? 15}`);

              // 构建请求体
              const requestData: any = {
                query: query,
                page_size: p.page_size,
                page_token: p.page_token,
              };

              // 必须传递 doc_filter 和 wiki_filter，即使为空对象（API 要求）
              if (p.filter) {
                const filter = { ...p.filter };

                // 处理时间字段转换
                if (filter.open_time) {
                  filter.open_time = convertTimeRange(filter.open_time) as any;
                }
                if (filter.create_time) {
                  filter.create_time = convertTimeRange(filter.create_time) as any;
                }

                // 同时设置 doc_filter 和 wiki_filter（内容相同）
                requestData.doc_filter = { ...filter };
                requestData.wiki_filter = { ...filter };

                log.info(
                  `search: applying filter to both doc and wiki: doc_types=${filter.doc_types?.join(',') || 'all'}, only_title=${filter.only_title ?? false}`,
                );
              } else {
                // 即使没有筛选条件，也必须传空对象（否则 API 不返回内容）
                requestData.doc_filter = {};
                requestData.wiki_filter = {};
                log.info(`search: no filter provided, using empty filters (required by API)`);
              }

              // 使用 client.invoke 统一封装底层 request 调用
              const res = await client.invoke(
                'feishu_search_doc_wiki.search',
                async (sdk, _opts, uat) => {
                  return sdk.request(
                    {
                      method: 'POST',
                      url: '/open-apis/search/v2/doc_wiki/search',
                      data: requestData,
                      headers: {
                        Authorization: `Bearer ${uat}`,
                        'Content-Type': 'application/json; charset=utf-8',
                      },
                    },
                    _opts,
                  );
                },
                { as: 'user' },
              );

              // 检查响应
              if ((res as any).code !== 0) {
                throw new Error(`API Error: code=${(res as any).code}, msg=${(res as any).msg}`);
              }

              const data = res.data || {};

              log.info(
                `search: found ${data.res_units?.length ?? 0} results, total=${data.total ?? 0}, has_more=${data.has_more ?? false}`,
              );
              const converted = { count: 0 };
              const normalizedResults = normalizeSearchResultTimeFields(data.res_units, converted);
              log.info(`search: normalized ${converted.count} timestamp fields to ISO8601`);

              return json({
                total: data.total,
                has_more: data.has_more,
                results: normalizedResults,
                page_token: data.page_token,
              });
            }
          }
        } catch (err) {
          return await handleInvokeErrorWithAutoAuth(err, cfg);
        }
      },
    },
    { name: 'feishu_search_doc_wiki' },
  );
}
