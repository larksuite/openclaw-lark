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

// ---------------------------------------------------------------------------
// Conversation stop-intent (broader than the exact abort triggers)
// ---------------------------------------------------------------------------

/**
 * Conversational "please stop / interrupt this exchange" phrases.
 *
 * Deliberately SEPARATE from {@link ABORT_TRIGGERS} (which is synced word-for-
 * word with OpenClaw core and matched by exact equality, e.g. `/stop`). These
 * are matched by substring so natural phrasings like "中断对话" or "stop
 * talking" are caught. The list is intentionally distinctive to avoid false
 * positives — a false positive only means we skip the deterministic peer-@
 * backstop for that turn (the model can still @ on its own), which is mild.
 */
const STOP_INTENT_PHRASES = [
  // zh
  '中断',
  '中止',
  '停止',
  '停下',
  '停一下',
  '暂停',
  '别聊了',
  '别说了',
  '别回复',
  '不要回复',
  '结束对话',
  '结束讨论',
  '闭嘴',
  // en
  'stop talking',
  'stop chatting',
  'stop the conversation',
  'stop this conversation',
  'end the conversation',
  'end conversation',
  'shut up',
  'be quiet',
  'cut it out',
  'knock it off',
  'wrap it up',
];

/**
 * Whether an inbound message expresses intent to stop / interrupt the ongoing
 * (bot-to-bot) exchange. Superset of {@link isLikelyAbortText} plus the
 * conversational phrases above.
 *
 * Used to suppress the deterministic peer-@ backstop: when a human asks the
 * bots to stop, the acknowledgement must NOT @ the peer bot, or the forced @
 * would re-wake it and defeat the interruption.
 */
export function isConversationStopIntent(text: string): boolean {
  if (!text) return false;
  // Drop bot mention placeholders so "@Bot 中断对话" → "中断对话".
  const normalized = text.replace(/@_user_\d+/g, '').trim().toLowerCase();
  if (!normalized) return false;
  if (isLikelyAbortText(normalized)) return true;
  return STOP_INTENT_PHRASES.some((p) => normalized.includes(p));
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
