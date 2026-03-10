/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Message fetching re-exports for backward compatibility.
 *
 * The actual implementations have been moved to:
 * - `getMessageFeishu` / `FeishuMessageInfo` → `../shared/message-lookup.ts`
 * - `getChatTypeFeishu` → `../../core/chat-info-cache.ts`
 */

export { getMessageFeishu, type FeishuMessageInfo } from '../shared/message-lookup';
export { getChatTypeFeishu } from '../../core/chat-info-cache';
