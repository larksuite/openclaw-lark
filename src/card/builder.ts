/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Interactive card building for Lark/Feishu.
 *
 * Provides utilities to construct Feishu Interactive Message Cards for
 * different agent response states (thinking, streaming, complete, confirm).
 */

import { optimizeMarkdownStyle } from './markdown-style';
import type { FooterSessionMetrics } from './reply-dispatcher-types';
import { EMPTY_TOOL_USE_PLACEHOLDER, type ToolUseDisplayStep } from './tool-use-display';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Element ID used for the streaming text area in cards. The CardKit
 * `cardElement.content()` API targets this element for typewriter-effect
 * streaming updates.
 */
export const STREAMING_ELEMENT_ID = 'streaming_content';
export const REASONING_ELEMENT_ID = 'reasoning_content';
const TOOL_USE_STEP_CONTENT_INDENT = '0px 0px 0px 22px';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CardElement {
  tag: string;
  [key: string]: unknown;
}

export interface FeishuCard {
  config: {
    wide_screen_mode: boolean;
    update_multi?: boolean;
    locales?: string[];
    summary?: { content: string };
  };
  header?: {
    title: { tag: 'plain_text'; content: string; i18n_content?: Record<string, string> };
    template: string;
  };
  elements: CardElement[];
}

export type CardState = 'thinking' | 'streaming' | 'complete' | 'confirm';

export interface ConfirmData {
  operationDescription: string;
  pendingOperationId: string;
  preview?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---- Reasoning text utilities ----
// Mirrors the logic in the framework's `splitTelegramReasoningText` and
// related helpers from `plugin-sdk/telegram/reasoning-lane-coordinator`.
// Those are not exported from the public plugin-sdk entry, so we replicate
// the same detection/splitting logic here.

const REASONING_PREFIX = 'Reasoning:\n';

/**
 * Split a payload text into optional `reasoningText` and `answerText`.
 *
 * Handles two formats produced by the framework:
 * 1. "Reasoning:\n_italic line_\n…" prefix (from `formatReasoningMessage`)
 * 2. `<think>…</think>` / `<thinking>…</thinking>` XML tags
 *
 * Equivalent to the framework's `splitTelegramReasoningText()`.
 */
export function splitReasoningText(text?: string): {
  reasoningText?: string;
  answerText?: string;
} {
  if (typeof text !== 'string' || !text.trim()) return {};

  const trimmed = text.trim();

  // Case 1: "Reasoning:\n..." prefix — the entire payload is reasoning
  if (trimmed.startsWith(REASONING_PREFIX) && trimmed.length > REASONING_PREFIX.length) {
    return { reasoningText: cleanReasoningPrefix(trimmed) };
  }

  // Case 2: XML thinking tags — extract content and strip from answer
  const taggedReasoning = extractThinkingContent(text);
  const strippedAnswer = stripReasoningTags(text);
  if (!taggedReasoning && strippedAnswer === text) {
    return { answerText: text };
  }
  return {
    reasoningText: taggedReasoning || undefined,
    answerText: strippedAnswer || undefined,
  };
}

/**
 * Extract content from `<think>`, `<thinking>`, `<thought>` blocks.
 * Handles both closed and unclosed (streaming) tags.
 */
function extractThinkingContent(text: string): string {
  if (!text) return '';
  const scanRe = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
  let result = '';
  let lastIndex = 0;
  let inThinking = false;
  for (const match of text.matchAll(scanRe)) {
    const idx = match.index ?? 0;
    if (inThinking) {
      result += text.slice(lastIndex, idx);
    }
    inThinking = match[1] !== '/';
    lastIndex = idx + match[0].length;
  }
  // Handle unclosed tag (still streaming)
  if (inThinking) {
    result += text.slice(lastIndex);
  }
  return result.trim();
}

/**
 * Strip reasoning blocks — both XML tags with their content and any
 * "Reasoning:\n" prefixed content.
 */
export function stripReasoningTags(text: string): string {
  // Strip complete XML blocks
  let result = text.replace(
    /<\s*(?:think(?:ing)?|thought|antthinking)\s*>[\s\S]*?<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi,
    '',
  );
  // Strip unclosed tag at end (streaming)
  result = result.replace(/<\s*(?:think(?:ing)?|thought|antthinking)\s*>[\s\S]*$/gi, '');
  // Strip orphaned closing tags
  result = result.replace(/<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi, '');
  return result.trim();
}

/**
 * Clean a "Reasoning:\n_italic_" formatted message back to plain text.
 * Strips the prefix and per-line italic markdown wrappers.
 */
function cleanReasoningPrefix(text: string): string {
  let cleaned = text.replace(/^Reasoning:\s*/i, '');
  cleaned = cleaned
    .split('\n')
    .map((line) => line.replace(/^_(.+)_$/, '$1'))
    .join('\n');
  return cleaned.trim();
}

/**
 * Format reasoning duration into a human-readable i18n pair.
 * e.g. { zh: "思考了 3.2s", en: "Thought for 3.2s" }
 */
export function formatReasoningDuration(ms: number): { zh: string; en: string } {
  const d = formatElapsed(ms);
  return { zh: `思考了 ${d}`, en: `Thought for ${d}` };
}

/**
 * Format tool-use duration into a human-readable i18n pair.
 */
export function formatToolUseDuration(ms: number): { zh: string; en: string } {
  const d = formatElapsed(ms);
  return { zh: `执行耗时 ${d}`, en: `Tool use for ${d}` };
}

/**
 * Format milliseconds into a human-readable duration string.
 */
export function formatElapsed(ms: number): string {
  const seconds = ms / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

/**
 * Build footer meta-info: notation-sized text with i18n support.
 * Error text is rendered in red; normal text uses default grey (notation).
 */
function buildFooter(zhText: string, enText: string, isError?: boolean): CardElement[] {
  const zhContent = isError ? `<font color='red'>${zhText}</font>` : zhText;
  const enContent = isError ? `<font color='red'>${enText}</font>` : enText;
  return [
    {
      tag: 'markdown',
      content: enContent,
      i18n_content: { zh_cn: zhContent, en_us: enContent },
      text_size: 'notation',
    },
  ];
}

export function compactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    const m = value / 1_000_000;
    return Math.abs(m) >= 100 ? `${Math.round(m)}m` : `${m.toFixed(1)}m`;
  }
  if (abs >= 1_000) {
    const k = value / 1_000;
    return Math.abs(k) >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
  }
  return `${Math.round(value)}`;
}

export function formatFooterRuntimeSegments(params: {
  footer?: {
    status?: boolean;
    elapsed?: boolean;
    tokens?: boolean;
    cache?: boolean;
    context?: boolean;
    model?: boolean;
  };
  metrics?: FooterSessionMetrics;
  elapsedMs?: number;
  isError?: boolean;
  isAborted?: boolean;
}): { primaryZh: string[]; primaryEn: string[]; detailZh: string[]; detailEn: string[] } {
  const { footer, metrics, elapsedMs, isError, isAborted } = params;
  const primaryZh: string[] = [];
  const primaryEn: string[] = [];
  const detailZh: string[] = [];
  const detailEn: string[] = [];

  // --- Primary line: status, elapsed, model ---

  if (footer?.status) {
    if (isError) {
      primaryZh.push('出错');
      primaryEn.push('Error');
    } else if (isAborted) {
      primaryZh.push('已停止');
      primaryEn.push('Stopped');
    } else {
      primaryZh.push('已完成');
      primaryEn.push('Completed');
    }
  }

  if (footer?.elapsed && elapsedMs != null) {
    const d = formatElapsed(elapsedMs);
    primaryZh.push(`耗时 ${d}`);
    primaryEn.push(`Elapsed ${d}`);
  }

  if (footer?.model && metrics?.model) {
    const model = metrics.model.trim();
    if (model) {
      primaryZh.push(model);
      primaryEn.push(model);
    }
  }

  // --- Detail line: tokens, cache, context ---

  if (footer?.tokens && metrics) {
    const inTokens = typeof metrics.inputTokens === 'number' ? Math.max(0, metrics.inputTokens) : undefined;
    const outTokens = typeof metrics.outputTokens === 'number' ? Math.max(0, metrics.outputTokens) : undefined;
    if (inTokens != null && outTokens != null) {
      const inLabel = compactNumber(inTokens);
      const outLabel = compactNumber(outTokens);
      detailZh.push(`↑ ${inLabel} ↓ ${outLabel}`);
      detailEn.push(`↑ ${inLabel} ↓ ${outLabel}`);
    }
  }

  if (footer?.cache && metrics) {
    const read = typeof metrics.cacheRead === 'number' ? Math.max(0, metrics.cacheRead) : undefined;
    const write = typeof metrics.cacheWrite === 'number' ? Math.max(0, metrics.cacheWrite) : undefined;
    const inputVal = typeof metrics.inputTokens === 'number' ? Math.max(0, metrics.inputTokens) : undefined;
    if (read != null && write != null && inputVal != null) {
      const total = read + write + inputVal;
      const hit = total > 0 ? Math.round((read / total) * 100) : 0;
      const left = compactNumber(read);
      const right = compactNumber(write);
      detailZh.push(`缓存 ${left}/${right} (${hit}%)`);
      detailEn.push(`Cache ${left}/${right} (${hit}%)`);
    }
  }

  if (footer?.context && metrics) {
    const freshTotal = metrics.totalTokensFresh === false ? undefined : metrics.totalTokens;
    const total = typeof freshTotal === 'number' ? Math.max(0, freshTotal) : undefined;
    const ctx = typeof metrics.contextTokens === 'number' ? Math.max(0, metrics.contextTokens) : undefined;
    if (total != null && ctx != null) {
      const totalLabel = compactNumber(total);
      const ctxLabel = compactNumber(ctx);
      const pct = ctx > 0 ? Math.round((total / ctx) * 100) : 0;
      const pctLabel = `${pct}%`;
      detailZh.push(`上下文 ${totalLabel}/${ctxLabel} (${pctLabel})`);
      detailEn.push(`Context ${totalLabel}/${ctxLabel} (${pctLabel})`);
    }
  }

  return { primaryZh, primaryEn, detailZh, detailEn };
}

// ---------------------------------------------------------------------------
// buildCardContent
// ---------------------------------------------------------------------------

/**
 * Build a full Feishu Interactive Message Card JSON object for the
 * given state.
 */
export function buildCardContent(
  state: CardState,
  data: {
    text?: string;
    reasoningText?: string;
    reasoningElapsedMs?: number;
    toolUseSteps?: ToolUseDisplayStep[];
    toolUseTitleSuffix?: { zh: string; en: string };
    toolUseElapsedMs?: number;
    showToolUse?: boolean;
    confirmData?: ConfirmData;
    elapsedMs?: number;
    isError?: boolean;
    isAborted?: boolean;
    footer?: {
      status?: boolean;
      elapsed?: boolean;
      tokens?: boolean;
      cache?: boolean;
      context?: boolean;
      model?: boolean;
    };
    footerMetrics?: FooterSessionMetrics;
  } = {},
): FeishuCard {
  switch (state) {
    case 'thinking':
      return buildThinkingCard();
    case 'streaming':
      return buildStreamingCard(data.text ?? '', {
        reasoningText: data.reasoningText,
        showToolUse: data.showToolUse,
        toolUseSteps: data.toolUseSteps,
        toolUseTitleSuffix: data.toolUseTitleSuffix,
      });
    case 'complete':
      return buildCompleteCard({
        text: data.text ?? '',
        elapsedMs: data.elapsedMs,
        isError: data.isError,
        reasoningText: data.reasoningText,
        reasoningElapsedMs: data.reasoningElapsedMs,
        toolUseSteps: data.toolUseSteps,
        toolUseTitleSuffix: data.toolUseTitleSuffix,
        toolUseElapsedMs: data.toolUseElapsedMs,
        showToolUse: data.showToolUse,
        isAborted: data.isAborted,
        footer: data.footer,
        footerMetrics: data.footerMetrics,
      });
    case 'confirm':
      return buildConfirmCard(data.confirmData!);
    default:
      throw new Error(`Unknown card state: ${state}`);
  }
}

// ---------------------------------------------------------------------------
// Private card builders
// ---------------------------------------------------------------------------

function buildThinkingCard(): FeishuCard {
  return {
    config: { wide_screen_mode: true, update_multi: true, locales: ['zh_cn', 'en_us'] },
    elements: [
      {
        tag: 'markdown',
        content: 'Thinking...',
        i18n_content: { zh_cn: '思考中...', en_us: 'Thinking...' },
      },
    ],
  };
}

function buildStreamingCard(
  partialText: string,
  params: {
    showToolUse?: boolean;
    toolUseSteps?: ToolUseDisplayStep[];
    toolUseTitleSuffix?: { zh: string; en: string };
    reasoningText?: string;
  } = {},
): FeishuCard {
  const { showToolUse = true, toolUseSteps, toolUseTitleSuffix, reasoningText } = params;
  const elements: CardElement[] = [];
  const hasToolUse = Boolean(toolUseSteps?.length);

  if (showToolUse) {
    elements.push(
      hasToolUse
        ? buildToolUsePanel({
            toolUseSteps,
            titleSuffix: toolUseTitleSuffix,
          })
        : buildStreamingToolUsePendingPanel(),
    );
  }

  if (!partialText && reasoningText) {
    // Reasoning phase: show reasoning content in notation style
    elements.push({
      tag: 'markdown',
      content: `💭 **Thinking...**\n\n${reasoningText}`,
      i18n_content: {
        zh_cn: `💭 **思考中...**\n\n${reasoningText}`,
        en_us: `💭 **Thinking...**\n\n${reasoningText}`,
      },
      text_size: 'notation',
    });
  } else if (partialText) {
    // Answer phase: show answer content only
    elements.push({
      tag: 'markdown',
      content: optimizeMarkdownStyle(partialText),
    });
  }

  return {
    config: { wide_screen_mode: true, update_multi: true, locales: ['zh_cn', 'en_us'] },
    elements,
  };
}

function buildCompleteCard(params: {
  text: string;
  elapsedMs?: number;
  isError?: boolean;
  reasoningText?: string;
  reasoningElapsedMs?: number;
  toolUseSteps?: ToolUseDisplayStep[];
  toolUseTitleSuffix?: { zh: string; en: string };
  toolUseElapsedMs?: number;
  showToolUse?: boolean;
  isAborted?: boolean;
  footer?: {
    status?: boolean;
    elapsed?: boolean;
    tokens?: boolean;
    cache?: boolean;
    context?: boolean;
    model?: boolean;
  };
  footerMetrics?: FooterSessionMetrics;
}): FeishuCard {
  const {
    text,
    elapsedMs,
    isError,
    reasoningText,
    reasoningElapsedMs,
    toolUseSteps,
    toolUseTitleSuffix,
    toolUseElapsedMs,
    showToolUse = true,
    isAborted,
    footer,
    footerMetrics,
  } = params;
  const elements: CardElement[] = [];

  if (showToolUse) {
    elements.push(
      buildToolUsePanel({
        toolUseSteps,
        toolUseElapsedMs,
        titleSuffix: toolUseTitleSuffix,
      }),
    );
  }

  // Collapsible reasoning panel (before main content)
  if (reasoningText) {
    const dur = reasoningElapsedMs ? formatReasoningDuration(reasoningElapsedMs) : null;
    const zhLabel = dur ? dur.zh : '思考';
    const enLabel = dur ? dur.en : 'Thought';
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: {
          tag: 'markdown',
          content: `💭 ${enLabel}`,
          i18n_content: {
            zh_cn: `💭 ${zhLabel}`,
            en_us: `💭 ${enLabel}`,
          },
        },
        vertical_align: 'center',
        icon: {
          tag: 'standard_icon',
          token: 'down-small-ccm_outlined',
          size: '16px 16px',
        },
        icon_position: 'follow_text',
        icon_expanded_angle: -180,
      },
      border: { color: 'grey', corner_radius: '5px' },
      vertical_spacing: '8px',
      padding: '8px 8px 8px 8px',
      elements: [
        {
          tag: 'markdown',
          content: reasoningText,
          text_size: 'notation',
        },
      ],
    });
  }

  // Full text content
  elements.push({
    tag: 'markdown',
    content: optimizeMarkdownStyle(text),
  });

  // Footer meta-info: split into two lines for readability.
  // Line 1 (primary): status · elapsed · model
  // Line 2 (detail):  tokens · cache · context
  const fp = formatFooterRuntimeSegments({
    footer,
    metrics: footerMetrics,
    elapsedMs,
    isError,
    isAborted,
  });

  const footerZhLines: string[] = [];
  const footerEnLines: string[] = [];
  if (fp.primaryZh.length > 0) {
    footerZhLines.push(fp.primaryZh.join(' · '));
    footerEnLines.push(fp.primaryEn.join(' · '));
  }
  if (fp.detailZh.length > 0) {
    footerZhLines.push(fp.detailZh.join(' · '));
    footerEnLines.push(fp.detailEn.join(' · '));
  }
  if (footerZhLines.length > 0) {
    elements.push(...buildFooter(footerZhLines.join('\n'), footerEnLines.join('\n'), isError));
  }

  // Use the answer text as the feed preview summary.
  // Strip markdown syntax so the preview reads as plain text.
  const summaryText = text.replace(/[*_`#>[\]()~]/g, '').trim();
  const summary = summaryText ? { content: summaryText.slice(0, 120) } : undefined;

  return {
    config: { wide_screen_mode: true, update_multi: true, locales: ['zh_cn', 'en_us'], summary },
    elements,
  };
}

function buildConfirmCard(confirmData: ConfirmData): FeishuCard {
  const elements: CardElement[] = [];

  // Operation description
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: confirmData.operationDescription,
    },
  });

  // Preview (if available)
  if (confirmData.preview) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**Preview:**\n${confirmData.preview}`,
      },
    });
  }

  // Confirm / Reject / Preview buttons
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: 'Confirm' },
        type: 'primary',
        value: {
          action: 'confirm_write',
          operation_id: confirmData.pendingOperationId,
        },
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: 'Reject' },
        type: 'danger',
        value: {
          action: 'reject_write',
          operation_id: confirmData.pendingOperationId,
        },
      },
      ...(confirmData.preview
        ? []
        : [
            {
              tag: 'button' as const,
              text: {
                tag: 'plain_text' as const,
                content: 'Preview',
              },
              type: 'default' as const,
              value: {
                action: 'preview_write',
                operation_id: confirmData.pendingOperationId,
              },
            },
          ]),
    ],
  });

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: {
        tag: 'plain_text',
        content: '\ud83d\udd12 Confirmation Required',
      },
      template: 'orange',
    },
    elements,
  };
}

// ---------------------------------------------------------------------------
// toCardKit2
// ---------------------------------------------------------------------------

/**
 * Convert an old-format FeishuCard to CardKit JSON 2.0 format.
 * JSON 2.0 uses `body.elements` instead of top-level `elements`.
 */
/**
 * Build the initial CardKit 2.0 streaming card with a loading icon.
 * Optionally includes a tool-use pending panel above the streaming area.
 */
export function buildStreamingThinkingCard(showToolUse = true): Record<string, unknown> {
  return buildStreamingPreAnswerCard({ showToolUse });
}

/**
 * Build a CardKit 2.0 card for the pre-answer streaming phase.
 * Used both for the initial card and for live updates during tool calls.
 */
export function buildStreamingPreAnswerCard(params: {
  steps?: ToolUseDisplayStep[];
  elapsedMs?: number;
  showToolUse?: boolean;
}): Record<string, unknown> {
  const { steps, elapsedMs, showToolUse = true } = params;
  const hasSteps = Boolean(steps?.length);
  const elements: unknown[] = [];

  if (showToolUse) {
    elements.push(
      hasSteps ? buildStreamingToolUseActivePanel({ steps: steps!, elapsedMs }) : buildStreamingToolUsePendingPanel(),
    );
  }

  elements.push({
    tag: 'markdown',
    content: '',
    text_align: 'left',
    text_size: 'normal_v2',
    margin: '0px 0px 0px 0px',
    element_id: STREAMING_ELEMENT_ID,
  });

  elements.push({
    tag: 'markdown',
    content: ' ',
    icon: {
      tag: 'custom_icon',
      img_key: 'img_v3_02vb_496bec09-4b43-4773-ad6b-0cdd103cd2bg',
      size: '16px 16px',
    },
    element_id: 'loading_icon',
  });

  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      locales: ['zh_cn', 'en_us'],
      summary: {
        content: 'Processing...',
        i18n_content: { zh_cn: '处理中...', en_us: 'Processing...' },
      },
    },
    body: { elements },
  };
}

/**
 * Build the collapsible panel for the active pre-answer phase.
 * Used by buildStreamingPreAnswerCard when at least one step exists.
 */
function buildStreamingToolUseActivePanel(params: { steps: ToolUseDisplayStep[]; elapsedMs?: number }): CardElement {
  const { steps, elapsedMs } = params;
  const enParts = ['Tool use'];
  const zhParts = ['工具执行'];

  if (steps.length > 0) {
    enParts.push(`${steps.length} step${steps.length === 1 ? '' : 's'}`);
    zhParts.push(`${steps.length} 步`);
  }

  if (elapsedMs != null && elapsedMs > 0) {
    const d = formatElapsed(elapsedMs);
    enParts.push(`(${d})`);
    zhParts.push(`(${d})`);
  }

  return {
    tag: 'collapsible_panel',
    expanded: true,
    header: {
      title: {
        tag: 'plain_text',
        content: `🛠️ ${enParts.join(' · ')}`,
        i18n_content: {
          zh_cn: `🛠️ ${zhParts.join(' · ')}`,
          en_us: `🛠️ ${enParts.join(' · ')}`,
        },
        text_color: 'grey',
        text_size: 'notation',
      },
      vertical_align: 'center',
      icon: {
        tag: 'standard_icon',
        token: 'down-small-ccm_outlined',
        color: 'grey',
        size: '16px 16px',
      },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    border: { color: 'grey', corner_radius: '5px' },
    vertical_spacing: '4px',
    padding: '8px 8px 8px 8px',
    elements: steps.flatMap((step) => buildToolUseStepElements(step)),
  };
}

export function toCardKit2(card: FeishuCard): Record<string, unknown> {
  const result: Record<string, unknown> = {
    schema: '2.0',
    config: card.config,
    body: { elements: card.elements },
  };
  if (card.header) result.header = card.header;
  return result;
}

function buildStreamingToolUsePendingPanel(): CardElement {
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: {
        tag: 'plain_text',
        content: '🛠️ Tool use pending',
        i18n_content: {
          zh_cn: '🛠️ 等待工具执行',
          en_us: '🛠️ Tool use pending',
        },
        text_color: 'grey',
        text_size: 'notation',
      },
      vertical_align: 'center',
      icon: {
        tag: 'standard_icon',
        token: 'down-small-ccm_outlined',
        color: 'grey',
        size: '16px 16px',
      },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    border: { color: 'grey', corner_radius: '5px' },
    vertical_spacing: '4px',
    padding: '8px 8px 8px 8px',
    elements: [],
  };
}

function buildToolUsePanel(params: {
  toolUseSteps?: ToolUseDisplayStep[];
  toolUseElapsedMs?: number;
  titleSuffix?: { zh: string; en: string };
}): CardElement {
  const { toolUseSteps = [], toolUseElapsedMs, titleSuffix } = params;
  const duration = toolUseElapsedMs ? formatToolUseDuration(toolUseElapsedMs) : null;
  const zhTitleParts = [duration?.zh ?? '工具执行'];
  const enTitleParts = [duration?.en ?? 'Tool use'];
  if (titleSuffix) {
    zhTitleParts.push(titleSuffix.zh);
    enTitleParts.push(titleSuffix.en);
  }

  const stepElements =
    toolUseSteps.length > 0
      ? toolUseSteps.flatMap((step) => buildToolUseStepElements(step))
      : [buildToolUsePlaceholder()];

  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: {
        tag: 'plain_text',
        content: `🛠️ ${enTitleParts.join(' · ')}`,
        i18n_content: {
          zh_cn: `🛠️ ${zhTitleParts.join(' · ')}`,
          en_us: `🛠️ ${enTitleParts.join(' · ')}`,
        },
        text_color: 'grey',
        text_size: 'notation',
      },
      vertical_align: 'center',
      icon: {
        tag: 'standard_icon',
        token: 'down-small-ccm_outlined',
        color: 'grey',
        size: '16px 16px',
      },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    border: { color: 'grey', corner_radius: '5px' },
    vertical_spacing: '4px',
    padding: '8px 8px 8px 8px',
    elements: stepElements,
  };
}

function buildToolUseStepElements(step: ToolUseDisplayStep): CardElement[] {
  const elements: CardElement[] = [buildToolUseStepTitleElement(step)];
  const detailElement = buildToolUseStepDetailElement(step);
  if (detailElement) {
    elements.push(detailElement);
  }
  const outputElement = buildToolUseStepOutputElement(step);
  if (outputElement) {
    elements.push(outputElement);
  }
  return elements;
}

function buildToolUsePlaceholder(labels?: { zh: string; en: string }): CardElement {
  const zh = labels?.zh ?? '暂无工具步骤';
  const en = labels?.en ?? EMPTY_TOOL_USE_PLACEHOLDER;
  return {
    tag: 'div',
    text: {
      tag: 'plain_text',
      content: en,
      i18n_content: {
        zh_cn: zh,
        en_us: en,
      },
      text_color: 'grey',
      text_size: 'notation',
    },
  };
}

function buildToolUseStepTitleElement(step: ToolUseDisplayStep): CardElement {
  return {
    tag: 'div',
    icon: {
      tag: 'standard_icon',
      token: step.iconToken,
      color: 'grey',
    },
    text: {
      tag: 'lark_md',
      content: buildToolUseStepTitleMarkdown(step),
      text_size: 'notation',
    },
  };
}

function buildToolUseStepTitleMarkdown(step: ToolUseDisplayStep): string {
  const status = formatToolUseStepStatus(step.status);
  return optimizeMarkdownStyle(
    `**${escapeToolUseMarkdownText(step.title)}** · <font color='${status.color}'>${status.label}</font>`,
    1,
  );
}

function buildToolUseStepDetailElement(step: ToolUseDisplayStep): CardElement | undefined {
  const detail = step.detail?.trim();
  if (!detail) return undefined;
  return {
    tag: 'div',
    margin: TOOL_USE_STEP_CONTENT_INDENT,
    text: {
      tag: 'plain_text',
      content: detail,
      text_color: 'grey',
      text_size: 'notation',
    },
  };
}

function buildToolUseStepOutputElement(step: ToolUseDisplayStep): CardElement | undefined {
  const content = buildToolUseStepOutputMarkdown(step);
  if (!content) return undefined;
  return {
    tag: 'div',
    margin: TOOL_USE_STEP_CONTENT_INDENT,
    text: {
      tag: 'lark_md',
      content,
      text_size: 'notation',
    },
  };
}

function buildToolUseStepOutputMarkdown(step: ToolUseDisplayStep): string | undefined {
  const lines: string[] = [];

  if (step.errorBlock) {
    lines.push('**Error**');
    lines.push(formatToolUseCodeBlock(step.errorBlock.content, step.errorBlock.language));
  } else if (step.resultBlock) {
    lines.push('**Result**');
    lines.push(formatToolUseCodeBlock(step.resultBlock.content, step.resultBlock.language));
  }

  if (lines.length === 0) return undefined;
  return optimizeMarkdownStyle(lines.join('\n'), 1);
}

function formatToolUseStepStatus(status: ToolUseDisplayStep['status']): { label: string; color: string } {
  switch (status) {
    case 'running':
      return { label: 'Running', color: 'turquoise' };
    case 'error':
      return { label: 'Failed', color: 'red' };
    case 'success':
    default:
      return { label: 'Succeeded', color: 'green' };
  }
}

function formatToolUseCodeBlock(content: string, language: 'json' | 'text'): string {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(normalized) + 1));
  return `${fence}${language}\n${normalized}\n${fence}`;
}

function longestBacktickRun(value: string): number {
  const matches = value.match(/`+/g) ?? [];
  return matches.reduce((max, run) => Math.max(max, run.length), 0);
}

function escapeToolUseMarkdownText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/([`*_{}[\]<>])/g, '\\$1');
}
