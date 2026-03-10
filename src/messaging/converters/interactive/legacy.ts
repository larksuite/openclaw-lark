/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Legacy card converter for non-raw_card_content format.
 */

import type { Obj } from './types';

export function convertLegacyCard(parsed: Obj): { content: string; resources: never[] } {
  const texts: string[] = [];

  const header = parsed.header as Obj | undefined;
  if (header) {
    const title = header.title as Obj | undefined;
    if (title && typeof title.content === 'string') {
      texts.push(`**${title.content}**`);
    }
  }

  const body = parsed.body as Obj | undefined;
  const elements = (parsed.elements ?? body?.elements ?? []) as unknown[];
  extractTexts(elements, texts);

  const content = texts.length > 0 ? texts.join('\n') : '[interactive card]';
  return { content, resources: [] };
}

function extractTexts(elements: unknown[], out: string[]): void {
  if (!Array.isArray(elements)) return;

  for (const el of elements) {
    if (typeof el !== 'object' || el === null) continue;
    const elem = el as Obj;

    if (elem.tag === 'markdown' && typeof elem.content === 'string') {
      out.push(elem.content);
      continue;
    }

    if (elem.tag === 'div' || elem.tag === 'plain_text' || elem.tag === 'lark_md') {
      const text = elem.text as Obj | undefined;
      if (text?.content && typeof text.content === 'string') {
        out.push(text.content);
      }
      if (typeof elem.content === 'string') {
        out.push(elem.content);
      }
    }

    if (elem.tag === 'column_set') {
      const columns = elem.columns as unknown[] | undefined;
      if (columns) {
        for (const col of columns) {
          const colObj = col as Obj;
          if (colObj.elements) {
            extractTexts(colObj.elements as unknown[], out);
          }
        }
      }
    }

    if (elem.elements) {
      extractTexts(elem.elements as unknown[], out);
    }
  }
}
