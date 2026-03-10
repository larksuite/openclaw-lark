/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Converter for "vote" message type.
 */

import type { ContentConverterFn } from './types';
import { safeParse } from './utils';

export const convertVote: ContentConverterFn = (raw) => {
  const parsed = safeParse(raw) as
    | {
        topic?: string;
        options?: string[];
      }
    | undefined;

  const topic = parsed?.topic ?? '';
  const options = parsed?.options ?? [];

  const parts: string[] = [];

  if (topic) {
    parts.push(topic);
  }

  for (const opt of options) {
    parts.push(`• ${opt}`);
  }

  const inner = parts.join('\n') || '[vote]';

  return {
    content: `<vote>\n${inner}\n</vote>`,
    resources: [],
  };
};
