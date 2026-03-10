/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Converter for "video_chat" message type.
 */

import type { ContentConverterFn } from './types';
import { safeParse, millisToDatetime } from './utils';

export const convertVideoChat: ContentConverterFn = (raw) => {
  const parsed = safeParse(raw) as
    | {
        topic?: string;
        start_time?: string;
      }
    | undefined;

  const topic = parsed?.topic ?? '';
  const parts: string[] = [];

  if (topic) {
    parts.push(`📹 ${topic}`);
  }

  if (parsed?.start_time) {
    parts.push(`🕙 ${millisToDatetime(parsed.start_time)}`);
  }

  const inner = parts.join('\n') || '[video chat]';

  return {
    content: `<meeting>${inner}</meeting>`,
    resources: [],
  };
};
