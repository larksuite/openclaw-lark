/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Converter for "text" message type.
 */

import type { ContentConverterFn } from './types';
import { resolveMentions } from './content-converter';
import { safeParse } from './utils';

export const convertText: ContentConverterFn = (raw, ctx) => {
  const parsed = safeParse(raw) as { text?: string } | undefined;
  const text = parsed?.text ?? raw;
  const content = resolveMentions(text, ctx);
  return { content, resources: [] };
};
