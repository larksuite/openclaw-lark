/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Unified card API error handling.
 *
 * Provides structured error class for CardKit API responses, sub-error
 * parsing for the generic 230099 code, and helper predicates used by
 * reply-dispatcher and streaming-card-controller.
 */

import { extractLarkApiCode } from '../core/api-error';

// ---------------------------------------------------------------------------
// Error code constants
// ---------------------------------------------------------------------------

/** 卡片 API 级别错误码。 */
export const CARD_ERROR = {
  /** 发送频率限制 */
  RATE_LIMITED: 230020,
  /** 卡片内容创建失败（通用码，需检查子错误） */
  CARD_CONTENT_FAILED: 230099,
} as const;

/** 230099 子错误码，嵌套在 msg 的 ErrCode 字段中。 */
export const CARD_CONTENT_SUB_ERROR = {
  /** 卡片元素（表格等）数量超限 */
  ELEMENT_LIMIT: 11310,
} as const;

/** 飞书卡片表格上限缺省值（可通过 channels.feishu.cardTableLimit 覆盖）。 */
export const FEISHU_CARD_TABLE_LIMIT = 3;

/**
 * 解析实际生效的卡片表格数量上限。
 *
 * 配置优先级：channels.feishu.cardTableLimit > FEISHU_CARD_TABLE_LIMIT（缺省 3）。
 * - 不设置 / 缺省 → 3
 * - 0 或 false → 关闭限制（不 sanitize，不 fallback 到纯文本）
 * - 正整数（如 50）→ 自定义上限
 */
export function resolveTableLimit(feishuCfgOrRootCfg: Record<string, unknown> | undefined): number {
  // 支持直接传入 feishuCfg 或传入根 config（自动提取 channels.feishu）
  const feishuCfg = feishuCfgOrRootCfg?.cardTableLimit !== undefined
    ? feishuCfgOrRootCfg
    : (feishuCfgOrRootCfg as Record<string, unknown>)?.channels as Record<string, unknown>?.feishu as Record<string, unknown> | undefined;
  if (feishuCfg?.cardTableLimit === 0 || feishuCfg?.cardTableLimit === false) {
    return Infinity; // 关闭限制
  }
  const configured = Number(feishuCfg?.cardTableLimit);
  if (Number.isFinite(configured) && configured > 0 && Number.isInteger(configured)) {
    return configured;
  }
  return FEISHU_CARD_TABLE_LIMIT; // 缺省 3
}

export interface MarkdownTableMatch {
  index: number;
  length: number;
  raw: string;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/** CardKit API 返回非零 code 时的结构化错误。 */
export class CardKitApiError extends Error {
  readonly code: number;
  readonly msg: string;

  constructor(params: { api: string; code: number; msg: string; context: string }) {
    const { api, code, msg, context } = params;
    super(`cardkit ${api} FAILED: code=${code}, msg=${msg}, ${context}`);
    this.name = 'CardKitApiError';
    this.code = code;
    this.msg = msg;
  }
}

// ---------------------------------------------------------------------------
// Sub-error extraction
// ---------------------------------------------------------------------------

/**
 * 从 msg 字符串中提取子错误码。
 *
 * 示例输入: "Failed to create card content, ext=ErrCode: 11310; ErrMsg: element exceeds the limit; code:230099"
 * 返回 11310 或 null。
 */
export function extractSubCode(msg: string): number | null {
  const match = /ErrCode:\s*(\d+)/.exec(msg);
  if (!match) return null;
  const code = Number(match[1]);
  return Number.isFinite(code) ? code : null;
}

// ---------------------------------------------------------------------------
// Structured error parsing
// ---------------------------------------------------------------------------

/**
 * 从任意抛错对象中解析卡片 API 错误结构。
 *
 * 返回 { code, subCode, errMsg }，如果无法提取 code 则返回 null。
 */
export function parseCardApiError(err: unknown): { code: number; subCode: number | null; errMsg: string } | null {
  const code = extractLarkApiCode(err);
  if (code === undefined) return null;

  // 按优先级提取 msg 文本
  let errMsg = '';
  if (err && typeof err === 'object') {
    const e = err as {
      msg?: unknown;
      message?: unknown;
      response?: { data?: { msg?: unknown } };
    };
    if (typeof e.msg === 'string') {
      errMsg = e.msg;
    } else if (typeof e.response?.data?.msg === 'string') {
      // Axios errors: response.data.msg carries the Feishu detail with ErrCode
      errMsg = e.response.data.msg;
    } else if (typeof e.message === 'string') {
      // Fallback to generic Error.message (e.g. CardKitApiError)
      errMsg = e.message;
    }
  }

  const subCode = extractSubCode(errMsg);
  return { code, subCode, errMsg };
}

// ---------------------------------------------------------------------------
// Helper predicates
// ---------------------------------------------------------------------------

/**
 * 判断错误是否为卡片表格数量超限。
 *
 * 匹配条件：code 230099 + subCode 11310 + errMsg 含 "table number over limit"。
 * 11310 是通用的元素超限码（也覆盖模板可见性、组件上限等），
 * 必须同时检查 errMsg 确认是表格数量导致的。
 *
 * 实际错误格式（生产日志 2026-03-13）：
 * "Failed to create card content, ext=ErrCode: 11310; ErrMsg: card table number over limit; ErrorValue: table; "
 */
export function isCardTableLimitError(err: unknown): boolean {
  const parsed = parseCardApiError(err);
  if (!parsed) return false;
  return (
    parsed.code === CARD_ERROR.CARD_CONTENT_FAILED &&
    parsed.subCode === CARD_CONTENT_SUB_ERROR.ELEMENT_LIMIT &&
    /table number over limit/i.test(parsed.errMsg)
  );
}

/** 判断错误是否为卡片发送频率限制（230020）。 */
export function isCardRateLimitError(err: unknown): boolean {
  const parsed = parseCardApiError(err);
  if (!parsed) return false;
  return parsed.code === CARD_ERROR.RATE_LIMITED;
}

// ---------------------------------------------------------------------------
// Text sanitization
// ---------------------------------------------------------------------------

/**
 * 收集正文里可被飞书卡片实际渲染的 markdown 表格。
 *
 * 代码块里的示例表格不会被飞书解析成卡片表格元素，因此这里要先排除，
 * 让 shouldUseCard() 预检和 sanitizeTextForCard() 降级逻辑使用同一份结果。
 */
export function findMarkdownTablesOutsideCodeBlocks(text: string): MarkdownTableMatch[] {
  const codeBlockRanges: Array<{ start: number; end: number }> = [];
  const codeBlockRegex = /```[\s\S]*?```/g;
  let codeBlockMatch = codeBlockRegex.exec(text);
  while (codeBlockMatch != null) {
    codeBlockRanges.push({
      start: codeBlockMatch.index,
      end: codeBlockMatch.index + codeBlockMatch[0].length,
    });
    codeBlockMatch = codeBlockRegex.exec(text);
  }

  const isInsideCodeBlock = (idx: number): boolean =>
    codeBlockRanges.some((range) => idx >= range.start && idx < range.end);

  const tableRegex = /\|.+\|[\r\n]+\|[-:| ]+\|[\s\S]*?(?=\n\n|\n(?!\|)|$)/g;
  const matches: MarkdownTableMatch[] = [];
  let tableMatch = tableRegex.exec(text);
  while (tableMatch != null) {
    if (!isInsideCodeBlock(tableMatch.index)) {
      matches.push({
        index: tableMatch.index,
        length: tableMatch[0].length,
        raw: tableMatch[0],
      });
    }
    tableMatch = tableRegex.exec(text);
  }

  return matches;
}

/**
 * 对多段 markdown 文本共享一个表格预算。
 *
 * 段落按数组顺序消耗额度，适合处理“reasoning + 正文”这类会被飞书
 * 作为同一张卡片渲染的多块文本。
 */
export function sanitizeTextSegmentsForCard(
  texts: readonly string[],
  tableLimit: number = FEISHU_CARD_TABLE_LIMIT,
): string[] {
  let remainingTableBudget = tableLimit;

  return texts.map((text) => {
    const matches = findMarkdownTablesOutsideCodeBlocks(text);
    if (matches.length <= remainingTableBudget) {
      remainingTableBudget -= matches.length;
      return text;
    }

    const sanitizedText = wrapTablesBeyondLimit(text, matches, Math.max(remainingTableBudget, 0));
    remainingTableBudget = 0;
    return sanitizedText;
  });
}

/**
 * 对正文中超出 tableLimit 的 markdown 表格降级为 code block，
 * 避免飞书卡片因表格数超限触发 230099/11310。
 *
 * 前 tableLimit 张表格保持原样（可正常卡片渲染）；
 * 超出部分用反引号包裹，阻止飞书将其解析为卡片表格元素。
 */
export function sanitizeTextForCard(text: string, tableLimit: number = FEISHU_CARD_TABLE_LIMIT): string {
  return sanitizeTextSegmentsForCard([text], tableLimit)[0];
}

function wrapTablesBeyondLimit(text: string, matches: readonly MarkdownTableMatch[], keepCount: number): string {
  if (matches.length <= keepCount) return text;

  // Back-to-front replacement keeps the original indices stable.
  let result = text;
  for (let i = matches.length - 1; i >= keepCount; i--) {
    const { index, length, raw } = matches[i];
    const replacement = `\`\`\`\n${raw}\n\`\`\``;
    result = result.slice(0, index) + replacement + result.slice(index + length);
  }

  return result;
}
