/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Shared types for the content converter system.
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import type { LarkAccount } from '../../core/types';
import type { MentionInfo, ResourceDescriptor } from '../types';

/**
 * Shape of a message item returned by the Feishu IM API.
 *
 * Used by `buildConvertContextFromItem` (content-converter) and the
 * `merge_forward` converter to process sub-messages and history items
 * without resorting to `any`.
 */
export interface ApiMessageItem {
  message_id?: string;
  msg_type?: string;
  create_time?: string;
  upper_message_id?: string;
  body?: { content?: string };
  sender?: {
    id?: string;
    sender_type?: string;
  };
  mentions?: Array<{
    key: string;
    id: unknown;
    name?: string;
  }>;
  parent_id?: string;
  thread_id?: string;
  deleted?: boolean;
  updated?: boolean;
}

/** Context passed to every converter function. */
export interface ConvertContext {
  /** Map from placeholder key ("@_user_X") to structured mention info. */
  mentions: Map<string, MentionInfo>;
  /** Reverse map from openId to MentionInfo for O(1) lookup. */
  mentionsByOpenId: Map<string, MentionInfo>;
  messageId: string;
  botOpenId?: string;
  /** Plugin config — retained for non-converter downstream consumers. */
  cfg?: ClawdbotConfig;
  /**
   * Pre-resolved account — retained for non-converter downstream consumers.
   * merge_forward no longer reads this; it uses injected callbacks instead.
   */
  account?: LarkAccount;
  /** Account identifier for multi-account setups. */
  accountId?: string;
  /** Synchronous lookup of cached user display name by openId. */
  resolveUserName?: (openId: string) => string | undefined;
  /**
   * Async batch name resolution callback.
   *
   * Called by merge_forward to resolve sub-message sender names.
   * The callback should populate whatever cache `resolveUserName` reads from.
   * All callers must inject this; merge_forward has no internal fallback.
   */
  batchResolveNames?: (openIds: string[]) => Promise<void>;
  /**
   * Async callback to fetch sub-messages of a merge_forward container.
   *
   * Returns the flat items array from the IM API response.
   * All callers must inject this; merge_forward has no internal fallback
   * and returns `<forwarded_messages/>` when not provided.
   */
  fetchSubMessages?: (messageId: string) => Promise<ApiMessageItem[]>;
  /** 是否删除机器人 mention（事件推送场景=true，历史消息读取=false） */
  stripBotMentions?: boolean;
}

/** Result produced by a converter function. */
export interface ConvertResult {
  /** AI-friendly formatted text. */
  content: string;
  /** Resource descriptors (images, files, audio, video, stickers). */
  resources: ResourceDescriptor[];
}

/**
 * Converter function for a single message type.
 *
 * May return a ConvertResult synchronously or a Promise for types that
 * require async operations (e.g. merge_forward expansion via API).
 */
export type ContentConverterFn = (raw: string, ctx: ConvertContext) => ConvertResult | Promise<ConvertResult>;

/**
 * Element within a Feishu "post" (rich text) content block.
 *
 * Shared by the `post` and `todo` converters.
 */
export interface PostElement {
  tag: string;
  text?: string;
  href?: string;
  image_key?: string;
  file_key?: string;
  user_id?: string;
  user_name?: string;
  style?: string[];
  language?: string;
  un_escape?: boolean;
}
