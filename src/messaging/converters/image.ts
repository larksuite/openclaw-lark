/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Converter for "image" message type.
 */

import type { ContentConverterFn } from './types';
import { safeParse } from './utils';

export const convertImage: ContentConverterFn = (raw) => {
  const parsed = safeParse(raw) as { image_key?: string } | undefined;
  const imageKey = parsed?.image_key;

  if (!imageKey) {
    return { content: '[image]', resources: [] };
  }

  return {
    content: `![image](${imageKey})`,
    resources: [{ type: 'image', fileKey: imageKey }],
  };
};
