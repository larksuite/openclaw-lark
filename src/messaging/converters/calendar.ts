/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Converters for calendar-related message types:
 * - share_calendar_event
 * - calendar
 * - general_calendar
 */

import type { ContentConverterFn } from './types';
import { safeParse, millisToDatetime } from './utils';

interface CalendarBody {
  summary?: string;
  start_time?: string;
  end_time?: string;
}

function formatCalendarContent(parsed: CalendarBody | undefined): string {
  const summary = parsed?.summary ?? '';
  const parts: string[] = [];

  if (summary) {
    parts.push(`📅 ${summary}`);
  }

  const start = parsed?.start_time ? millisToDatetime(parsed.start_time) : '';
  const end = parsed?.end_time ? millisToDatetime(parsed.end_time) : '';
  if (start && end) {
    parts.push(`🕙 ${start} ~ ${end}`);
  } else if (start) {
    parts.push(`🕙 ${start}`);
  }

  return parts.join('\n') || '[calendar event]';
}

export const convertShareCalendarEvent: ContentConverterFn = (raw) => {
  const parsed = safeParse(raw) as CalendarBody | undefined;
  const inner = formatCalendarContent(parsed);

  return {
    content: `<calendar_share>${inner}</calendar_share>`,
    resources: [],
  };
};

export const convertCalendar: ContentConverterFn = (raw) => {
  const parsed = safeParse(raw) as CalendarBody | undefined;
  const inner = formatCalendarContent(parsed);

  return {
    content: `<calendar_invite>${inner}</calendar_invite>`,
    resources: [],
  };
};

export const convertGeneralCalendar: ContentConverterFn = (raw) => {
  const parsed = safeParse(raw) as CalendarBody | undefined;
  const inner = formatCalendarContent(parsed);

  return {
    content: `<calendar>${inner}</calendar>`,
    resources: [],
  };
};
