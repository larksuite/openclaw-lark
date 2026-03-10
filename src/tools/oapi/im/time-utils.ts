/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * 时间工具函数 — 对齐 Go 实现 (time.go + timerange.go)
 *
 * 以 ISO 8601 (RFC 3339) 作为标准时间交换格式，
 * 提供 ISO 8601 ↔ Unix 转换工具及时间范围解析。
 */

const BJ_OFFSET_MS = 8 * 60 * 60 * 1000;

// ===========================================================================
// ISO 8601 ↔ Unix 转换工具（对齐 time.go）
// ===========================================================================

/** 将 Date 格式化为北京时间 ISO 8601 字符串 */
function formatBeijingISO(d: Date): string {
  const bj = new Date(d.getTime() + BJ_OFFSET_MS);
  const y = bj.getUTCFullYear();
  const mo = String(bj.getUTCMonth() + 1).padStart(2, '0');
  const da = String(bj.getUTCDate()).padStart(2, '0');
  const h = String(bj.getUTCHours()).padStart(2, '0');
  const mi = String(bj.getUTCMinutes()).padStart(2, '0');
  const s = String(bj.getUTCSeconds()).padStart(2, '0');
  return `${y}-${mo}-${da}T${h}:${mi}:${s}+08:00`;
}

// ---------------------------------------------------------------------------
// Unix 秒 → ISO 8601
// ---------------------------------------------------------------------------

/** Unix 秒（数字）→ ISO 8601 北京时间 */
export function secondsToDateTime(seconds: number): string {
  return formatBeijingISO(new Date(seconds * 1000));
}

/** Unix 秒（字符串）→ ISO 8601 北京时间 */
export function secondsStringToDateTime(seconds: string): string {
  return secondsToDateTime(parseInt(seconds, 10));
}

// ---------------------------------------------------------------------------
// Unix 毫秒 → ISO 8601
// ---------------------------------------------------------------------------

/** Unix 毫秒（数字）→ ISO 8601 北京时间 */
export function millisToDateTime(millis: number): string {
  return formatBeijingISO(new Date(millis));
}

/** Unix 毫秒（字符串）→ ISO 8601 北京时间 */
export function millisStringToDateTime(millis: string): string {
  return millisToDateTime(parseInt(millis, 10));
}

// ---------------------------------------------------------------------------
// ISO 8601 → Unix
// ---------------------------------------------------------------------------

/** ISO 8601 → Unix 秒（数字） */
export function dateTimeToSeconds(datetime: string): number {
  const d = new Date(datetime);
  if (isNaN(d.getTime())) {
    throw new Error(`无法解析 ISO 8601 时间: "${datetime}"。格式示例: 2026-02-27T14:30:00+08:00`);
  }
  return Math.floor(d.getTime() / 1000);
}

/** ISO 8601 → Unix 秒（字符串） */
export function dateTimeToSecondsString(datetime: string): string {
  return dateTimeToSeconds(datetime).toString();
}

/** ISO 8601 → Unix 毫秒（数字） */
export function dateTimeToMillis(datetime: string): number {
  const d = new Date(datetime);
  if (isNaN(d.getTime())) {
    throw new Error(`无法解析 ISO 8601 时间: "${datetime}"。格式示例: 2026-02-27T14:30:00+08:00`);
  }
  return d.getTime();
}

// ===========================================================================
// 时间范围解析（对齐 timerange.go）
// ===========================================================================

/** ISO 8601 时间范围 */
export interface TimeRange {
  start: string;
  end: string;
}

/**
 * 解析时间范围标识，返回 ISO 8601 字符串对。
 *
 * 支持的格式：
 * - `today` / `yesterday` / `day_before_yesterday`
 * - `this_week` / `last_week` / `this_month` / `last_month`
 * - `last_{N}_{unit}` — unit: minutes / hours / days
 *
 * 所有计算基于北京时间 (UTC+8)。
 */
export function parseTimeRange(input: string): TimeRange {
  const now = new Date();
  const bjNow = toBeijingDate(now);

  let start: Date;
  let end: Date;

  switch (input) {
    case 'today':
      start = beijingStartOfDay(bjNow);
      end = now;
      break;

    case 'yesterday': {
      const d = new Date(bjNow);
      d.setUTCDate(d.getUTCDate() - 1);
      start = beijingStartOfDay(d);
      end = beijingEndOfDay(d);
      break;
    }

    case 'day_before_yesterday': {
      const d = new Date(bjNow);
      d.setUTCDate(d.getUTCDate() - 2);
      start = beijingStartOfDay(d);
      end = beijingEndOfDay(d);
      break;
    }

    case 'this_week': {
      const day = bjNow.getUTCDay(); // 0=Sun .. 6=Sat
      const diffToMon = day === 0 ? 6 : day - 1;
      const monday = new Date(bjNow);
      monday.setUTCDate(monday.getUTCDate() - diffToMon);
      start = beijingStartOfDay(monday);
      end = now;
      break;
    }

    case 'last_week': {
      const day = bjNow.getUTCDay();
      const diffToMon = day === 0 ? 6 : day - 1;
      const thisMonday = new Date(bjNow);
      thisMonday.setUTCDate(thisMonday.getUTCDate() - diffToMon);
      const lastMonday = new Date(thisMonday);
      lastMonday.setUTCDate(lastMonday.getUTCDate() - 7);
      const lastSunday = new Date(thisMonday);
      lastSunday.setUTCDate(lastSunday.getUTCDate() - 1);
      start = beijingStartOfDay(lastMonday);
      end = beijingEndOfDay(lastSunday);
      break;
    }

    case 'this_month': {
      const firstDay = new Date(Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), 1));
      start = beijingStartOfDay(firstDay);
      end = now;
      break;
    }

    case 'last_month': {
      const firstDayThisMonth = new Date(Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), 1));
      const lastDayPrevMonth = new Date(firstDayThisMonth);
      lastDayPrevMonth.setUTCDate(lastDayPrevMonth.getUTCDate() - 1);
      const firstDayPrevMonth = new Date(
        Date.UTC(lastDayPrevMonth.getUTCFullYear(), lastDayPrevMonth.getUTCMonth(), 1),
      );
      start = beijingStartOfDay(firstDayPrevMonth);
      end = beijingEndOfDay(lastDayPrevMonth);
      break;
    }

    default: {
      // last_{N}_{unit} — 只支持 minutes / hours / days（对齐 Go）
      const match = input.match(/^last_(\d+)_(minutes?|hours?|days?)$/);
      if (!match) {
        throw new Error(
          `不支持的 relative_time 格式: "${input}"。` +
            '支持: today, yesterday, day_before_yesterday, this_week, last_week, this_month, last_month, last_{N}_{unit}（unit: minutes/hours/days）',
        );
      }
      const n = parseInt(match[1], 10);
      const unit = match[2].replace(/s$/, ''); // normalize plural
      start = subtractFromNow(now, n, unit);
      end = now;
      break;
    }
  }

  return {
    start: formatBeijingISO(start),
    end: formatBeijingISO(end),
  };
}

/**
 * 解析时间范围标识，返回 Unix 秒字符串对（供 SDK 调用）。
 */
export function parseTimeRangeToSeconds(input: string): { start: string; end: string } {
  const range = parseTimeRange(input);
  return {
    start: dateTimeToSecondsString(range.start),
    end: dateTimeToSecondsString(range.end),
  };
}

// ===========================================================================
// Internal helpers
// ===========================================================================

/** 将 UTC Date 转为「北京时间各部分存在 UTC 字段上」的 Date */
function toBeijingDate(d: Date): Date {
  return new Date(d.getTime() + BJ_OFFSET_MS);
}

/** 北京时间当天 00:00:00 对应的真实 UTC Date */
function beijingStartOfDay(bjDate: Date): Date {
  return new Date(Date.UTC(bjDate.getUTCFullYear(), bjDate.getUTCMonth(), bjDate.getUTCDate()) - BJ_OFFSET_MS);
}

/** 北京时间当天 23:59:59 对应的真实 UTC Date */
function beijingEndOfDay(bjDate: Date): Date {
  return new Date(
    Date.UTC(bjDate.getUTCFullYear(), bjDate.getUTCMonth(), bjDate.getUTCDate(), 23, 59, 59) - BJ_OFFSET_MS,
  );
}

function subtractFromNow(now: Date, n: number, unit: string): Date {
  const d = new Date(now);
  switch (unit) {
    case 'minute':
      d.setMinutes(d.getMinutes() - n);
      break;
    case 'hour':
      d.setHours(d.getHours() - n);
      break;
    case 'day':
      d.setDate(d.getDate() - n);
      break;
    default:
      throw new Error(`不支持的时间单位: ${unit}`);
  }
  return d;
}
