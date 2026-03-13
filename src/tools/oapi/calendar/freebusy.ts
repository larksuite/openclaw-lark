/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_calendar_freebusy tool -- Query user/room calendar free/busy status.
 *
 * P0 Actions: list
 *
 * Uses the Feishu Calendar API:
 *   - list: POST /open-apis/calendar/v4/freebusy/batch (批量查询接口)
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';
import { json, createToolContext, parseTimeToRFC3339, assertLarkOk, handleInvokeErrorWithAutoAuth , registerTool } from '../helpers';
import type { FreebusyData } from '../sdk-types';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuCalendarFreebusySchema = Type.Object({
  action: Type.Literal('list'),
  time_min: Type.String({
    description: "查询起始时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）",
  }),
  time_max: Type.String({
    description: "查询结束时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）",
  }),
  user_ids: Type.Array(
    Type.String({
      description: '用户 open_id',
    }),
    {
      description: '要查询忙闲的用户 ID 列表（1-10 个用户）',
      minItems: 1,
      maxItems: 10,
    },
  ),
});

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

interface FeishuCalendarFreebusyParams {
  action: 'list';
  time_min: string;
  time_max: string;
  user_ids: string[];
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFeishuCalendarFreebusyTool(api: OpenClawPluginApi) {
  if (!api.config) return;
  const cfg = api.config;

  const { toolClient, log } = createToolContext(api, 'feishu_calendar_freebusy');

  registerTool(
    api,
    {
      name: 'feishu_calendar_freebusy',
      label: 'Feishu Calendar Free/Busy Status',
      description:
        '【以用户身份】飞书日历忙闲查询工具。当用户要求查询某时间段内某人是否空闲、查看忙闲状态时使用。支持批量查询 1-10 个用户的主日历忙闲信息，用于安排会议时间。',
      parameters: FeishuCalendarFreebusySchema,
      async execute(_toolCallId, params) {
        const p = params as FeishuCalendarFreebusyParams;

        log.info(`[FREEBUSY] Execute called with params: ${JSON.stringify(p)}`);

        try {
          const client = toolClient();

          if (p.action !== 'list') {
            log.warn(`[FREEBUSY] Unknown action: ${p.action}`);
            return json({ error: `Unknown action: ${p.action}` });
          }

          // Validate user_ids (batch API requires 1-10 users)
          if (!p.user_ids || p.user_ids.length === 0) {
            log.warn(`[FREEBUSY] user_ids is empty`);
            return json({
              error: 'user_ids is required (1-10 user IDs)',
            });
          }

          if (p.user_ids.length > 10) {
            log.warn(`[FREEBUSY] user_ids exceeds limit: ${p.user_ids.length}`);
            return json({
              error: `user_ids count exceeds limit, maximum 10 users (current: ${p.user_ids.length})`,
            });
          }

          log.info(`[FREEBUSY] Validation passed, user_ids count: ${p.user_ids.length}`);

          // Convert time strings to RFC 3339 format (required by freebusy API)
          const timeMin = parseTimeToRFC3339(p.time_min);
          const timeMax = parseTimeToRFC3339(p.time_max);

          if (!timeMin || !timeMax) {
            log.warn(`[FREEBUSY] Time format error: time_min=${p.time_min}, time_max=${p.time_max}`);
            return json({
              error:
                "Invalid time format. Must use ISO 8601 / RFC 3339 with timezone, e.g. '2024-01-01T00:00:00+08:00' or '2026-02-25 14:00:00'.",
              received_time_min: p.time_min,
              received_time_max: p.time_max,
            });
          }

          log.info(
            `[FREEBUSY] Calling batch API: time_min=${p.time_min} -> ${timeMin}, time_max=${p.time_max} -> ${timeMax}, user_ids=${p.user_ids.length}`,
          );

          const res = await client.invoke(
            'feishu_calendar_freebusy.list',
            (sdk, opts) =>
              sdk.calendar.freebusy.batch(
                {
                  data: {
                    time_min: timeMin,
                    time_max: timeMax,
                    user_ids: p.user_ids,
                    include_external_calendar: true,
                    only_busy: true,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  } as any, // SDK 类型定义可能未包含所有字段
                },
                opts,
              ),
            { as: 'user' },
          );
          assertLarkOk(res);

          const data = res.data as FreebusyData | undefined;
          const freebusyLists = data?.freebusy_lists ?? [];
          log.info(`[FREEBUSY] Success: returned ${freebusyLists.length} user(s) freebusy data`);

          return json({
            freebusy_lists: freebusyLists,
            _debug: {
              time_min_input: p.time_min,
              time_min_rfc3339: timeMin,
              time_max_input: p.time_max,
              time_max_rfc3339: timeMax,
              user_count: p.user_ids.length,
            },
          });
        } catch (err) {
          return await handleInvokeErrorWithAutoAuth(err, cfg);
        }
      },
    },
    { name: 'feishu_calendar_freebusy' },
  );

}
