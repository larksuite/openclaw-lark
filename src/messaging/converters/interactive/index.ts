/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Entry point for the interactive (card) message converter.
 */

import type { ContentConverterFn } from '../types';
import { safeParse } from '../utils';
import type { Obj, RawCardContent } from './types';
import { CardConverter, MODE } from './card-converter';
import { convertLegacyCard } from './legacy';

export const convertInteractive: ContentConverterFn = (raw) => {
  const parsed = safeParse(raw) as Obj | undefined;
  if (!parsed) {
    return { content: '[interactive card]', resources: [] };
  }

  if (typeof parsed.json_card === 'string') {
    const converter = new CardConverter(MODE.Concise);
    const result = converter.convert(parsed as unknown as RawCardContent);
    return { content: result.content || '[interactive card]', resources: [] };
  }

  return convertLegacyCard(parsed);
};
