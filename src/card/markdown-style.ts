/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Markdown 样式优化工具
 */

/**
 * 优化 Markdown 样式：
 * - 标题降级：H1 → H4，H2~H6 → H5
 * - 表格前后增加段落间距
 * - 有序列表：序号后确保只有一个空格
 * - 无序列表："- " 格式规范化（跳过分隔线 ---）
 * - 表格：单元格前后补空格，分隔符行规范化，表格前后加空行
 * - 代码块内容不受影响
 */
export function optimizeMarkdownStyle(text: string, cardVersion = 2): string {
  try {
    let r = _optimizeMarkdownStyle(text, cardVersion);
    r = stripInvalidImageKeys(r);
    return r;
  } catch {
    return text;
  }
}

function _optimizeMarkdownStyle(text: string, cardVersion = 2): string {
  // ── 1. 提取代码块，用占位符保护，处理后再还原 ─────────────────────
  const MARK = '___CB_';
  const codeBlocks: string[] = [];
  let r = text.replace(/(^|\n)(`{3,})([^\n]*)\n[\s\S]*?\n\2(?=\n|$)/g, (m, prefix = '') => {
    const block = m.slice(String(prefix).length);
    return `${prefix}${MARK}${codeBlocks.push(block) - 1}___`;
  });

  // ── 2. 标题降级 ────────────────────────────────────────────────────
  // 只有当原文档包含 h1~h3 标题时才执行降级
  // 先处理 H2~H6 → H5，再处理 H1 → H4
  // 顺序不能颠倒：若先 H1→H4，H4（####）会被后面的 #{2,6} 再次匹配成 H5
  const hasH1toH3 = /^#{1,3} /m.test(text);
  if (hasH1toH3) {
    r = r.replace(/^#{2,6} (.+)$/gm, '##### $1'); // H2~H6 → H5
    r = r.replace(/^# (.+)$/gm, '#### $1'); // H1 → H4
  }

  if (cardVersion >= 2) {
    // ── 3. 连续标题间增加段落间距 ───────────────────────────────────────
    r = r.replace(/^(#{4,5} .+)\n{1,2}(#{4,5} )/gm, '$1\n<br>\n$2');

    // ── 4. 表格前后增加段落间距 ─────────────────────────────────────────
    // 4a. 非表格行直接跟表格行时，先补一个空行
    r = r.replace(/^([^|\n].*)\n(\|.+\|)/gm, '$1\n\n$2');
    // 4b. 表格前：在空行之前插入 <br>（即 \n\n| → \n<br>\n\n| ）
    r = r.replace(/\n\n((?:\|.+\|[^\S\n]*\n?)+)/g, '\n\n<br>\n\n$1');
    // 4c. 表格后：在表格块末尾追加 <br>（跳过后接分隔线/标题/加粗/文末的情况）
    r = r.replace(/((?:^\|.+\|[^\S\n]*\n?)+)/gm, (m, _table, offset) => {
      const after = r.slice(offset + m.length).replace(/^\n+/, '');
      if (!after || /^(---|#{4,5} |\*\*)/.test(after)) return m;
      return m + '\n<br>\n';
    });
    // 4d. 表格前是普通文本（非标题、非加粗行）时，只需 <br>，去掉多余空行
    //     "text\n\n<br>\n\n|" → "text\n<br>\n|"
    r = r.replace(/^((?!#{4,5} )(?!\*\*).+)\n\n(<br>)\n\n(\|)/gm, '$1\n$2\n$3');
    // 4d2. 表格前是加粗行时，<br> 紧贴加粗行，空行保留在后面
    //     "**bold**\n\n<br>\n\n|" → "**bold**\n<br>\n\n|"
    r = r.replace(/^(\*\*.+)\n\n(<br>)\n\n(\|)/gm, '$1\n$2\n\n$3');
    // 4e. 表格后是普通文本（非标题、非加粗行）时，只需 <br>，去掉多余空行
    //     "| row |\n\n<br>\ntext" → "| row |\n<br>\ntext"
    r = r.replace(/(\|[^\n]*\n)\n(<br>\n)((?!#{4,5} )(?!\*\*))/gm, '$1$2$3');

    // ── 5. 还原代码块，并在前后追加 <br> ──────────────────────────────
    codeBlocks.forEach((block, i) => {
      r = r.replace(`${MARK}${i}___`, `\n<br>\n${block}\n<br>\n`);
    });
  } else {
    // ── 5. 还原代码块（无 <br>）───────────────────────────────────────
    codeBlocks.forEach((block, i) => {
      r = r.replace(`${MARK}${i}___`, block);
    });
  }

  // ── 6. 压缩多余空行（3 个以上连续换行 → 2 个）────────────────────
  r = r.replace(/\n{3,}/g, '\n\n');

  return r;
}

// ---------------------------------------------------------------------------
// stripLeakedThinkingContent — channel-level safety net
// ---------------------------------------------------------------------------

const THINKING_TAGS_RE =
  /<\s*(?:think(?:ing)?|thought|antthinking)\s*>[\s\S]*?<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
const UNCLOSED_THINKING_RE =
  /<\s*(?:think(?:ing)?|thought|antthinking)\s*>[\s\S]*$/gi;
const ORPHAN_CLOSE_THINKING_RE =
  /<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;

/**
 * Safety net: strip any leaked `<thinking>` / `<think>` / `<thought>` /
 * `<antthinking>` content from streaming snapshots.
 *
 * The main reasoning pipeline (`splitReasoningText`) handles this during
 * normal flow, but partial chunks or edge cases may leak through.
 * Call this right before handing content to CardKit / IM patch.
 */
export function stripLeakedThinkingContent(text: string): string {
  if (!text) return text;
  // 1. Remove fully-closed blocks
  let r = text.replace(THINKING_TAGS_RE, '');
  // 2. Remove unclosed tag at end (still streaming)
  r = r.replace(UNCLOSED_THINKING_RE, '');
  // 3. Remove orphaned closing tags
  r = r.replace(ORPHAN_CLOSE_THINKING_RE, '');
  return r;
}

// ---------------------------------------------------------------------------
// sanitizeCardKitMarkdown — prevent streaming truncation
// ---------------------------------------------------------------------------

/**
 * Sanitize markdown for CardKit streaming to prevent rendering breakage
 * from incomplete markdown in mid-stream snapshots:
 *
 * 1. Balance triple-backtick fences (close unclosed code blocks)
 * 2. Balance inline backticks (outside fenced code blocks)
 * 3. Escape bare angle brackets outside any code context
 *
 * Uses a segment-based approach instead of sentinels to correctly handle
 * angle brackets inside inline code spans.
 */
export function sanitizeCardKitMarkdown(text: string): string {
  if (!text) return text;

  // ── Step 1: Balance triple-backtick fences ───────────────────────────
  const fenceRe = /^```/gm;
  const fenceCount = (text.match(fenceRe) || []).length;
  let r = text;
  if (fenceCount % 2 !== 0) {
    r += '\n```';
  }

  // ── Step 2 & 3: Process content outside fenced code blocks ───────────
  // Split by fenced code blocks, process only non-code segments
  const parts = r.split(/(```[\s\S]*?```)/g);
  for (let i = 0; i < parts.length; i++) {
    // Odd indices are fenced code blocks — skip
    if (i % 2 === 1) continue;
    parts[i] = sanitizeInlineSegment(parts[i]);
  }
  return parts.join('');
}

/**
 * Process a segment that is NOT inside a fenced code block:
 * - Balance inline backticks
 * - Escape bare `<` outside inline code spans
 *
 * Inline code spans follow CommonMark rules: a run of N backticks opens
 * a code span that is closed by the next run of exactly N backticks.
 * E.g. `` `code` ``, ``` ``code with `backtick` inside`` ```.
 */
function sanitizeInlineSegment(segment: string): string {
  // Count inline backticks to check balance
  const backtickCount = (segment.match(/`/g) || []).length;
  let result = segment;

  if (backtickCount % 2 !== 0) {
    // Append closing backtick to balance
    result += '`';
  }

  // Escape bare angle brackets outside inline code spans.
  // Walk through the text, properly handling multi-backtick code spans.
  const output: string[] = [];
  let pos = 0;

  while (pos < result.length) {
    // Check for backtick run (start of inline code span)
    if (result[pos] === '`') {
      // Count the opening backtick run length
      let openLen = 0;
      const runStart = pos;
      while (pos < result.length && result[pos] === '`') {
        openLen++;
        pos++;
      }
      // Look for a matching closing run of exactly the same length
      const closePattern = '`'.repeat(openLen);
      const closeIdx = findClosingBacktickRun(result, pos, openLen);
      if (closeIdx !== -1) {
        // Found matching close — emit the entire code span as-is
        output.push(result.slice(runStart, closeIdx + openLen));
        pos = closeIdx + openLen;
      } else {
        // No matching close — emit the backticks as literal text
        output.push(closePattern);
        // Continue processing (pos already advanced past the backticks)
      }
    } else if (result[pos] === '<') {
      // Check if this looks like a known safe HTML tag (br, img)
      const rest = result.slice(pos);
      if (/^<\/?(?:br|img)\s*\/?>/.test(rest)) {
        // Known safe tag — keep as-is
        const tagMatch = rest.match(/^<\/?(?:br|img)\s*\/?>/);
        if (tagMatch) {
          output.push(tagMatch[0]);
          pos += tagMatch[0].length;
          continue;
        }
      }
      output.push('&lt;');
      pos++;
    } else {
      output.push(result[pos]);
      pos++;
    }
  }

  return output.join('');
}

/**
 * Find the position of a closing backtick run of exactly `runLen` backticks,
 * starting the search from `startPos`. Returns the index of the first
 * backtick of the closing run, or -1 if not found.
 */
function findClosingBacktickRun(text: string, startPos: number, runLen: number): number {
  let pos = startPos;
  while (pos < text.length) {
    if (text[pos] === '`') {
      let len = 0;
      const start = pos;
      while (pos < text.length && text[pos] === '`') {
        len++;
        pos++;
      }
      if (len === runLen) return start;
      // Otherwise, this run doesn't match — keep searching
    } else {
      pos++;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// stripInvalidImageKeys
// ---------------------------------------------------------------------------

/** Matches complete markdown image syntax: `![alt](value)` */
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

/**
 * Strip `![alt](value)` where value is not a valid Feishu image key
 * (`img_xxx`). Prevents CardKit error 200570.
 *
 * HTTP URLs are stripped as well — ImageResolver should have already
 * replaced them with `img_xxx` keys before this point. This serves
 * as a safety net for any unresolved URLs.
 */
function stripInvalidImageKeys(text: string): string {
  if (!text.includes('![')) return text;
  return text.replace(IMAGE_RE, (fullMatch, _alt, value) => {
    if (value.startsWith('img_')) return fullMatch;
    return ''; // strip all non-img_ image references (URLs, local paths, etc.)
  });
}
