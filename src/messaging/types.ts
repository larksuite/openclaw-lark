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

// ---------------------------------------------------------------------------
// Bitable record changed event
// ---------------------------------------------------------------------------

/** A single field value in a bitable record action. */
export interface FeishuBitableFieldValue {
  field_id: string;
  /** JSON-serialised field value string. Deserialise with JSON.parse() for the actual value. */
  field_value: string;
  field_identity_value?: {
    users?: Array<{
      user_id?: { union_id?: string; user_id?: string; open_id?: string };
      name?: string;
      en_name?: string;
      avatar_url?: string;
    }>;
  };
}

/** A single record action (edit / add / delete) in a bitable record changed event. */
export interface FeishuBitableRecordAction {
  record_id: string;
  /** "record_edited" | "record_added" | "record_deleted" */
  action: string;
  before_value?: FeishuBitableFieldValue[];
  after_value?: FeishuBitableFieldValue[];
}

/**
 * Event payload for `drive.file.bitable_record_changed_v1`.
 *
 * The SDK's EventDispatcher delivers the `event` sub-object directly as the
 * handler data, so the top-level fields here map to `event.*` in the raw
 * webhook body.
 */
export interface FeishuBitableRecordChangedEvent {
  /** Always "bitable". */
  file_type: string;
  /** The bitable app token (table file token). */
  file_token: string;
  /** ID of the data-table where the change occurred. */
  table_id: string;
  /** Revision number of the table after the change. */
  revision?: number;
  /** The user who triggered the change. */
  operator_id?: {
    union_id?: string;
    user_id?: string;
    open_id?: string;
  };
  /** List of record-level actions (edit / add / delete). */
  action_list?: FeishuBitableRecordAction[];
  /** Users subscribed to this bitable. */
  subscriber_id_list?: Array<{ union_id?: string; user_id?: string; open_id?: string }>;
  /** Unix timestamp (seconds) of the edit. */
  update_time?: number;
  /** Available when event is delivered via the SDK dispatcher (v2 envelope). */
  app_id?: string;
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
