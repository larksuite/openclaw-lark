/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Converter for "share_chat" and "share_user" message types.
 */

import type { ContentConverterFn } from './types';
import { safeParse } from './utils';

export const convertShareChat: ContentConverterFn = (raw) => {
  const parsed = safeParse(raw) as { chat_id?: string } | undefined;
  const chatId = parsed?.chat_id ?? '';

  return {
    content: `<group_card id="${chatId}"/>`,
    resources: [],
  };
};

export const convertShareUser: ContentConverterFn = (raw) => {
  const parsed = safeParse(raw) as { user_id?: string } | undefined;
  const userId = parsed?.user_id ?? '';

  return {
    content: `<contact_card id="${userId}"/>`,
    resources: [],
  };
};
