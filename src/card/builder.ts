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
import { EMPTY_REASONING_PLACEHOLDER, type ReasoningDisplayStep } from './reasoning-display';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Element ID used for the streaming text area in cards. The CardKit
 * `cardElement.content()` API targets this element for typewriter-effect
 * streaming updates.
 */
export const STREAMING_ELEMENT_ID = 'streaming_content';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolCallInfo {
  name: string;
  status: 'running' | 'complete' | 'error';
  args?: Record<string, unknown>;
  result?: string;
}

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
  return [{
    tag: 'markdown',
    content: enContent,
    i18n_content: { zh_cn: zhContent, en_us: enContent },
    text_size: 'notation',
  }];
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
    reasoningSteps?: ReasoningDisplayStep[];
    reasoningTitleSuffix?: { zh: string; en: string };
    reasoningElapsedMs?: number;
    showReasoning?: boolean;
    toolCalls?: ToolCallInfo[];
    confirmData?: ConfirmData;
    elapsedMs?: number;
    isError?: boolean;
    isAborted?: boolean;
    footer?: { status?: boolean; elapsed?: boolean };
  } = {},
): FeishuCard {
  switch (state) {
    case 'thinking':
      return buildThinkingCard();
    case 'streaming':
      return buildStreamingCard(data.text ?? '', data.showReasoning);
    case 'complete':
      return buildCompleteCard({
        text: data.text ?? '',
        elapsedMs: data.elapsedMs,
        isError: data.isError,
        reasoningSteps: data.reasoningSteps,
        reasoningTitleSuffix: data.reasoningTitleSuffix,
        reasoningElapsedMs: data.reasoningElapsedMs,
        showReasoning: data.showReasoning,
        isAborted: data.isAborted,
        footer: data.footer,
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
  showReasoning = true,
): FeishuCard {
  const elements: CardElement[] = [];

  if (showReasoning) {
    elements.push(buildStreamingReasoningPendingPanel());
  }

  if (partialText) {
    elements.push({
      tag: 'markdown',
      content: optimizeMarkdownStyle(partialText),
    });
  } else if (!showReasoning) {
    elements.push({
      tag: 'markdown',
      content: 'Thinking...',
      i18n_content: {
        zh_cn: '思考中...',
        en_us: 'Thinking...',
      },
    });
  } else {
    elements.push({
      tag: 'markdown',
      content: '...',
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
  reasoningSteps?: ReasoningDisplayStep[];
  reasoningTitleSuffix?: { zh: string; en: string };
  reasoningElapsedMs?: number;
  showReasoning?: boolean;
  isAborted?: boolean;
  footer?: { status?: boolean; elapsed?: boolean };
}): FeishuCard {
  const {
    text,
    elapsedMs,
    isError,
    reasoningSteps,
    reasoningTitleSuffix,
    reasoningElapsedMs,
    showReasoning = true,
    isAborted,
    footer,
  } = params;
  const elements: CardElement[] = [];

  // Collapsible reasoning panel (before main content)
  if (showReasoning) {
    elements.push(
      buildReasoningPanel({
        reasoningSteps,
        reasoningElapsedMs,
        titleSuffix: reasoningTitleSuffix,
      }),
    );
  }

  // Full text content
  elements.push({
    tag: 'markdown',
    content: optimizeMarkdownStyle(text),
  });

  // Footer meta-info: each metadata item is independently controlled via
  // the `footer` config. Both status and elapsed default to hidden.
  const zhParts: string[] = [];
  const enParts: string[] = [];

  if (footer?.status) {
    if (isError) {
      zhParts.push('出错');
      enParts.push('Error');
    } else if (isAborted) {
      zhParts.push('已停止');
      enParts.push('Stopped');
    } else {
      zhParts.push('已完成');
      enParts.push('Completed');
    }
  }

  if (footer?.elapsed && elapsedMs != null) {
    const d = formatElapsed(elapsedMs);
    zhParts.push(`耗时 ${d}`);
    enParts.push(`Elapsed ${d}`);
  }

  if (zhParts.length > 0) {
    elements.push(...buildFooter(zhParts.join(' · '), enParts.join(' · '), isError));
  }

  // Use the answer text (not reasoning) as the feed preview summary.
  // Strip markdown syntax so the preview reads as plain text.
  const summaryText = text.replace(/[*_`#>\[\]()~]/g, '').trim();
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
 * Optionally includes a reasoning pending panel above the streaming area.
 */
export function buildStreamingThinkingCard(showReasoning = true): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      locales: ['zh_cn', 'en_us'],
      summary: {
        content: 'Thinking...',
        i18n_content: { zh_cn: '思考中...', en_us: 'Thinking...' },
      },
    },
    body: {
      elements: [
        ...(showReasoning ? [buildStreamingReasoningPendingPanel()] : []),
        {
          tag: 'markdown',
          content: '',
          text_align: 'left',
          text_size: 'normal_v2',
          margin: '0px 0px 0px 0px',
          element_id: STREAMING_ELEMENT_ID,
        },
        {
          tag: 'markdown',
          content: ' ',
          icon: {
            tag: 'custom_icon',
            img_key: 'img_v3_02vb_496bec09-4b43-4773-ad6b-0cdd103cd2bg',
            size: '16px 16px',
          },
          element_id: 'loading_icon',
        },
      ],
    },
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

function buildStreamingReasoningPendingPanel(): CardElement {
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: {
        tag: 'plain_text',
        content: '💭 Thinking...',
        i18n_content: {
          zh_cn: '💭 思考中...',
          en_us: '💭 Thinking...',
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
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [],
  };
}

function buildReasoningPanel(params: {
  reasoningSteps?: ReasoningDisplayStep[];
  reasoningElapsedMs?: number;
  titleSuffix?: { zh: string; en: string };
}): CardElement {
  const { reasoningSteps = [], reasoningElapsedMs, titleSuffix } = params;
  const duration = reasoningElapsedMs ? formatReasoningDuration(reasoningElapsedMs) : null;
  const zhTitleParts = [duration?.zh ?? '思考过程'];
  const enTitleParts = [duration?.en ?? 'Thought process'];
  if (titleSuffix) {
    zhTitleParts.push(titleSuffix.zh);
    enTitleParts.push(titleSuffix.en);
  }

  const stepElements = reasoningSteps.length > 0
    ? reasoningSteps.map((step) => buildReasoningStepElement(step))
    : [buildReasoningPlaceholder()];

  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: {
        tag: 'plain_text',
        content: `💭 ${enTitleParts.join(' · ')}`,
        i18n_content: {
          zh_cn: `💭 ${zhTitleParts.join(' · ')}`,
          en_us: `💭 ${enTitleParts.join(' · ')}`,
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
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: stepElements,
  };
}

function buildReasoningStepElement(step: ReasoningDisplayStep): CardElement {
  return {
    tag: 'div',
    icon: {
      tag: 'standard_icon',
      token: step.iconToken,
      color: 'grey',
    },
    text: {
      tag: 'plain_text',
      content: step.detail ? `${step.title}\n${step.detail}` : step.title,
      text_color: 'grey',
      text_size: 'notation',
    },
  };
}

function buildReasoningPlaceholder(labels?: { zh: string; en: string }): CardElement {
  const zh = labels?.zh ?? '暂无可展示的思考内容';
  const en = labels?.en ?? EMPTY_REASONING_PLACEHOLDER;
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
