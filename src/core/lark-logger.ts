/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Structured logger factory for the Feishu plugin.
 *
 * Wraps `PluginRuntime.logging.getChildLogger()` with automatic
 * LarkTicket injection from AsyncLocalStorage and a console fallback
 * when the runtime is not yet initialised.
 *
 * Usage:
 *   const log = larkLogger("card/streaming");
 *   log.info("created entity", { cardId, sequence });
 */

import type { RuntimeLogger } from 'openclaw/plugin-sdk';
import { LarkClient } from './lark-client';
import { getTicket } from './lark-ticket';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface LarkLogger {
  readonly subsystem: string;
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(name: string): LarkLogger;
}

// ---------------------------------------------------------------------------
// Console fallback (with ANSI colors)
// ---------------------------------------------------------------------------

// ANSI escape codes for colored console output
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const GRAY = '\x1b[90m';
const RESET = '\x1b[0m';

function consoleFallback(subsystem: string): RuntimeLogger {
  const tag = `feishu/${subsystem}`;
  /* eslint-disable no-console -- logger底层实现，console 是最终输出目标 */
  return {
    debug: (msg, meta) => console.debug(`${GRAY}[${tag}]${RESET}`, msg, ...(meta ? [meta] : [])),
    info: (msg, meta) => console.log(`${CYAN}[${tag}]${RESET}`, msg, ...(meta ? [meta] : [])),
    warn: (msg, meta) => console.warn(`${YELLOW}[${tag}]${RESET}`, msg, ...(meta ? [meta] : [])),
    error: (msg, meta) => console.error(`${RED}[${tag}]${RESET}`, msg, ...(meta ? [meta] : [])),
  };
  /* eslint-enable no-console */
}

// ---------------------------------------------------------------------------
// Lazy runtime resolution
// ---------------------------------------------------------------------------

function resolveRuntimeLogger(subsystem: string): RuntimeLogger | null {
  try {
    return LarkClient.runtime.logging.getChildLogger({
      subsystem: `feishu/${subsystem}`,
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// LarkTicket enrichment
// ---------------------------------------------------------------------------

function getTraceMeta(): Record<string, unknown> | null {
  const ctx = getTicket();
  if (!ctx) return null;
  const trace: Record<string, unknown> = {
    accountId: ctx.accountId,
    messageId: ctx.messageId,
    chatId: ctx.chatId,
  };
  if (ctx.senderOpenId) trace.senderOpenId = ctx.senderOpenId;
  return trace;
}

function enrichMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  const trace = getTraceMeta();
  if (!trace) return meta ?? {};
  return meta ? { ...trace, ...meta } : trace;
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

/**
 * Build a trace-aware prefix like `feishu[default][msg:om_xxx]:`.
 *
 * Mirrors the format used by `trace.ts` so log lines are consistent
 * across the old and new logging systems.
 */
function buildTracePrefix(): string {
  const ctx = getTicket();
  if (!ctx) return 'feishu:';
  return `feishu[${ctx.accountId}][msg:${ctx.messageId}]:`;
}

/**
 * Format message with inline meta for text-based log output.
 *
 * RuntimeLogger implementations typically ignore the `meta` parameter in
 * their text output (gateway.log / console).  To ensure meta is always
 * visible, we serialize user-supplied meta into the message string and
 * prepend the trace context prefix (accountId + messageId).
 *
 * Example:
 *   formatMessage("card.create response", { code: 0, cardId: "c_xxx" })
 *   → "feishu[default][msg:om_xxx]: card.create response (code=0, cardId=c_xxx)"
 */
function formatMessage(message: string, meta: Record<string, unknown> | undefined): string {
  const prefix = buildTracePrefix();
  if (!meta || Object.keys(meta).length === 0) return `${prefix} ${message}`;
  const parts = Object.entries(meta)
    .map(([k, v]) => {
      if (v === undefined || v === null) return null;
      if (typeof v === 'object') return `${k}=${JSON.stringify(v)}`;
      return `${k}=${v}`;
    })
    .filter(Boolean);
  return parts.length > 0 ? `${prefix} ${message} (${parts.join(', ')})` : `${prefix} ${message}`;
}

// ---------------------------------------------------------------------------
// LarkLogger implementation
// ---------------------------------------------------------------------------

function createLarkLogger(subsystem: string): LarkLogger {
  // RuntimeLogger is resolved lazily on first log call so that module-level
  // `larkLogger()` calls work even before `LarkClient.setRuntime()`.
  let cachedLogger: RuntimeLogger | null = null;
  let resolved = false;

  function getLogger(): RuntimeLogger {
    if (!resolved) {
      cachedLogger = resolveRuntimeLogger(subsystem);
      if (cachedLogger) resolved = true;
    }
    return cachedLogger ?? consoleFallback(subsystem);
  }

  return {
    subsystem,
    debug(message: string, meta?: Record<string, unknown>): void {
      getLogger().debug?.(formatMessage(message, meta), enrichMeta(meta));
    },
    info(message: string, meta?: Record<string, unknown>): void {
      getLogger().info(formatMessage(message, meta), enrichMeta(meta));
    },
    warn(message: string, meta?: Record<string, unknown>): void {
      getLogger().warn(formatMessage(message, meta), enrichMeta(meta));
    },
    error(message: string, meta?: Record<string, unknown>): void {
      getLogger().error(formatMessage(message, meta), enrichMeta(meta));
    },
    child(name: string): LarkLogger {
      return createLarkLogger(`${subsystem}/${name}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export function larkLogger(subsystem: string): LarkLogger {
  return createLarkLogger(subsystem);
}
