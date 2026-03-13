/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_calendar_calendar tool -- Manage Feishu calendars.
 *
 * P0 Actions: list, get, primary
 *
 * Uses the Feishu Calendar API:
 *   - list:    GET  /open-apis/calendar/v4/calendars
 *   - get:     GET  /open-apis/calendar/v4/calendars/:calendar_id
 *   - primary: POST /open-apis/calendar/v4/calendars/primary
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';
import { json, createToolContext, assertLarkOk, handleInvokeErrorWithAutoAuth , registerTool } from '../helpers';
import type { CalendarListData, CalendarGetData, CalendarPrimaryData } from '../sdk-types';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuCalendarCalendarSchema = Type.Union([
  // LIST
  Type.Object({
    action: Type.Literal('list'),
    page_size: Type.Optional(
      Type.Number({
        description: 'Number of calendars to return per page (default: 50, max: 1000)',
      }),
    ),
    page_token: Type.Optional(
      Type.String({
        description: 'Pagination token for next page',
      }),
    ),
  }),

  // GET
  Type.Object({
    action: Type.Literal('get'),
    calendar_id: Type.String({
      description: 'Calendar ID',
    }),
  }),

  // PRIMARY
  Type.Object({
    action: Type.Literal('primary'),
  }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuCalendarCalendarParams =
  | { action: 'list'; page_size?: number; page_token?: string }
  | { action: 'get'; calendar_id: string }
  | { action: 'primary' };

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFeishuCalendarCalendarTool(api: OpenClawPluginApi) {
  if (!api.config) return;
  const cfg = api.config;

  const { toolClient, log } = createToolContext(api, 'feishu_calendar_calendar');

  registerTool(
    api,
    {
      name: 'feishu_calendar_calendar',
      label: 'Feishu Calendar Management',
      description:
        '【以用户身份】飞书日历管理工具。用于查询日历列表、获取日历信息、查询主日历。Actions: list（查询日历列表）, get（查询指定日历信息）, primary（查询主日历信息）。',
      parameters: FeishuCalendarCalendarSchema,
      async execute(_toolCallId: string, params: unknown) {
        const p = params as FeishuCalendarCalendarParams;
        try {
          const client = toolClient();

          switch (p.action) {
            // -----------------------------------------------------------------
            // LIST CALENDARS
            // -----------------------------------------------------------------
            case 'list': {
              log.info(`list: page_size=${p.page_size ?? 50}, page_token=${p.page_token ?? 'none'}`);

              const res = await client.invoke(
                'feishu_calendar_calendar.list',
                (sdk, opts) =>
                  sdk.calendar.calendar.list(
                    {
                      params: {
                        page_size: p.page_size,
                        page_token: p.page_token,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              const data = res.data as CalendarListData | undefined;
              const calendars = data?.calendar_list ?? [];
              log.info(`list: returned ${calendars.length} calendars`);

              return json({
                calendars,
                has_more: data?.has_more ?? false,
                page_token: data?.page_token,
              });
            }

            // -----------------------------------------------------------------
            // GET CALENDAR
            // -----------------------------------------------------------------
            case 'get': {
              if (!p.calendar_id) {
                return json({
                  error: "calendar_id is required for 'get' action",
                });
              }

              log.info(`get: calendar_id=${p.calendar_id}`);

              const res = await client.invoke(
                'feishu_calendar_calendar.get',
                (sdk, opts) =>
                  sdk.calendar.calendar.get(
                    {
                      path: { calendar_id: p.calendar_id },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`get: retrieved calendar ${p.calendar_id}`);

              const data = res.data as CalendarGetData | undefined;
              return json({
                calendar: data?.calendar ?? res.data,
              });
            }

            // -----------------------------------------------------------------
            // PRIMARY CALENDAR
            // -----------------------------------------------------------------
            case 'primary': {
              log.info(`primary: querying primary calendar`);

              const res = await client.invoke(
                'feishu_calendar_calendar.primary',
                (sdk, opts) => sdk.calendar.calendar.primary({}, opts),
                { as: 'user' },
              );
              assertLarkOk(res);

              const data = res.data as CalendarPrimaryData | undefined;
              const calendars = data?.calendars ?? [];
              log.info(`primary: returned ${calendars.length} primary calendars`);

              return json({
                calendars,
              });
            }
          }
        } catch (err) {
          return await handleInvokeErrorWithAutoAuth(err, cfg);
        }
      },
    },
    { name: 'feishu_calendar_calendar' },
  );

}
