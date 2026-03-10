/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * OAPI 工具专用辅助函数
 *
 * 提供 OAPI 工具特有的功能（如时间转换），并复用通用辅助函数。
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import type { Client as LarkClient } from '@larksuiteoapi/node-sdk';

// ---------------------------------------------------------------------------
// 通用功能（从 tools/helpers.ts 导入）
// ---------------------------------------------------------------------------

export {
  formatToolResult,
  formatToolError,
  createToolLogger,
  createClientGetter,
  createToolContext,
  getFirstAccount,
  validateRequiredParams,
  validateEnum,
} from '../helpers';

export type { ToolResult, ClientGetter, ToolContext } from '../helpers';

// ---------------------------------------------------------------------------
// ToolClient（工具层统一客户端）
// ---------------------------------------------------------------------------

export {
  ToolClient,
  createToolClient,
  NeedAuthorizationError,
  AppScopeMissingError,
  UserAuthRequiredError,
  UserScopeInsufficientError,
} from '../../core/tool-client';
export type {
  ApiFn,
  InvokeFn,
  InvokeOptions,
  InvokeByPathOptions,
  AuthHint,
  TryInvokeResult,
} from '../../core/tool-client';

// ---------------------------------------------------------------------------
// OAPI 专用：客户端便捷创建
// ---------------------------------------------------------------------------

import { createClientGetter } from '../helpers';

/**
 * 从配置直接创建飞书客户端（OAPI 工具常用模式）
 *
 * 这是对 createClientGetter 的简化封装，直接返回客户端实例而非 getter 函数。
 *
 * @param config - OpenClaw 配置对象
 * @returns 飞书 SDK 客户端实例
 * @throws 如果没有启用的账号
 *
 * @example
 * ```typescript
 * export function registerMyOapiTool(api: OpenClawPluginApi) {
 *   api.registerTool({
 *     name: "my_oapi_tool",
 *     async execute(_toolCallId, params) {
 *       const client = createFeishuClientFromConfig(api.config);
 *       const res = await client.calendar.calendarEvent.list({ ... });
 *       return json(res.data);
 *     }
 *   });
 * }
 * ```
 */
export function createFeishuClientFromConfig(config: ClawdbotConfig): LarkClient {
  const getClient = createClientGetter(config);
  return getClient();
}

// ---------------------------------------------------------------------------
// OAPI 专用：返回值格式化（简化版）
// ---------------------------------------------------------------------------

import { formatToolResult } from '../helpers';

/**
 * 格式化返回值为 JSON（OAPI 工具常用简化接口）
 *
 * 这是对 formatToolResult 的简化封装，函数名更短便于频繁使用。
 *
 * @param data - 要返回的数据
 * @returns 格式化的工具返回值
 *
 * @example
 * ```typescript
 * return json({ task: taskData });
 * return json({ error: "Invalid parameter" });
 * ```
 */
export function json(data: unknown) {
  return formatToolResult(data);
}

// ---------------------------------------------------------------------------
// OAPI 专用：时间转换工具
// ---------------------------------------------------------------------------

/**
 * 解析时间字符串为 Unix 时间戳（秒）
 *
 * 支持多种格式：
 * 1. ISO 8601 / RFC 3339（带时区）："2024-01-01T00:00:00+08:00"
 * 2. 不带时区的格式（默认为北京时间 UTC+8）：
 *    - "2026-02-25 14:30"
 *    - "2026-02-25 14:30:00"
 *    - "2026-02-25T14:30:00"
 *
 * @param input - 时间字符串
 * @returns Unix 时间戳字符串（秒），解析失败返回 null
 *
 * @example
 * ```typescript
 * parseTimeToTimestamp("2026-02-25T14:30:00+08:00")  // => "1740459000"
 * parseTimeToTimestamp("2026-02-25 14:30")           // => "1740459000" (默认北京时间)
 * parseTimeToTimestamp("2026-02-25T14:30:00")        // => "1740459000" (默认北京时间)
 * parseTimeToTimestamp("invalid")                    // => null
 * ```
 */
export function parseTimeToTimestamp(input: string): string | null {
  try {
    const trimmed = input.trim();

    // 检查是否包含时区信息（Z 或 +/- 偏移）
    const hasTimezone = /[Zz]$|[+-]\d{2}:\d{2}$/.test(trimmed);

    if (hasTimezone) {
      // 有时区信息，直接解析
      const date = new Date(trimmed);
      if (isNaN(date.getTime())) return null;
      return Math.floor(date.getTime() / 1000).toString();
    }

    // 没有时区信息，当作北京时间处理
    // 支持格式：YYYY-MM-DD HH:mm 或 YYYY-MM-DD HH:mm:ss 或 YYYY-MM-DDTHH:mm:ss
    const normalized = trimmed.replace('T', ' ');
    const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);

    if (!match) {
      // 尝试直接解析（可能是其他 ISO 8601 格式）
      const date = new Date(trimmed);
      if (isNaN(date.getTime())) return null;
      return Math.floor(date.getTime() / 1000).toString();
    }

    const [, year, month, day, hour, minute, second] = match;
    // 当作北京时间（UTC+8），转换为 UTC
    const utcDate = new Date(
      Date.UTC(
        parseInt(year),
        parseInt(month) - 1,
        parseInt(day),
        parseInt(hour) - 8, // 北京时间减去 8 小时得到 UTC
        parseInt(minute),
        parseInt(second ?? '0'),
      ),
    );

    return Math.floor(utcDate.getTime() / 1000).toString();
  } catch {
    return null;
  }
}

/**
 * 解析时间字符串为 Unix 时间戳（毫秒）
 *
 * 支持多种格式：
 * 1. ISO 8601 / RFC 3339（带时区）："2024-01-01T00:00:00+08:00"
 * 2. 不带时区的格式（默认为北京时间 UTC+8）：
 *    - "2026-02-25 14:30"
 *    - "2026-02-25 14:30:00"
 *    - "2026-02-25T14:30:00"
 *
 * @param input - 时间字符串
 * @returns Unix 时间戳字符串（毫秒），解析失败返回 null
 *
 * @example
 * ```typescript
 * parseTimeToTimestampMs("2026-02-25T14:30:00+08:00")  // => "1740459000000"
 * parseTimeToTimestampMs("2026-02-25 14:30")           // => "1740459000000" (默认北京时间)
 * parseTimeToTimestampMs("2026-02-25T14:30:00")        // => "1740459000000" (默认北京时间)
 * parseTimeToTimestampMs("invalid")                    // => null
 * ```
 */
export function parseTimeToTimestampMs(input: string): string | null {
  try {
    const trimmed = input.trim();

    // 检查是否包含时区信息（Z 或 +/- 偏移）
    const hasTimezone = /[Zz]$|[+-]\d{2}:\d{2}$/.test(trimmed);

    if (hasTimezone) {
      // 有时区信息，直接解析
      const date = new Date(trimmed);
      if (isNaN(date.getTime())) return null;
      return date.getTime().toString();
    }

    // 没有时区信息，当作北京时间处理
    // 支持格式：YYYY-MM-DD HH:mm 或 YYYY-MM-DD HH:mm:ss 或 YYYY-MM-DDTHH:mm:ss
    const normalized = trimmed.replace('T', ' ');
    const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);

    if (!match) {
      // 尝试直接解析（可能是其他 ISO 8601 格式）
      const date = new Date(trimmed);
      if (isNaN(date.getTime())) return null;
      return date.getTime().toString();
    }

    const [, year, month, day, hour, minute, second] = match;
    // 当作北京时间（UTC+8），转换为 UTC
    const utcDate = new Date(
      Date.UTC(
        parseInt(year),
        parseInt(month) - 1,
        parseInt(day),
        parseInt(hour) - 8, // 北京时间减去 8 小时得到 UTC
        parseInt(minute),
        parseInt(second ?? '0'),
      ),
    );

    return utcDate.getTime().toString();
  } catch {
    return null;
  }
}

/**
 * 解析时间字符串为 RFC 3339 格式（用于 freebusy API）
 *
 * 支持多种格式：
 * 1. ISO 8601 / RFC 3339（带时区）："2024-01-01T00:00:00+08:00" - 直接返回
 * 2. 不带时区的格式（默认为北京时间 UTC+8）：
 *    - "2026-02-25 14:30" - 转换为 "2026-02-25T14:30:00+08:00"
 *    - "2026-02-25 14:30:00" - 转换为 "2026-02-25T14:30:00+08:00"
 *    - "2026-02-25T14:30:00" - 转换为 "2026-02-25T14:30:00+08:00"
 *
 * @param input - 时间字符串
 * @returns RFC 3339 格式的时间字符串，解析失败返回 null
 *
 * @example
 * ```typescript
 * parseTimeToRFC3339("2026-02-25T14:30:00+08:00")  // => "2026-02-25T14:30:00+08:00"
 * parseTimeToRFC3339("2026-02-25 14:30")           // => "2026-02-25T14:30:00+08:00"
 * parseTimeToRFC3339("2026-02-25T14:30:00")        // => "2026-02-25T14:30:00+08:00"
 * ```
 */
export function parseTimeToRFC3339(input: string): string | null {
  try {
    const trimmed = input.trim();

    // 检查是否包含时区信息（Z 或 +/- 偏移）
    const hasTimezone = /[Zz]$|[+-]\d{2}:\d{2}$/.test(trimmed);

    if (hasTimezone) {
      // 有时区信息，验证后直接返回
      const date = new Date(trimmed);
      if (isNaN(date.getTime())) return null;
      return trimmed;
    }

    // 没有时区信息，当作北京时间处理，转换为 RFC 3339 格式
    // 支持格式：YYYY-MM-DD HH:mm 或 YYYY-MM-DD HH:mm:ss 或 YYYY-MM-DDTHH:mm:ss
    const normalized = trimmed.replace('T', ' ');
    const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);

    if (!match) {
      // 尝试直接解析（可能是其他 ISO 8601 格式）
      const date = new Date(trimmed);
      if (isNaN(date.getTime())) return null;
      // 如果能解析但没有时区，添加 +08:00
      return trimmed.includes('T') ? `${trimmed}+08:00` : trimmed;
    }

    const [, year, month, day, hour, minute, second] = match;
    const sec = second ?? '00';

    // 直接构造 RFC 3339 格式（北京时间 UTC+8）
    return `${year}-${month}-${day}T${hour}:${minute}:${sec}+08:00`;
  } catch {
    return null;
  }
}

/**
 * 转换时间范围对象（用于 search 等 API）
 *
 * 将包含 ISO 8601 格式时间字符串的时间范围转换为时间戳。
 *
 * @param timeRange - 时间范围对象，包含可选的 start 和 end 字段
 * @param unit - 时间戳单位，'s' 为秒，'ms' 为毫秒，默认为 's'
 * @returns 转换后的时间范围对象，包含数字类型的时间戳
 * @throws 如果时间格式错误
 *
 * @example
 * ```typescript
 * convertTimeRange({ start: "2026-02-25T14:00:00+08:00", end: "2026-02-25T18:00:00+08:00" })
 * // => { start: 1740459000, end: 1740473400 }
 *
 * convertTimeRange({ start: "2026-02-25T14:00:00+08:00" }, 'ms')
 * // => { start: 1740459000000 }
 * ```
 */
export function convertTimeRange(
  timeRange: { start?: string; end?: string } | undefined,
  unit: 's' | 'ms' = 's',
): { start?: number; end?: number } | undefined {
  if (!timeRange) return undefined;

  const result: { start?: number; end?: number } = {};
  const parseFn = unit === 'ms' ? parseTimeToTimestampMs : parseTimeToTimestamp;

  if (timeRange.start) {
    const ts = parseFn(timeRange.start);
    if (!ts) {
      throw new Error(
        `Invalid time format for start. Must use ISO 8601 / RFC 3339 with timezone, e.g. "2024-01-01T00:00:00+08:00". Received: ${timeRange.start}`,
      );
    }
    result.start = parseInt(ts, 10);
  }

  if (timeRange.end) {
    const ts = parseFn(timeRange.end);
    if (!ts) {
      throw new Error(
        `Invalid time format for end. Must use ISO 8601 / RFC 3339 with timezone, e.g. "2024-01-01T00:00:00+08:00". Received: ${timeRange.end}`,
      );
    }
    result.end = parseInt(ts, 10);
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

// ---------------------------------------------------------------------------
// OAPI 专用：Unix 时间戳 → ISO 8601 (上海时区)
// ---------------------------------------------------------------------------

export const SHANGHAI_UTC_OFFSET_HOURS = 8;
export const SHANGHAI_OFFSET_SUFFIX = '+08:00';

export function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Convert a Unix timestamp (seconds or milliseconds) to ISO 8601 string
 * in the Asia/Shanghai timezone.
 *
 * Auto-detects seconds vs milliseconds based on magnitude.
 *
 * @returns e.g. `"2026-02-25T14:30:00+08:00"`, or `null` on invalid input
 */
export function unixTimestampToISO8601(raw: string | number | undefined): string | null {
  if (raw === undefined || raw === null) return null;

  const text = typeof raw === 'number' ? String(raw) : String(raw).trim();
  if (!/^-?\d+$/.test(text)) return null;

  const num = Number(text);
  if (!Number.isFinite(num)) return null;

  const utcMs = Math.abs(num) >= 1e12 ? num : num * 1000;
  const beijingDate = new Date(utcMs + SHANGHAI_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  if (Number.isNaN(beijingDate.getTime())) return null;

  const year = beijingDate.getUTCFullYear();
  const month = pad2(beijingDate.getUTCMonth() + 1);
  const day = pad2(beijingDate.getUTCDate());
  const hour = pad2(beijingDate.getUTCHours());
  const minute = pad2(beijingDate.getUTCMinutes());
  const second = pad2(beijingDate.getUTCSeconds());

  return `${year}-${month}-${day}T${hour}:${minute}:${second}${SHANGHAI_OFFSET_SUFFIX}`;
}

// ---------------------------------------------------------------------------
// OAPI 专用：飞书 API 错误处理
// ---------------------------------------------------------------------------

/**
 * Re-export 飞书 API 错误处理函数
 *
 * 这些函数专门用于处理飞书 Open API 的响应和错误。
 */
export { assertLarkOk, formatLarkError } from '../../core/api-error';

// ---------------------------------------------------------------------------
// OAPI 专用：invoke() 错误判断
// ---------------------------------------------------------------------------

import { AppScopeMissingError, UserAuthRequiredError, UserScopeInsufficientError } from '../../core/tool-client';

/**
 * Check whether an error is a structured invoke-level auth/permission error.
 *
 * Useful in intermediate catch blocks that need to let auth errors bubble up
 * to the outer `handleInvokeErrorWithAutoAuth`.
 *
 * For "allow-to-fail" sub-operations, prefer `client.tryInvoke()` over
 * manual `isInvokeError` + throw.
 */
export function isInvokeError(err: unknown): boolean {
  return (
    err instanceof UserAuthRequiredError ||
    err instanceof AppScopeMissingError ||
    err instanceof UserScopeInsufficientError
  );
}

// ---------------------------------------------------------------------------
// 自动授权：handleInvokeErrorWithAutoAuth
// ---------------------------------------------------------------------------

export { handleInvokeErrorWithAutoAuth } from '../auto-auth';
