/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Abort trigger detection for the Lark/Feishu channel plugin.
 *
 * Provides a fast-path check to determine whether an inbound message is
 * an abort/stop command *before* it enters the per-chat serial queue.
 *
 * The trigger word list and normalisation logic are copied from the
 * OpenClaw core (`src/auto-reply/reply/abort.ts`) so the plugin can
 * make a lightweight decision without importing the full reply pipeline.
 * The message still flows through `tryFastAbortFromMessage()` for
 * authoritative handling.
 */

import type { FeishuMessageEvent } from '../messaging/types';

// ---------------------------------------------------------------------------
// Trigger word list (synced with OpenClaw core abort.ts)
// ---------------------------------------------------------------------------

const ABORT_TRIGGERS = new Set([
  'stop',
  'esc',
  'abort',
  'wait',
  'exit',
  'interrupt',
  'detente',
  'deten',
  'detén',
  'arrete',
  'arrête',
  '停止',
  'やめて',
  '止めて',
  'रुको',
  'توقف',
  'стоп',
  'остановись',
  'останови',
  'остановить',
  'прекрати',
  'halt',
  'anhalten',
  'aufhören',
  'hoer auf',
  'stopp',
  'pare',
  'stop openclaw',
  'openclaw stop',
  'stop action',
  'stop current action',
  'stop run',
  'stop current run',
  'stop agent',
  'stop the agent',
  "stop don't do anything",
  'stop dont do anything',
  'stop do not do anything',
  'stop doing anything',
  'do not do that',
  'please stop',
  'stop please',
]);

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

const TRAILING_ABORT_PUNCTUATION_RE = /[.!?…,，。;；:：'"'")\]}]+$/u;

function normalizeAbortTriggerText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/['`]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(TRAILING_ABORT_PUNCTUATION_RE, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Exact trigger-word match (same logic as OpenClaw core `isAbortTrigger`). */
export function isAbortTrigger(text: string): boolean {
  if (!text) return false;
  const normalized = normalizeAbortTriggerText(text);
  return ABORT_TRIGGERS.has(normalized);
}

/**
 * Extended abort detection: matches both bare trigger words and the
 * `/stop` command form.  Used by the monitor fast-path.
 */
export function isLikelyAbortText(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim().toLowerCase();
  if (trimmed === '/stop') return true;
  return isAbortTrigger(trimmed);
}

/**
 * Extract the raw text payload from a Feishu message event.
 *
 * Only handles `text` type messages.  The `message.content` field is a
 * JSON string like `{"text":"hello"}`.  Returns `undefined` for
 * non-text messages or parse failures.
 *
 * In group chats, bot mention placeholders (`@_user_N`) are stripped so
 * a message like `@Bot stop` is detected as `stop`.
 */
export function extractRawTextFromEvent(event: FeishuMessageEvent): string | undefined {
  if (!event.message || event.message.message_type !== 'text') {
    return undefined;
  }

  try {
    const parsed = JSON.parse(event.message.content);
    let text: string | undefined = parsed?.text;
    if (typeof text !== 'string') return undefined;

    // Strip bot mention placeholders (@_user_1, @_user_2, etc.)
    text = text.replace(/@_user_\d+/g, '').trim();

    return text || undefined;
  } catch {
    return undefined;
  }
}
