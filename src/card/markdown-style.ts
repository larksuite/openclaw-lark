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
  let r = text.replace(/```[\s\S]*?```/g, (m) => {
    return `${MARK}${codeBlocks.push(m) - 1}___`;
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
    // 4c. 表格后：在表格块末尾追加 <br>
    r = r.replace(/((?:^\|.+\|[^\S\n]*\n?)+)/gm, '$1\n<br>\n');
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
