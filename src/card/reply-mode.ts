/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Pure functions for resolving the Feishu reply mode.
 *
 * Extracted from reply-dispatcher.ts to enable independent testing
 * and eliminate `as any` casts on FeishuConfig.
 */

import type { FeishuConfig } from '../core/types';
import { FEISHU_CARD_TABLE_LIMIT, findMarkdownTablesOutsideCodeBlocks } from './card-error';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ReplyModeValue = 'auto' | 'static' | 'streaming';

// ---------------------------------------------------------------------------
// resolveReplyMode
// ---------------------------------------------------------------------------

/**
 * Resolve the effective reply mode based on configuration and chat type.
 *
 * Priority: replyMode.{scene} > replyMode.default > replyMode (string) > "auto"
 */
export function resolveReplyMode(params: {
  feishuCfg: FeishuConfig | undefined;
  chatType?: 'p2p' | 'group';
}): ReplyModeValue {
  const { feishuCfg, chatType } = params;

  // streaming 布尔总开关：仅 true 时允许流式，未设置或 false 一律 static
  if (feishuCfg?.streaming !== true) return 'static';

  const replyMode = feishuCfg?.replyMode;
  if (!replyMode) return 'auto';

  if (typeof replyMode === 'string') return replyMode;

  // Object form: pick scene-specific value
  const sceneMode = chatType === 'group' ? replyMode.group : chatType === 'p2p' ? replyMode.direct : undefined;
  return sceneMode ?? replyMode.default ?? 'auto';
}

// ---------------------------------------------------------------------------
// expandAutoMode
// ---------------------------------------------------------------------------

/**
 * Expand "auto" mode to a concrete mode based on streaming flag and chat type.
 *
 * When streaming === true: group → static, direct → streaming (legacy behavior).
 * When streaming is unset: always static (new default).
 */
export function expandAutoMode(params: {
  mode: ReplyModeValue;
  streaming: boolean | undefined;
  chatType?: 'p2p' | 'group';
}): 'static' | 'streaming' {
  const { mode, streaming, chatType } = params;
  if (mode !== 'auto') return mode;

  return streaming === true ? (chatType === 'group' ? 'static' : 'streaming') : 'static';
}

// ---------------------------------------------------------------------------
// shouldUseCard
// ---------------------------------------------------------------------------

/**
 * Detect whether the text contains markdown elements that benefit from
 * being rendered inside a Feishu interactive card (fenced code blocks or
 * markdown tables).
 */
export function shouldUseCard(text: string): boolean {
  // Markdown tables NO LONGER force a card. Feishu messages render markdown
  // tables natively, and wrapping a reply in a card breaks bot-at-bot @
  // delivery (cards have limited @ support). Only fenced code blocks still
  // benefit from card rendering.
  //
  // The table-count guard is kept as a safety valve: when a reply also
  // contains an excessive number of markdown tables, skip the card entirely
  // rather than risk a card-render failure.
  const tableMatches = findMarkdownTablesOutsideCodeBlocks(text);
  if (tableMatches.length > FEISHU_CARD_TABLE_LIMIT) {
    return false;
  }
  // Fenced code blocks
  if (/```[\s\S]*?```/.test(text)) {
    return true;
  }
  return false;
}
