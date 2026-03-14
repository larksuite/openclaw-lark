/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_calendar_event tool -- Manage Feishu calendar events.
 *
 * P0 Actions: create, list, get
 *
 * Uses the Feishu Calendar API:
 *   - create: POST /open-apis/calendar/v4/calendars/:calendar_id/events
 *             POST /open-apis/calendar/v4/calendars/:calendar_id/events/:event_id/attendees/batch_create
 *   - list:   GET  /open-apis/calendar/v4/calendars/:calendar_id/events/instance_view
 *   - get:    GET  /open-apis/calendar/v4/calendars/:calendar_id/events/:event_id
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';
import {
  json,
  createToolContext,
  parseTimeToTimestamp,
  assertLarkOk,
  handleInvokeErrorWithAutoAuth,
  formatLarkError,
  unixTimestampToISO8601,
  registerTool,
  StringEnum,
} from '../helpers';
import type { CalendarPrimaryData, PaginatedData } from '../sdk-types';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuCalendarEventSchema = Type.Union([
  // CREATE
  Type.Object({
    action: Type.Literal('create'),
    start_time: Type.String({
      description: "开始时间（必填）。ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'",
    }),
    end_time: Type.String({
      description: '结束时间（必填）。格式同 start_time。如果用户未指定时长，默认为开始时间后1小时。',
    }),
    summary: Type.Optional(
      Type.String({
        description: '日程标题（可选，但强烈建议提供）',
      }),
    ),
    user_open_id: Type.Optional(
      Type.String({
        description:
          '当前请求用户的 open_id（可选，但强烈建议提供）。从消息上下文的 SenderId 字段获取，格式为 ou_xxx。日程创建在应用日历上，必须通过此参数将用户加为参会人，日程才会出现在用户的飞书日历中。',
      }),
    ),
    calendar_id: Type.Optional(
      Type.String({
        description: 'Calendar ID (optional; primary calendar used if omitted)',
      }),
    ),
    description: Type.Optional(
      Type.String({
        description: '日程描述',
      }),
    ),
    attendees: Type.Optional(
      Type.Array(
        Type.Object({
          type: StringEnum(['user', 'chat', 'resource', 'third_party']),
          id: Type.String({
            description: 'Attendee open_id, chat_id, resource_id, or email',
          }),
        }),
        {
          description:
            "参会人列表（强烈建议提供，否则日程只在应用日历上，用户看不到）。type='user' 时 id 填 open_id，type='third_party' 时 id 填邮箱。",
        },
      ),
    ),
    vchat: Type.Optional(
      Type.Object(
        {
          vc_type: Type.Optional(
            StringEnum(['vc', 'third_party', 'no_meeting'], {
              description:
                '视频会议类型：vc（飞书视频会议）、third_party（第三方链接）、no_meeting（无视频会议）。默认为空，首次添加参与人时自动生成飞书视频会议。',
            }),
          ),
          icon_type: Type.Optional(
            StringEnum(['vc', 'live', 'default'], {
              description: '第三方视频会议 icon 类型（仅 vc_type=third_party 时有效）。',
            }),
          ),
          description: Type.Optional(
            Type.String({
              description: '第三方视频会议文案（仅 vc_type=third_party 时有效）。',
            }),
          ),
          meeting_url: Type.Optional(
            Type.String({
              description: '第三方视频会议链接（仅 vc_type=third_party 时有效）。',
            }),
          ),
        },
        {
          description: '视频会议信息。不传则默认在首次添加参与人时自动生成飞书视频会议。',
        },
      ),
    ),
    visibility: Type.Optional(
      StringEnum(['default', 'public', 'private'], {
        description:
          '日程公开范围。default（默认，跟随日历权限）、public（公开详情）、private（私密，仅自己可见）。默认值：default。',
      }),
    ),
    attendee_ability: Type.Optional(
      StringEnum(
        ['none', 'can_see_others', 'can_invite_others', 'can_modify_event'],
        {
          description:
            '参与人权限。none（无法编辑、邀请、查看）、can_see_others（可查看参与人列表）、can_invite_others（可邀请其他人）、can_modify_event（可编辑日程）。默认值：none。',
        },
      ),
    ),
    free_busy_status: Type.Optional(
      StringEnum(['busy', 'free'], {
        description: '日程占用的忙闲状态。busy（忙碌）、free（空闲）。默认值：busy。',
      }),
    ),
    location: Type.Optional(
      Type.Object(
        {
          name: Type.Optional(
            Type.String({
              description: '地点名称',
            }),
          ),
          address: Type.Optional(
            Type.String({
              description: '地点地址',
            }),
          ),
          latitude: Type.Optional(
            Type.Number({
              description: '地点坐标纬度（国内采用 GCJ-02 标准，海外采用 WGS84 标准）',
            }),
          ),
          longitude: Type.Optional(
            Type.Number({
              description: '地点坐标经度（国内采用 GCJ-02 标准，海外采用 WGS84 标准）',
            }),
          ),
        },
        {
          description: '日程地点信息',
        },
      ),
    ),
    reminders: Type.Optional(
      Type.Array(
        Type.Object({
          minutes: Type.Number({
            description:
              '日程提醒时间的偏移量（分钟）。正数表示在日程开始前提醒，负数表示在日程开始后提醒。范围：-20160 ~ 20160。',
          }),
        }),
        {
          description: '日程提醒列表',
        },
      ),
    ),
    recurrence: Type.Optional(
      Type.String({
        description: "重复日程的重复性规则（RFC5545 RRULE 格式）。例如：'FREQ=DAILY;INTERVAL=1' 表示每天重复。",
      }),
    ),
  }),

  // LIST (使用 instance_view 接口)
  Type.Object({
    action: Type.Literal('list'),
    start_time: Type.String({
      description:
        "开始时间。ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'。注意：start_time 与 end_time 之间的时间区间需要小于 40 天。",
    }),
    end_time: Type.String({
      description: '结束时间。格式同 start_time。注意：start_time 与 end_time 之间的时间区间需要小于 40 天。',
    }),
    calendar_id: Type.Optional(
      Type.String({
        description: 'Calendar ID (optional; primary calendar used if omitted)',
      }),
    ),
  }),

  // GET
  Type.Object({
    action: Type.Literal('get'),
    event_id: Type.String({
      description: 'Event ID',
    }),
    calendar_id: Type.Optional(
      Type.String({
        description: 'Calendar ID (optional; primary calendar used if omitted)',
      }),
    ),
  }),

  // PATCH (P1)
  Type.Object({
    action: Type.Literal('patch'),
    event_id: Type.String({
      description: 'Event ID',
    }),
    calendar_id: Type.Optional(
      Type.String({
        description: 'Calendar ID (optional; primary calendar used if omitted)',
      }),
    ),
    summary: Type.Optional(
      Type.String({
        description: '新的日程标题',
      }),
    ),
    description: Type.Optional(
      Type.String({
        description: '新的日程描述',
      }),
    ),
    start_time: Type.Optional(
      Type.String({
        description: "新的开始时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）",
      }),
    ),
    end_time: Type.Optional(
      Type.String({
        description: "新的结束时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）",
      }),
    ),
    location: Type.Optional(
      Type.String({
        description: '新的地点',
      }),
    ),
  }),

  // DELETE (P1)
  Type.Object({
    action: Type.Literal('delete'),
    event_id: Type.String({
      description: 'Event ID',
    }),
    calendar_id: Type.Optional(
      Type.String({
        description: 'Calendar ID (optional; primary calendar used if omitted)',
      }),
    ),
    need_notification: Type.Optional(
      Type.Boolean({
        description: '是否通知参会人（默认 true）',
      }),
    ),
  }),

  // SEARCH (P1)
  Type.Object({
    action: Type.Literal('search'),
    query: Type.String({
      description: '搜索关键词',
    }),
    calendar_id: Type.Optional(
      Type.String({
        description: 'Calendar ID (optional; primary calendar used if omitted)',
      }),
    ),
    page_size: Type.Optional(
      Type.Number({
        description: '每页数量',
      }),
    ),
    page_token: Type.Optional(
      Type.String({
        description: '分页标记',
      }),
    ),
  }),

  // REPLY (P1)
  Type.Object({
    action: Type.Literal('reply'),
    event_id: Type.String({
      description: 'Event ID',
    }),
    calendar_id: Type.Optional(
      Type.String({
        description: 'Calendar ID (optional; primary calendar used if omitted)',
      }),
    ),
    rsvp_status: StringEnum(['accept', 'decline', 'tentative']),
  }),

  // INSTANCES (P1)
  Type.Object({
    action: Type.Literal('instances'),
    event_id: Type.String({
      description: '重复日程的 Event ID',
    }),
    calendar_id: Type.Optional(
      Type.String({
        description: 'Calendar ID (optional; primary calendar used if omitted)',
      }),
    ),
    start_time: Type.String({
      description: "查询起始时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）",
    }),
    end_time: Type.String({
      description: "查询结束时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）",
    }),
    page_size: Type.Optional(
      Type.Number({
        description: '每页数量',
      }),
    ),
    page_token: Type.Optional(
      Type.String({
        description: '分页标记',
      }),
    ),
  }),

  // INSTANCE_VIEW (P1)
  Type.Object({
    action: Type.Literal('instance_view'),
    start_time: Type.String({
      description: "查询起始时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）",
    }),
    end_time: Type.String({
      description: "查询结束时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）",
    }),
    calendar_id: Type.Optional(
      Type.String({
        description: 'Calendar ID (optional; primary calendar used if omitted)',
      }),
    ),
    page_size: Type.Optional(
      Type.Number({
        description: '每页数量',
      }),
    ),
    page_token: Type.Optional(
      Type.String({
        description: '分页标记',
      }),
    ),
  }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuCalendarEventParams =
  | {
      action: 'create';
      start_time: string;
      end_time: string;
      summary?: string;
      user_open_id?: string;
      calendar_id?: string;
      description?: string;
      attendees?: Array<{ type: string; id: string }>;
      vchat?: {
        vc_type?: 'vc' | 'third_party' | 'no_meeting';
        icon_type?: 'vc' | 'live' | 'default';
        description?: string;
        meeting_url?: string;
      };
      visibility?: 'default' | 'public' | 'private';
      attendee_ability?: 'none' | 'can_see_others' | 'can_invite_others' | 'can_modify_event';
      free_busy_status?: 'busy' | 'free';
      location?: {
        name?: string;
        address?: string;
        latitude?: number;
        longitude?: number;
      };
      reminders?: Array<{ minutes: number }>;
      recurrence?: string;
    }
  | {
      action: 'list';
      start_time: string;
      end_time: string;
      calendar_id?: string;
    }
  | {
      action: 'get';
      event_id: string;
      calendar_id?: string;
    }
  | {
      action: 'patch';
      event_id: string;
      calendar_id?: string;
      summary?: string;
      description?: string;
      start_time?: string;
      end_time?: string;
      location?: string;
    }
  | {
      action: 'delete';
      event_id: string;
      calendar_id?: string;
      need_notification?: boolean;
    }
  | {
      action: 'search';
      query: string;
      calendar_id?: string;
      page_size?: number;
      page_token?: string;
    }
  | {
      action: 'reply';
      event_id: string;
      calendar_id?: string;
      rsvp_status: 'accept' | 'decline' | 'tentative';
    }
  | {
      action: 'instances';
      event_id: string;
      calendar_id?: string;
      start_time: string;
      end_time: string;
      page_size?: number;
      page_token?: string;
    }
  | {
      action: 'instance_view';
      start_time: string;
      end_time: string;
      calendar_id?: string;
      page_size?: number;
      page_token?: string;
    };

function normalizeCalendarTimeValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;

  if (typeof value === 'string') {
    const iso = unixTimestampToISO8601(value);
    return iso ?? value;
  }

  if (typeof value !== 'object') return undefined;

  const timeObj = value as { timestamp?: unknown; date?: unknown };
  const fromTimestamp = unixTimestampToISO8601(timeObj.timestamp as string | number | undefined);
  if (fromTimestamp) return fromTimestamp;

  if (typeof timeObj.date === 'string') return timeObj.date;

  return undefined;
}

function normalizeEventTimeFields(event: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!event) return event;

  const normalized: Record<string, any> = { ...event };

  const startTime = normalizeCalendarTimeValue(event.start_time);
  if (startTime) {
    normalized.start_time = startTime;
  }

  const endTime = normalizeCalendarTimeValue(event.end_time);
  if (endTime) {
    normalized.end_time = endTime;
  }

  const createTime = unixTimestampToISO8601(event.create_time as string | number | undefined);
  if (createTime) {
    normalized.create_time = createTime;
  }

  return normalized;
}

function normalizeEventListTimeFields(
  events: Array<Record<string, any>> | undefined,
): Array<Record<string, any>> | undefined {
  if (!events) return events;
  return events.map((item) => normalizeEventTimeFields(item) as Record<string, any>);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFeishuCalendarEventTool(api: OpenClawPluginApi) {
  if (!api.config) return;
  const cfg = api.config;

  const { toolClient, log } = createToolContext(api, 'feishu_calendar_event');

  const resolveCalendarId = async (client: ReturnType<typeof toolClient>): Promise<string | null> => {
    const primaryRes = await client.invoke(
      'feishu_calendar_calendar.primary',
      (sdk, opts) => sdk.calendar.calendar.primary({}, opts),
      { as: 'user' },
    );
    const data = primaryRes.data as CalendarPrimaryData | undefined;
    const cid = data?.calendars?.[0]?.calendar?.calendar_id;
    if (cid) {
      log.info(`resolveCalendarId: primary() returned calendar_id=${cid}`);
      return cid;
    }
    return null;
  };

  const resolveCalendarIdOrFail = async (
    calendarId: string | undefined,
    client: ReturnType<typeof toolClient>,
  ): Promise<string> => {
    if (calendarId) return calendarId;
    const resolved = await resolveCalendarId(client);
    if (!resolved) throw new Error('Could not determine primary calendar');
    return resolved;
  };

  registerTool(
    api,
    {
      name: 'feishu_calendar_event',
      label: 'Feishu Calendar Events',
      description:
        "【以用户身份】飞书日程管理工具。当用户要求查看日程、创建会议、约会议、修改日程、删除日程、搜索日程、回复日程邀请时使用。Actions: create（创建日历事件）, list（查询时间范围内的日程，自动展开重复日程）, get（获取日程详情）, patch（更新日程）, delete（删除日程）, search（搜索日程）, reply（回复日程邀请）, instances（获取重复日程的实例列表，仅对重复日程有效）, instance_view（查看展开后的日程列表）。【重要】create 时必须传 user_open_id 参数，值为消息上下文中的 SenderId（格式 ou_xxx），否则日程只在应用日历上，用户完全看不到。list 操作使用 instance_view 接口，会自动展开重复日程为多个实例，时间区间不能超过40天，返回实例数量上限1000。时间参数使用ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'。",
      parameters: FeishuCalendarEventSchema,
      async execute(_toolCallId: string, params: unknown) {
        const p = params as FeishuCalendarEventParams;
        try {
          const client = toolClient();

          switch (p.action) {
            // -----------------------------------------------------------------
            // CREATE EVENT
            // -----------------------------------------------------------------
            case 'create': {
              if (!p.summary) return json({ error: 'summary is required' });
              if (!p.start_time) return json({ error: 'start_time is required' });
              if (!p.end_time) return json({ error: 'end_time is required' });

              const startTs = parseTimeToTimestamp(p.start_time);
              const endTs = parseTimeToTimestamp(p.end_time);
              if (!startTs || !endTs)
                return json({
                  error:
                    "Invalid time format. Must use ISO 8601 / RFC 3339 with timezone, e.g. '2024-01-01T00:00:00+08:00' or '2026-02-25 14:00:00'. Do not pass Unix timestamp numbers.",
                  received_start: p.start_time,
                  received_end: p.end_time,
                });

              log.info(
                `create: summary=${p.summary}, start_time=${p.start_time} -> ts=${startTs}, end_time=${p.end_time} -> ts=${endTs}, user_open_id=${p.user_open_id ?? 'MISSING'}, attendees=${JSON.stringify(p.attendees ?? [])}, vchat=${p.vchat?.vc_type ?? 'auto'}, location=${p.location?.name ?? 'none'}`,
              );

              // Resolve bot's calendar
              const calendarId = await resolveCalendarIdOrFail(p.calendar_id, client);

              const eventData: any = {
                summary: p.summary,
                start_time: { timestamp: startTs },
                end_time: { timestamp: endTs },
                need_notification: true,
                attendee_ability: p.attendee_ability ?? 'can_modify_event',
              };
              if (p.description) eventData.description = p.description;

              // 视频会议配置
              if (p.vchat) {
                eventData.vchat = {};
                if (p.vchat.vc_type) eventData.vchat.vc_type = p.vchat.vc_type;
                if (p.vchat.icon_type) eventData.vchat.icon_type = p.vchat.icon_type;
                if (p.vchat.description) eventData.vchat.description = p.vchat.description;
                if (p.vchat.meeting_url) eventData.vchat.meeting_url = p.vchat.meeting_url;
              }

              // 公开范围
              if (p.visibility) eventData.visibility = p.visibility;

              // 忙闲状态
              if (p.free_busy_status) eventData.free_busy_status = p.free_busy_status;

              // 地点信息
              if (p.location) {
                eventData.location = {};
                if (p.location.name) eventData.location.name = p.location.name;
                if (p.location.address) eventData.location.address = p.location.address;
                if (p.location.latitude !== undefined) eventData.location.latitude = p.location.latitude;
                if (p.location.longitude !== undefined) eventData.location.longitude = p.location.longitude;
              }

              // 提醒列表
              if (p.reminders) {
                eventData.reminders = p.reminders.map((r) => ({ minutes: r.minutes }));
              }

              // 重复规则
              if (p.recurrence) eventData.recurrence = p.recurrence;

              const res = await client.invoke(
                'feishu_calendar_event.create',
                (sdk, opts) =>
                  sdk.calendar.calendarEvent.create(
                    {
                      path: { calendar_id: calendarId },
                      data: eventData,
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);
              log.info(`event created: event_id=${res.data?.event?.event_id}`);

              // Build attendee list: merge explicit attendees + user_open_id
              const allAttendees: Array<{ type: string; id: string }> = [...(p.attendees ?? [])];
              if (p.user_open_id) {
                const alreadyIncluded = allAttendees.some((a) => a.type === 'user' && a.id === p.user_open_id);
                if (!alreadyIncluded) {
                  allAttendees.push({ type: 'user', id: p.user_open_id });
                }
              }

              log.info(`allAttendees=${JSON.stringify(allAttendees)}`);
              let attendeeError: string | undefined;

              const operateId = p.user_open_id ?? p.attendees?.find((a) => a.type === 'user')?.id;

              if (allAttendees.length > 0 && res.data?.event?.event_id) {
                const attendeeData = allAttendees.map((a) => ({
                  type: a.type as 'user' | 'chat' | 'resource' | 'third_party',
                  user_id: a.type === 'user' ? a.id : undefined,
                  chat_id: a.type === 'chat' ? a.id : undefined,
                  room_id: a.type === 'resource' ? a.id : undefined,
                  third_party_email: a.type === 'third_party' ? a.id : undefined,
                  operate_id: operateId,
                }));

                try {
                  const attendeeRes = await client.invoke(
                    'feishu_calendar_event.create',
                    (sdk, opts) =>
                      sdk.calendar.calendarEventAttendee.create(
                        {
                          path: {
                            calendar_id: calendarId,
                            event_id: res.data?.event?.event_id!,
                          },
                          params: { user_id_type: 'open_id' as any },
                          data: {
                            attendees: attendeeData,
                            need_notification: true,
                          },
                        },
                        opts,
                      ),
                    { as: 'user' },
                  );
                  assertLarkOk(attendeeRes);
                  log.info(`attendee API response: ${JSON.stringify(attendeeRes.data)}`);
                } catch (attendeeErr) {
                  attendeeError = formatLarkError(attendeeErr);
                  log.info(`attendee add FAILED: ${attendeeError}`);
                }
              }

              // Strip calendarId from app_link — it points to bot's calendar, users can't access it
              const appLink = (res.data?.event as any)?.app_link as string | undefined;

              const safeEvent = res.data?.event
                ? {
                    event_id: res.data.event.event_id,
                    summary: res.data.event.summary,
                    app_link: appLink,
                    start_time: unixTimestampToISO8601(startTs) ?? p.start_time,
                    end_time: unixTimestampToISO8601(endTs) ?? p.end_time,
                  }
                : undefined;

              const result: any = {
                event: safeEvent,
                attendees: allAttendees.map((a) => ({
                  type: a.type,
                  id: a.id,
                })),
                _debug: {
                  calendar_id: calendarId,
                  operate_id: operateId,
                  start_input: p.start_time,
                  start_iso8601: unixTimestampToISO8601(startTs) ?? p.start_time,
                  end_input: p.end_time,
                  end_iso8601: unixTimestampToISO8601(endTs) ?? p.end_time,
                  attendees_count: allAttendees.length,
                },
              };
              if (attendeeError) {
                result.warning = `日程已创建，但添加参会人失败：${attendeeError}`;
              } else if (allAttendees.length === 0) {
                result.error =
                  '日程已创建在应用日历上，但未添加任何参会人，用户看不到此日程。请重新调用时传入 user_open_id 参数。';
              } else {
                result.note = `已成功添加 ${allAttendees.length} 位参会人，日程应出现在参会人的飞书日历中。`;
              }
              return json(result);
            }

            // -----------------------------------------------------------------
            // LIST EVENTS (使用 instance_view 接口，自动展开重复日程)
            // -----------------------------------------------------------------
            case 'list': {
              if (!p.start_time) return json({ error: 'start_time is required' });
              if (!p.end_time) return json({ error: 'end_time is required' });

              const startTs = parseTimeToTimestamp(p.start_time);
              const endTs = parseTimeToTimestamp(p.end_time);
              if (!startTs || !endTs)
                return json({
                  error:
                    "Invalid time format. Must use ISO 8601 / RFC 3339 with timezone, e.g. '2024-01-01T00:00:00+08:00' or '2026-02-25 14:00:00'. Do not pass Unix timestamps.",
                  received_start: p.start_time,
                  received_end: p.end_time,
                });

              const calendarId = await resolveCalendarIdOrFail(p.calendar_id, client);

              log.info(
                `list: calendar_id=${calendarId}, start_time=${startTs}, end_time=${endTs} (using instance_view)`,
              );

              const res = await client.invoke(
                'feishu_calendar_event.instance_view',
                (sdk, opts) =>
                  sdk.calendar.calendarEvent.instanceView(
                    {
                      path: { calendar_id: calendarId },
                      params: {
                        start_time: startTs,
                        end_time: endTs,
                        user_id_type: 'open_id' as any,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              const data = res.data as PaginatedData | undefined;
              log.info(`list: returned ${data?.items?.length ?? 0} event instances`);

              return json({
                events: normalizeEventListTimeFields(data?.items as Array<Record<string, any>> | undefined),
                has_more: data?.has_more ?? false,
                page_token: data?.page_token,
              });
            }

            // -----------------------------------------------------------------
            // GET EVENT
            // -----------------------------------------------------------------
            case 'get': {
              if (!p.event_id) return json({ error: 'event_id is required' });

              const calendarId = await resolveCalendarIdOrFail(p.calendar_id, client);

              log.info(`get: calendar_id=${calendarId}, event_id=${p.event_id}`);

              const res = await client.invoke(
                'feishu_calendar_event.get',
                (sdk, opts) =>
                  sdk.calendar.calendarEvent.get(
                    {
                      path: { calendar_id: calendarId, event_id: p.event_id },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`get: retrieved event ${p.event_id}`);

              return json({
                event: normalizeEventTimeFields(res.data?.event as Record<string, any> | undefined),
              });
            }

            // -----------------------------------------------------------------
            // PATCH EVENT (P1)
            // -----------------------------------------------------------------
            case 'patch': {
              if (!p.event_id) return json({ error: 'event_id is required' });

              const calendarId = await resolveCalendarIdOrFail(p.calendar_id, client);

              const updateData: any = {};

              // Handle time conversion if provided
              if (p.start_time) {
                const startTs = parseTimeToTimestamp(p.start_time);
                if (!startTs)
                  return json({
                    error:
                      "start_time 格式错误！必须使用ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'",
                    received: p.start_time,
                  });
                updateData.start_time = { timestamp: startTs };
              }

              if (p.end_time) {
                const endTs = parseTimeToTimestamp(p.end_time);
                if (!endTs)
                  return json({
                    error:
                      "end_time 格式错误！必须使用ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'",
                    received: p.end_time,
                  });
                updateData.end_time = { timestamp: endTs };
              }

              if (p.summary) updateData.summary = p.summary;
              if (p.description) updateData.description = p.description;
              if (p.location) updateData.location = { name: p.location };

              log.info(
                `patch: calendar_id=${calendarId}, event_id=${p.event_id}, fields=${Object.keys(updateData).join(',')}`,
              );

              const res = await client.invoke(
                'feishu_calendar_event.patch',
                (sdk, opts) =>
                  sdk.calendar.calendarEvent.patch(
                    {
                      path: { calendar_id: calendarId, event_id: p.event_id },
                      data: updateData,
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`patch: updated event ${p.event_id}`);

              return json({
                event: normalizeEventTimeFields(res.data?.event as Record<string, any> | undefined),
              });
            }

            // -----------------------------------------------------------------
            // DELETE EVENT (P1)
            // -----------------------------------------------------------------
            case 'delete': {
              if (!p.event_id) return json({ error: 'event_id is required' });

              const calendarId = await resolveCalendarIdOrFail(p.calendar_id, client);

              log.info(
                `delete: calendar_id=${calendarId}, event_id=${p.event_id}, notify=${p.need_notification ?? true}`,
              );

              const res = await client.invoke(
                'feishu_calendar_event.delete',
                (sdk, opts) =>
                  sdk.calendar.calendarEvent.delete(
                    {
                      path: { calendar_id: calendarId, event_id: p.event_id },
                      params: {
                        need_notification: (p.need_notification ?? true) as any,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`delete: deleted event ${p.event_id}`);

              return json({
                success: true,
                event_id: p.event_id,
              });
            }

            // -----------------------------------------------------------------
            // SEARCH EVENT (P1)
            // -----------------------------------------------------------------
            case 'search': {
              if (!p.query) return json({ error: 'query is required' });

              const calendarId = await resolveCalendarIdOrFail(p.calendar_id, client);

              log.info(`search: calendar_id=${calendarId}, query=${p.query}, page_size=${p.page_size ?? 50}`);

              const res = await client.invoke(
                'feishu_calendar_event.search',
                (sdk, opts) =>
                  sdk.calendar.calendarEvent.search(
                    {
                      path: { calendar_id: calendarId },
                      params: {
                        page_size: p.page_size,
                        page_token: p.page_token,
                      },
                      data: {
                        query: p.query,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              const data = res.data as PaginatedData | undefined;
              log.info(`search: found ${data?.items?.length ?? 0} events`);

              return json({
                events: normalizeEventListTimeFields(data?.items as Array<Record<string, any>> | undefined),
                has_more: data?.has_more ?? false,
                page_token: data?.page_token,
              });
            }

            // -----------------------------------------------------------------
            // REPLY EVENT (P1)
            // -----------------------------------------------------------------
            case 'reply': {
              if (!p.event_id) return json({ error: 'event_id is required' });
              if (!p.rsvp_status) return json({ error: 'rsvp_status is required' });

              const calendarId = await resolveCalendarIdOrFail(p.calendar_id, client);

              log.info(`reply: calendar_id=${calendarId}, event_id=${p.event_id}, rsvp=${p.rsvp_status}`);

              const res = await client.invoke(
                'feishu_calendar_event.reply',
                (sdk, opts) =>
                  sdk.calendar.calendarEvent.reply(
                    {
                      path: { calendar_id: calendarId, event_id: p.event_id },
                      data: {
                        rsvp_status: p.rsvp_status,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`reply: replied to event ${p.event_id} with ${p.rsvp_status}`);

              return json({
                success: true,
                event_id: p.event_id,
                rsvp_status: p.rsvp_status,
              });
            }

            // -----------------------------------------------------------------
            // INSTANCES (P1)
            // -----------------------------------------------------------------
            case 'instances': {
              if (!p.event_id) return json({ error: 'event_id is required' });
              if (!p.start_time) return json({ error: 'start_time is required' });
              if (!p.end_time) return json({ error: 'end_time is required' });

              const calendarId = await resolveCalendarIdOrFail(p.calendar_id, client);

              const startTs = parseTimeToTimestamp(p.start_time);
              const endTs = parseTimeToTimestamp(p.end_time);

              if (!startTs || !endTs)
                return json({
                  error:
                    "Invalid time format. Must use ISO 8601 / RFC 3339 with timezone, e.g. '2024-01-01T00:00:00+08:00'",
                  received_start: p.start_time,
                  received_end: p.end_time,
                });

              log.info(`instances: calendar_id=${calendarId}, event_id=${p.event_id}, start=${startTs}, end=${endTs}`);

              const res = await client.invoke(
                'feishu_calendar_event.instances',
                (sdk, opts) =>
                  sdk.calendar.calendarEvent.instances(
                    {
                      path: { calendar_id: calendarId, event_id: p.event_id },
                      params: {
                        start_time: startTs as any,
                        end_time: endTs as any,
                        page_size: p.page_size,
                        page_token: p.page_token,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              const data = res.data as PaginatedData | undefined;
              log.info(`instances: returned ${data?.items?.length ?? 0} instances`);

              return json({
                instances: normalizeEventListTimeFields(data?.items as Array<Record<string, any>> | undefined),
                has_more: data?.has_more ?? false,
                page_token: data?.page_token,
              });
            }

            // -----------------------------------------------------------------
            // INSTANCE_VIEW (P1)
            // -----------------------------------------------------------------
            case 'instance_view': {
              if (!p.start_time) return json({ error: 'start_time is required' });
              if (!p.end_time) return json({ error: 'end_time is required' });

              const calendarId = await resolveCalendarIdOrFail(p.calendar_id, client);

              const startTs = parseTimeToTimestamp(p.start_time);
              const endTs = parseTimeToTimestamp(p.end_time);

              if (!startTs || !endTs)
                return json({
                  error:
                    "Invalid time format. Must use ISO 8601 / RFC 3339 with timezone, e.g. '2024-01-01T00:00:00+08:00'",
                  received_start: p.start_time,
                  received_end: p.end_time,
                });

              log.info(`instance_view: calendar_id=${calendarId}, start=${startTs}, end=${endTs}`);

              const res = await client.invoke(
                'feishu_calendar_event.instance_view',
                (sdk, opts) =>
                  sdk.calendar.calendarEvent.instanceView(
                    {
                      path: { calendar_id: calendarId },
                      params: {
                        start_time: startTs,
                        end_time: endTs,
                        user_id_type: 'open_id' as any,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              const data = res.data as PaginatedData | undefined;
              log.info(`instance_view: returned ${data?.items?.length ?? 0} events`);

              return json({
                events: normalizeEventListTimeFields(data?.items as Array<Record<string, any>> | undefined),
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
    { name: 'feishu_calendar_event' },
  );

}
