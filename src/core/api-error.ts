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
 * Both paths intercept well-known codes (e.g. LARK_ERROR.APP_SCOPE_MISSING (99991672) — missing API scopes)
 * and produce user-friendly messages with actionable authorization links.
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

  const permMsg = formatPermissionError(res.code, res.msg ?? '');
  if (permMsg) throw new Error(permMsg);

  throw new Error(res.msg ?? `Feishu API error (code: ${res.code})`);
}

/**
 * Extract a meaningful error message from a thrown Lark SDK / Axios error.
 *
 * The Lark SDK throws Axios errors whose object carries Feishu-specific
 * fields (`code`, `msg`) alongside the standard `message`.  For permission
 * errors (LARK_ERROR.APP_SCOPE_MISSING (99991672)) we format a user-friendly string with scopes + auth URL.
 * For all other errors we try `err.msg` first (the Feishu detail) and fall
 * back to `err.message` (the generic Axios text).
 */
export function formatLarkError(err: unknown): string {
  if (!err || typeof err !== 'object') {
    return String(err);
  }
  const e = err as {
    code?: number;
    msg?: string;
    message?: string;
    response?: { data?: { code?: number; msg?: string } };
  };

  // Path 1: Lark SDK merges Feishu fields onto the thrown error object.
  if (typeof e.code === 'number' && e.msg) {
    const permMsg = formatPermissionError(e.code, e.msg);
    if (permMsg) return permMsg;
    return e.msg;
  }

  // Path 2: Standard Axios error — dig into response.data.
  const data = e.response?.data;
  if (data && typeof data.code === 'number' && data.msg) {
    const permMsg = formatPermissionError(data.code, data.msg);
    if (permMsg) return permMsg;
    return data.msg;
  }

  // Fallback.
  return e.message ?? String(err);
}
