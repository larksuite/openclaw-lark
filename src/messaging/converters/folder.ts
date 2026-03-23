/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Converter for "folder" message type.
 */

import type { ContentConverterFn } from './types';
import { safeParse } from './utils';

export const convertFolder: ContentConverterFn = (raw) => {
  const parsed = safeParse(raw) as
    | {
        file_key?: string;
        file_name?: string;
      }
    | undefined;

  const fileKey = parsed?.file_key;
  if (!fileKey) {
    return { content: '[folder]', resources: [] };
  }

  const fileName = parsed?.file_name ?? '';
  const nameAttr = fileName ? ` name="${fileName}"` : '';

  return {
    content: `<folder key="${fileKey}"${nameAttr}/>`,
    resources: [],
  };
};
