/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Messaging type definitions for the Lark/Feishu channel plugin.
 *
 * Pure shape types for inbound message events, normalised message context,
 * mention targets, and media metadata.
 */

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface FeishuMessageEvent {
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    create_time?: string;
    update_time?: string;
    chat_id: string;
    thread_id?: string;
    chat_type: 'p2p' | 'group';
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: {
        open_id?: string;
        user_id?: string;
        union_id?: string;
      };
      name: string;
      tenant_key?: string;
    }>;
    user_agent?: string;
  };
}

export interface FeishuReactionCreatedEvent {
  message_id: string;
  chat_id?: string;
  chat_type?: 'p2p' | 'group' | 'private';
  reaction_type?: { emoji_type?: string };
  operator_type?: string;
  user_id?: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  action_time?: string;
}

/**
 * Raw event shape for `drive.notice.comment_add_v1`.
 *
 * Fired when a user adds a comment or reply on a Drive document.
 * The SDK flattens the v2 envelope header into the handler `data` object,
 * so `app_id` is available directly on the event.
 *
 * **Real event structure** (SDK-flattened):
 * ```json
 * {
 *   "app_id": "cli_xxx",
 *   "file_token": "xxx",
 *   "file_type": "docx",
 *   "comment_id": "xxx",
 *   "reply_id": "xxx",          // optional, present for replies
 *   "notice_meta": {
 *     "from_user_id": { "open_id": "ou_xxx", "user_id": "xxx", "union_id": "xxx" },
 *     "timestamp": "1712000000000",
 *     "is_mentioned": true
 *   }
 * }
 * ```
 *
 * Some fields may also appear at top-level depending on SDK version,
 * so the parser checks both locations.
 */
export interface FeishuDriveCommentEvent {
  /** App ID from the event envelope header. */
  app_id?: string;
  /** File token of the document where the comment was added. */
  file_token?: string;
  /** File type: doc, docx, sheet, file, slides, etc. */
  file_type?: string;
  /** Comment ID of the root comment. */
  comment_id?: string;
  /** Reply ID (present when the event is a reply, not a root comment). */
  reply_id?: string;
  /**
   * Metadata about the notice — primary location for user info and timestamp.
   * Present in the real event structure; not always at top level.
   */
  notice_meta?: {
    from_user_id?: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    file_token?: string;
    file_type?: string;
    timestamp?: string;
    is_mentioned?: boolean;
  };
  // --- Fallback top-level fields (legacy / some SDK versions) ---
  /** Whether the bot was @-mentioned in this comment. */
  is_mention?: boolean;
  /** Fallback: user ID at top level (some SDK flattening styles). */
  user_id?: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  /** Fallback: event timestamp at top level. */
  action_time?: string;
}

export interface FeishuBotAddedEvent {
  chat_id: string;
  operator_id: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  external: boolean;
  operator_tenant_key?: string;
  name?: string;
  i18n_names?: {
    zh_cn?: string;
    en_us?: string;
    ja_jp?: string;
  };
}

// ---------------------------------------------------------------------------
// Resource descriptor
// ---------------------------------------------------------------------------

/** Metadata describing a media resource in a message (no binary data). */
export interface ResourceDescriptor {
  type: 'image' | 'file' | 'audio' | 'video' | 'sticker';
  /** image_key or file_key from the raw message content. */
  fileKey: string;
  /** Original file name (file/video messages). */
  fileName?: string;
  /** Duration in milliseconds (audio/video messages). */
  duration?: number;
  /** Video cover image key. */
  coverImageKey?: string;
}

// ---------------------------------------------------------------------------
// Mention info
// ---------------------------------------------------------------------------

/** Structured @mention information from a message. */
export interface MentionInfo {
  /** Placeholder key in raw content (e.g. "@_user_1"). */
  key: string;
  /** Feishu Open ID of the mentioned user. */
  openId: string;
  /** Display name. */
  name: string;
  /** Whether this mention targets the bot itself. */
  isBot: boolean;
}

// ---------------------------------------------------------------------------
// Inbound message context
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Raw event data (shape-mapped from FeishuMessageEvent)
// ---------------------------------------------------------------------------

/** Raw message body, directly mapped from FeishuMessageEvent.message. */
export interface RawMessage {
  message_id: string;
  root_id?: string;
  parent_id?: string;
  create_time?: string;
  update_time?: string;
  chat_id: string;
  thread_id?: string;
  chat_type: 'p2p' | 'group';
  message_type: string;
  content: string;
  mentions?: Array<{
    key: string;
    id: { open_id?: string; user_id?: string; union_id?: string };
    name: string;
    tenant_key?: string;
  }>;
  user_agent?: string;
}

/** Raw sender data, directly mapped from FeishuMessageEvent.sender. */
export interface RawSender {
  sender_id: { open_id?: string; user_id?: string; union_id?: string };
  sender_type?: string;
  tenant_key?: string;
}

// ---------------------------------------------------------------------------
// Normalised inbound message context
// ---------------------------------------------------------------------------

/** Normalised representation of an inbound Feishu message. */
export interface MessageContext {
  // Core identifiers
  chatId: string;
  messageId: string;
  senderId: string;
  senderName?: string;
  chatType: 'p2p' | 'group';

  // Message content
  content: string;
  contentType: string;

  /** Media resource descriptors extracted during parsing. */
  resources: ResourceDescriptor[];
  /** All @mentions in the message (including bot). */
  mentions: MentionInfo[];
  /** Whether an @all / @所有人 mention was detected in the message. */
  mentionAll: boolean;

  // Message relationships
  rootId?: string;
  parentId?: string;
  threadId?: string;

  // Timing
  createTime?: number;

  // Raw event data
  rawMessage: RawMessage;
  rawSender: RawSender;
}

/** @deprecated Use {@link MessageContext} instead. */
export type FeishuMessageContext = MessageContext;

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

/** Metadata about a media attachment received in or sent through Feishu. */
export interface FeishuMediaInfo {
  path: string;
  contentType?: string;
  placeholder: string;
  /** Original Feishu file_key / image_key that was downloaded. */
  fileKey: string;
  /** Resource type from the original descriptor. */
  resourceType: ResourceDescriptor['type'];
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

/** Result of sending a message via the Feishu API. */
export interface FeishuSendResult {
  messageId: string;
  chatId: string;
  /**
   * Human-readable warning when the send succeeded but with degradation
   * (e.g. media upload failed, fell back to a text link).
   *
   * Populated so upstream callers (and the AI) can detect that the
   * delivery was not fully as intended and take corrective action.
   */
  warning?: string;
}
