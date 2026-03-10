/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Fallback converter for unsupported message types.
 */

import type { ContentConverterFn } from './types';
import { safeParse } from './utils';

export const convertUnknown: ContentConverterFn = (raw) => {
  const parsed = safeParse(raw);
  if (parsed != null && typeof parsed === 'object' && 'text' in parsed) {
    const text = (parsed as Record<string, unknown>).text;
    if (typeof text === 'string') return { content: text, resources: [] };
  }
  return { content: '[unsupported message]', resources: [] };
};
