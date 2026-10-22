/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Shared Lark API error handling utilities.
 *
 * Provides unified error handling for two distinct error paths:
 *
 * 1. **Response-level errors** — The SDK returns a response object with a
 *    non-zero `code`.  Handled by {@link assertLarkOk}.
 *
 * 2. **Thrown exceptions** — The SDK throws an Axios-style error (HTTP 4xx)
 *    whose properties include the Feishu error `code` and `msg`.
 *    Handled by {@link formatLarkError}.
 *
 * Both paths intercept well-known codes (e.g. LARK_ERROR.APP_SCOPE_MISSING (99991672) — missing API scopes;
 * LARK_ERROR.ACCESS_CONTROL_DENIED (21001) — access-control policy denial) and produce actionable diagnostics.
 */

import { extractPermissionGrantUrl, extractPermissionScopes } from './permission-url';
import { LARK_ERROR } from './auth-errors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Given a Feishu error code and msg, format a user-friendly permission
 * error string if the code is LARK_ERROR.APP_SCOPE_MISSING (99991672).  Returns `null` for other codes.
 */
function formatPermissionError(code: number, msg: string): string | null {
  if (code !== LARK_ERROR.APP_SCOPE_MISSING) return null;

  const authUrl = extractPermissionGrantUrl(msg);
  const scopes = extractPermissionScopes(msg);

  return `权限不足：应用缺少 [${scopes}] 权限。\n` + `请管理员点击以下链接申请并开通权限：\n${authUrl}`;
}

function formatAccessControlError(code: number, msg: string): string | null {
  if (code !== LARK_ERROR.ACCESS_CONTROL_DENIED) return null;

  const hint =
    'Lark denied this request by an access-control policy. Ask the tenant/app administrator to review the policy; this response alone does not establish that the app ID or secret is invalid.';
  return msg ? `${msg}\n${hint}` : hint;
}

function formatKnownLarkError(code: number, msg: string): string | null {
  return formatPermissionError(code, msg) ?? formatAccessControlError(code, msg);
}

// ---------------------------------------------------------------------------
// Code extraction
// ---------------------------------------------------------------------------

function coerceCode(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function formatResponseDiagnostics(err: unknown): string {
  if (!err || typeof err !== 'object') return '';

  const e = err as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown; headers?: unknown };
  };
  const response = e.response;
  const status = coerceCode(response?.status) ?? coerceCode(e.status) ?? coerceCode(e.statusCode);
  const parts: string[] = [];
  if (status !== undefined && status > 0) parts.push(`HTTP ${status}`);

  const headers = response?.headers;
  if (headers && typeof headers === 'object') {
    const headerBag = headers as { get?: (name: string) => unknown };
    let logId = typeof headerBag.get === 'function' ? headerBag.get('x-tt-logid') : undefined;
    if (logId === undefined) {
      const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === 'x-tt-logid');
      logId = entry?.[1];
    }
    if (typeof logId === 'string' && logId.trim()) {
      parts.push(
        `x-tt-logid=${logId
          .trim()
          .replace(/[\r\n]/g, ' ')
          .slice(0, 128)}`,
      );
    }
  }

  return parts.length > 0 ? ` [${parts.join('; ')}]` : '';
}

/**
 * 从 Lark SDK 抛错对象中提取飞书 API code。
 *
 * 支持三种常见结构：
 * - `{ code }` — SDK 直接挂载
 * - `{ data: { code } }` — 响应体嵌套
 * - `{ response: { data: { code } } }` — Axios 风格
 */
export function extractLarkApiCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;

  const e = err as {
    code?: unknown;
    data?: { code?: unknown };
    response?: { data?: { code?: unknown } };
  };

  return coerceCode(e.code) ?? coerceCode(e.data?.code) ?? coerceCode(e.response?.data?.code);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assert that a Lark SDK response is successful (code === 0).
 *
 * For permission errors (code LARK_ERROR.APP_SCOPE_MISSING (99991672)), the thrown error includes the
 * required scope names and a direct authorization URL so the AI can
 * present it to the end user.
 */
export function assertLarkOk(res: { code?: number; msg?: string }): void {
  if (!res.code || res.code === 0) return;

  const formattedMsg = formatKnownLarkError(res.code, res.msg ?? '');
  if (formattedMsg) throw new Error(formattedMsg);

  throw new Error(res.msg ?? `Feishu API error (code: ${res.code})`);
}

/**
 * Extract a meaningful error message from a thrown Lark SDK / Axios error.
 *
 * The Lark SDK throws Axios errors whose object carries Feishu-specific
 * fields (`code`, `msg`) alongside the standard `message`.  For permission
 * errors (LARK_ERROR.APP_SCOPE_MISSING (99991672)) we format a user-friendly string with scopes + auth URL;
 * code 21001 gets access-control guidance. Available HTTP status and `x-tt-logid`
 * response metadata are appended. For other errors we try `err.msg` first (the Feishu detail) and fall
 * back to `err.message` (the generic Axios text).
 */
export function formatLarkError(err: unknown): string {
  if (!err || typeof err !== 'object') {
    return String(err);
  }
  const e = err as {
    code?: unknown;
    msg?: string;
    message?: string;
    response?: { data?: { code?: unknown; msg?: string } };
  };
  const diagnostics = formatResponseDiagnostics(err);

  // Path 1: Lark SDK merges Feishu fields onto the thrown error object.
  const code = coerceCode(e.code);
  if (code !== undefined && e.msg) {
    const formattedMsg = formatKnownLarkError(code, e.msg);
    if (formattedMsg) return `${formattedMsg}${diagnostics}`;
    return `${e.msg}${diagnostics}`;
  }

  // Path 2: Standard Axios error — dig into response.data.
  const data = e.response?.data;
  const responseCode = data ? coerceCode(data.code) : undefined;
  if (data && responseCode !== undefined && data.msg) {
    const formattedMsg = formatKnownLarkError(responseCode, data.msg);
    if (formattedMsg) return `${formattedMsg}${diagnostics}`;
    return `${data.msg}${diagnostics}`;
  }

  // Fallback.
  return `${e.message ?? String(err)}${diagnostics}`;
}
