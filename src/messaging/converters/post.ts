/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Converter for "post" (rich text) message type.
 *
 * Preserves structure as Markdown: links as `[text](href)`,
 * images as `![image](key)`, code blocks, and mention resolution.
 */

import { larkLogger } from '../../core/lark-logger';
import type { ResourceDescriptor } from '../types';
import type { ContentConverterFn, ConvertContext, PostElement } from './types';
import { resolveMentions } from './content-converter-helpers';
import { safeParse } from './utils';

const log = larkLogger('converters/post');

/** Preferred locale order for multi-language post unwrapping. */
const LOCALE_PRIORITY = ['zh_cn', 'en_us', 'ja_jp'] as const;

/**
 * Scan token for native markdown: a code region to SKIP, OR an image to intercept.
 * Group 1 (code region) matches first so `![alt](key)` inside code is consumed
 * verbatim and never intercepted:
 *   - fenced block: ```...``` or ~~~...~~~ (multi-line, lazy)
 *   - inline span:  ``...`` or `...` (single-line)
 * Group 2 (alt) + Group 3 (target) are the image when no code region matched.
 */
const MD_SCAN_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|``[\s\S]*?``|`[^`\n]*`)|!\[([^\]]*)\]\(([^)]+)\)/g;
/** Feishu image_key prefix (aligned with markdown-style.ts stripInvalidImageKeys & case 'img'). */
const FEISHU_IMAGE_KEY_RE = /^img_/;
/**
 * Inbound native-markdown size ceiling (chars). Guards against pathological
 * posts (huge tables / deep nesting) blowing up memory/token before the
 * downstream chunker runs. One order above the outbound chunk magnitude
 * (outbound default 15000). Tunable; per-account config override is a follow-up.
 */
const MAX_INBOUND_MD_LEN = 100_000;

interface PostBody {
  title?: string;
  content?: PostElement[][];
  content_v2?: PostElement[][];
}

/**
 * Unwrap a parsed post object that may be locale-wrapped.
 *
 * Feishu post messages come in two shapes:
 *   - Flat:   `{ title, content }`
 *   - Locale: `{ zh_cn: { title, content }, en_us: { title, content } }`
 */
function unwrapLocale(parsed: Record<string, unknown>): PostBody | undefined {
  if ('title' in parsed || 'content' in parsed || 'content_v2' in parsed) {
    return parsed as unknown as PostBody;
  }

  for (const locale of LOCALE_PRIORITY) {
    const localeData = parsed[locale];
    if (localeData != null && typeof localeData === 'object') {
      return localeData as PostBody;
    }
  }

  const firstKey = Object.keys(parsed)[0];
  if (firstKey) {
    const firstValue = parsed[firstKey];
    if (firstValue != null && typeof firstValue === 'object') {
      return firstValue as PostBody;
    }
  }

  return undefined;
}

export const convertPost: ContentConverterFn = (raw, ctx) => {
  const rawParsed = safeParse(raw);
  if (rawParsed == null || typeof rawParsed !== 'object') {
    return { content: '[rich text message]', resources: [] };
  }

  const parsed = unwrapLocale(rawParsed as Record<string, unknown>);
  if (!parsed) {
    return { content: '[rich text message]', resources: [] };
  }

  const resources: ResourceDescriptor[] = [];
  const lines: string[] = [];
  const seenFileKeys = new Set<string>();

  // Title
  if (parsed.title) {
    lines.push(`**${parsed.title}**`, '');
  }

  const v2 = parsed.content_v2;
  const usedV2 = Array.isArray(v2) && v2.length > 0;
  const contentBlocks = usedV2 ? v2 : (parsed.content ?? []);
  log.info('post content source selected', {
    messageId: ctx.messageId,
    source: usedV2 ? 'content_v2' : 'content',
    hasV2: Array.isArray(v2),
    v2Len: Array.isArray(v2) ? v2.length : 0,
  });

  for (const paragraph of contentBlocks) {
    if (!Array.isArray(paragraph)) continue;

    let line = '';
    for (const el of paragraph) {
      line += renderElement(el, ctx, resources, seenFileKeys);
    }
    lines.push(line);
  }

  let content = lines.join('\n').trim() || '[rich text message]';
  content = resolveMentions(content, ctx);
  content = capInboundLength(content, resources);

  return { content, resources };
};

function renderElement(
  el: PostElement,
  ctx: ConvertContext,
  resources: ResourceDescriptor[],
  seenFileKeys: Set<string>,
): string {
  switch (el.tag) {
    case 'text': {
      let text = el.text ?? '';
      text = applyStyle(text, el.style);
      return text;
    }
    case 'a': {
      const text = el.text ?? el.href ?? '';
      return el.href ? `[${text}](${el.href})` : text;
    }
    case 'at': {
      // At-mention in post — use placeholder key if available via context,
      // otherwise fall back to @user_name.
      const userId = el.user_id ?? '';
      if (userId === 'all') return '@all';
      const name = el.user_name ?? userId;
      // O(1) lookup via reverse map
      const info = ctx.mentionsByOpenId.get(userId);
      if (info) {
        // Let resolveMentions handle it — return the placeholder key
        return info.key;
      }
      return `@${name}`;
    }
    case 'img': {
      if (el.image_key) {
        resources.push({ type: 'image', fileKey: el.image_key });
        return `![image](${el.image_key})`;
      }
      return '';
    }
    case 'media': {
      if (el.file_key) {
        resources.push({ type: 'file', fileKey: el.file_key });
        return `<file key="${el.file_key}"/>`;
      }
      return '';
    }
    case 'md': {
      return renderInlineImages(el.text ?? '', resources, seenFileKeys);
    }
    case 'code_block': {
      const lang = el.language ?? '';
      const code = el.text ?? '';
      return `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
    }
    case 'hr':
      return '\n---\n';
    default:
      return el.text ?? '';
  }
}

function applyStyle(text: string, style?: string[]): string {
  if (!style || style.length === 0) return text;
  let result = text;
  if (style.includes('bold')) result = `**${result}**`;
  if (style.includes('italic')) result = `*${result}*`;
  if (style.includes('underline')) result = `<u>${result}</u>`;
  if (style.includes('lineThrough')) result = `~~${result}~~`;
  if (style.includes('codeInline')) result = `\`${result}\``;
  return result;
}

/**
 * Scan native markdown for `![alt](target)` and intercept feishu image_keys.
 * - target matches `^img_` → register a downloadable resource (Set-deduped) and
 *   normalize the FIRST occurrence to `![image](key)` (the only form
 *   substituteMediaPaths can replace); later occurrences of the same key collapse
 *   to sanitized alt text so no bare key / un-replaceable marker leaks downstream.
 * - everything else (https/http, data:, protocol-relative, relative/anchor) is kept
 *   verbatim and never downloaded.
 * Image syntax inside a code region (fenced block or inline span) is left verbatim
 * and never intercepted — code is shown as-is, not rendered.
 */
function renderInlineImages(md: string, resources: ResourceDescriptor[], seen: Set<string>): string {
  return md.replace(MD_SCAN_RE, (whole, codeRegion: string | undefined, alt: string, target: string) => {
    if (codeRegion !== undefined) {
      return whole; // fenced block / inline code → keep verbatim, never intercept
    }
    if (!FEISHU_IMAGE_KEY_RE.test(target)) {
      return whole;
    }
    if (!seen.has(target)) {
      seen.add(target);
      resources.push({ type: 'image', fileKey: target });
      return `![image](${target})`;
    }
    return sanitizeAlt(alt);
  });
}

/** Strip nested image syntax and bare feishu keys from alt so it cannot be
 *  re-matched by substituteMediaPaths nor inject UGC markers. */
function sanitizeAlt(alt: string): string {
  return alt
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/img_[A-Za-z0-9_-]+/g, '')
    .trim();
}

/**
 * Cap inbound text length at a safe boundary (never split an `![image](key)`
 * marker), tag `[truncated]`, and drop image resources whose marker fell off the
 * end so we never register an orphan download with no in-text marker.
 */
function capInboundLength(content: string, resources: ResourceDescriptor[]): string {
  if (content.length <= MAX_INBOUND_MD_LEN) return content;

  let cut = content.lastIndexOf('\n', MAX_INBOUND_MD_LEN);
  if (cut <= 0) {
    // Single huge line: back off so we never cut inside an image marker.
    cut = MAX_INBOUND_MD_LEN;
    const markerStart = content.lastIndexOf('![image](', cut);
    if (markerStart !== -1) {
      const markerEnd = content.indexOf(')', markerStart);
      if (markerEnd === -1 || markerEnd >= cut) cut = markerStart;
    }
  }

  const truncated = `${content.slice(0, cut).replace(/\s+$/, '')}\n[truncated]`;
  for (let i = resources.length - 1; i >= 0; i--) {
    const r = resources[i];
    if (r.type === 'image' && !truncated.includes(`![image](${r.fileKey})`)) {
      resources.splice(i, 1);
    }
  }
  return truncated;
}
