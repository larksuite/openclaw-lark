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
// resolveStreamingFlags
// ---------------------------------------------------------------------------

/**
 * Normalise the streaming switches across config shapes.
 *
 * Legacy plugin shape: `streaming: true` + `blockStreaming: true`.
 * OpenClaw >=2026.8 doctor migrates those into the shared nested shape
 * `streaming: { mode: 'off'|'partial'|'block'|'progress', block: { enabled } }`.
 */
export function resolveStreamingFlags(feishuCfg: FeishuConfig | undefined): {
  streaming: boolean;
  blockStreaming: boolean;
} {
  const raw = feishuCfg?.streaming;
  const nested = raw && typeof raw === 'object' ? raw : undefined;
  // v2 加固：布尔 true → 流式；嵌套形态 → 除显式 mode 'off' 外均视为开启；
  // block.enabled 单独出现（doctor 迁移产物）也视为需要流式。
  const nestedStreaming = nested
    ? nested.mode !== undefined
      ? nested.mode !== 'off'
      : nested.block?.enabled === true
    : false;
  return {
    streaming: raw === true || nestedStreaming,
    blockStreaming: feishuCfg?.blockStreaming === true || nested?.block?.enabled === true,
  };
}

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

  // streaming 总开关：仅开启时允许流式，未设置或关闭一律 static
  if (!resolveStreamingFlags(feishuCfg).streaming) return 'static';

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
 * scope A: rich text now renders natively as post(`tag:md`); we never force a
 * card for code blocks OR tables anymore. Native rendering also keeps bot-at-bot
 * @ delivery working — wrapping a reply in a card breaks it (cards have limited
 * @ support). The only remaining card-path guard is the table-count hard limit,
 * retained for the runtime fallback in reply-dispatcher (card rejected by
 * Feishu → plain text).
 */
export function shouldUseCard(text: string): boolean {
  const tableMatches = findMarkdownTablesOutsideCodeBlocks(text);
  if (tableMatches.length > FEISHU_CARD_TABLE_LIMIT) {
    return false;
  }
  return false;
}
