/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Permission error extraction and cooldown tracking for Feishu API calls.
 *
 * Extracted from bot.ts: PermissionError type, extractPermissionError,
 * PERMISSION_ERROR_COOLDOWN_MS, permissionErrorNotifiedAt.
 */

import { extractPermissionGrantUrl } from '../../core/permission-url';
import { LARK_ERROR } from '../../core/auth-errors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PermissionError {
  code: number;
  message: string;
  grantUrl?: string;
}

// ---------------------------------------------------------------------------
// Permission error extraction
// ---------------------------------------------------------------------------

export function extractPermissionError(err: unknown): PermissionError | null {
  if (!err || typeof err !== 'object') {
    return null;
  }

  const axiosErr = err as { response?: { data?: unknown } };
  const data = axiosErr.response?.data;
  if (!data || typeof data !== 'object') {
    return null;
  }

  const feishuErr = data as {
    code?: number;
    msg?: string;
    error?: { permission_violations?: Array<{ uri?: string }> };
  };

  // Feishu permission error code
  if (feishuErr.code !== LARK_ERROR.APP_SCOPE_MISSING) {
    return null;
  }

  const msg = feishuErr.msg ?? '';
  const grantUrl = extractPermissionGrantUrl(msg);

  if (!grantUrl) {
    return null;
  }

  return { code: feishuErr.code, message: msg, grantUrl };
}

// ---------------------------------------------------------------------------
// Cooldown tracking
// ---------------------------------------------------------------------------

export const PERMISSION_ERROR_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
export const permissionErrorNotifiedAt = new Map<string, number>();
