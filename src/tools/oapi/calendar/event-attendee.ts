/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_calendar_event_attendee tool -- Manage Feishu calendar event attendees.
 *
 * P0 Actions: create, list
 *
 * Uses the Feishu Calendar API:
 *   - create: POST /open-apis/calendar/v4/calendars/:calendar_id/events/:event_id/attendees
 *   - list:   GET  /open-apis/calendar/v4/calendars/:calendar_id/events/:event_id/attendees
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { OpenClawPluginApi } from '../../../types/plugin-sdk-types';
import { Type } from '@sinclair/typebox';
import { StringEnum, assertLarkOk, createToolContext, handleInvokeErrorWithAutoAuth, json, registerTool } from '../helpers';
import type { PaginatedData } from '../sdk-types';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuCalendarEventAttendeeSchema = Type.Union([
  // CREATE
  Type.Object({
    action: Type.Literal('create'),
    calendar_id: Type.String({
      description: '日历 ID',
    }),
    event_id: Type.String({
      description: '日程 ID',
    }),
    attendees: Type.Array(
      Type.Object({
        type: StringEnum(['user', 'chat', 'resource', 'third_party']),
        attendee_id: Type.String({
          description:
            '参会人 ID。type=user 时为 open_id，type=chat 时为 chat_id，type=resource 时为会议室 ID，type=third_party 时为邮箱地址',
        }),
      }),
      {
        description: '参会人列表',
      },
    ),
    need_notification: Type.Optional(
      Type.Boolean({
        description: '是否给参会人发送通知（默认 true）',
      }),
    ),
    attendee_ability: Type.Optional(
      StringEnum(['none', 'can_see_others', 'can_invite_others', 'can_modify_event']),
    ),
  }),

  // LIST
  Type.Object({
    action: Type.Literal('list'),
    calendar_id: Type.String({
      description: '日历 ID',
    }),
    event_id: Type.String({
      description: '日程 ID',
    }),
    page_size: Type.Optional(
      Type.Number({
        description: '每页数量（默认 50，最大 500）',
      }),
    ),
    page_token: Type.Optional(
      Type.String({
        description: '分页标记',
      }),
    ),
    user_id_type: Type.Optional(
      StringEnum(['open_id', 'union_id', 'user_id']),
    ),
  }),

]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuCalendarEventAttendeeParams =
  | {
      action: 'create';
      calendar_id: string;
      event_id: string;
      attendees: Array<{ type: string; attendee_id: string }>;
      need_notification?: boolean;
      attendee_ability?: string;
    }
  | {
      action: 'list';
      calendar_id: string;
      event_id: string;
      page_size?: number;
      page_token?: string;
      user_id_type?: string;
    };

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFeishuCalendarEventAttendeeTool(api: OpenClawPluginApi): void {
  if (!api.config) return;
  const cfg = api.config;

  const { toolClient, log } = createToolContext(api, 'feishu_calendar_event_attendee');

  registerTool(
    api,
    {
      name: 'feishu_calendar_event_attendee',
      label: 'Feishu Calendar Event Attendees',
      description:
        '飞书日程参会人管理工具。当用户要求邀请/添加参会人、查看参会人列表时使用。Actions: create（添加参会人）, list（查询参会人列表）。',
      parameters: FeishuCalendarEventAttendeeSchema,
      async execute(_toolCallId, params) {
        const p = params as FeishuCalendarEventAttendeeParams;

        try {
          const client = toolClient();

          switch (p.action) {
            // -----------------------------------------------------------------
            // CREATE ATTENDEES
            // -----------------------------------------------------------------
            case 'create': {
              if (!p.attendees || p.attendees.length === 0) {
                return json({
                  error: 'attendees is required and cannot be empty',
                });
              }

              log.info(
                `create: calendar_id=${p.calendar_id}, event_id=${p.event_id}, attendees_count=${p.attendees.length}`,
              );

              const attendeeData = p.attendees.map((a) => {
                const base: any = {
                  type: a.type,
                  is_optional: false,
                };

                if (a.type === 'user') {
                  base.user_id = a.attendee_id;
                } else if (a.type === 'chat') {
                  base.chat_id = a.attendee_id;
                } else if (a.type === 'resource') {
                  base.room_id = a.attendee_id;
                } else if (a.type === 'third_party') {
                  base.third_party_email = a.attendee_id;
                }

                return base;
              });

              const res = await client.invoke(
                'feishu_calendar_event.create',
                (sdk, opts) =>
                  sdk.calendar.calendarEventAttendee.create(
                    {
                      path: {
                        calendar_id: p.calendar_id,
                        event_id: p.event_id,
                      },
                      params: {
                        user_id_type: 'open_id' as any,
                      },
                      data: {
                        attendees: attendeeData,
                        need_notification: p.need_notification ?? true,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`create: added ${p.attendees.length} attendees to event ${p.event_id}`);

              return json({
                attendees: res.data?.attendees,
              });
            }

            // -----------------------------------------------------------------
            // LIST ATTENDEES
            // -----------------------------------------------------------------
            case 'list': {
              log.info(`list: calendar_id=${p.calendar_id}, event_id=${p.event_id}, page_size=${p.page_size ?? 50}`);

              const res = await client.invoke(
                'feishu_calendar_event_attendee.list',
                (sdk, opts) =>
                  sdk.calendar.calendarEventAttendee.list(
                    {
                      path: {
                        calendar_id: p.calendar_id,
                        event_id: p.event_id,
                      },
                      params: {
                        page_size: p.page_size,
                        page_token: p.page_token,
                        user_id_type: (p.user_id_type || 'open_id') as any,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              const data = res.data as PaginatedData | undefined;
              log.info(`list: returned ${data?.items?.length ?? 0} attendees`);

              return json({
                attendees: data?.items,
                has_more: data?.has_more ?? false,
                page_token: data?.page_token,
              });
            }

          }
        } catch (err) {
          return await handleInvokeErrorWithAutoAuth(err, cfg);
        }
      },
    },
    { name: 'feishu_calendar_event_attendee' },
  );

}
