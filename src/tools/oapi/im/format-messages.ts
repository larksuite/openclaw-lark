/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * 消息格式化公共函数
 *
 * 将飞书 IM API 返回的原始消息对象转换为 AI 可读的 JSON 格式。
 * 由 feishu_im_user_get_messages 和 feishu_im_user_get_thread_messages 共享。
 *
 * 所有 API 调用均通过 UAT（用户身份）进行。
 */

import type { LarkAccount } from '../../../core/types';
import type { ToolClient } from '../../../core/tool-client';
import type { ApiMessageItem } from '../../../messaging/converters/types';
import { larkLogger } from '../../../core/lark-logger';
import {
  convertMessageContent,
  buildConvertContextFromItem,
  extractMentionOpenId,
} from '../../../messaging/converters/content-converter';
import { getUATUserName, setUATUserNames, batchResolveUserNamesAsUser } from './user-name-uat';
import { millisStringToDateTime } from './time-utils';

const log = larkLogger('oapi/im/format-messages');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FormattedMessage {
  message_id: string;
  msg_type: string;
  content: string;
  sender: { id: string; sender_type: string; name?: string };
  create_time: string;
  /** 回复的消息 ID（parent_id）。有 thread_id 时省略，因为话题上下文可推断 */
  reply_to?: string;
  thread_id?: string;
  mentions?: Array<{ key: string; id: string; name: string }>;
  deleted: boolean;
  updated: boolean;
}

// ---------------------------------------------------------------------------
// UAT callbacks for merge_forward expansion
// ---------------------------------------------------------------------------

/** 通过 UAT 获取合并转发子消息 */
function createUATFetchSubMessages(client: ToolClient) {
  return async (messageId: string): Promise<ApiMessageItem[]> => {
    const res = await client.invokeByPath<{
      code?: number;
      msg?: string;
      data?: { items?: ApiMessageItem[] };
    }>('feishu_im_user_get_messages.default', `/open-apis/im/v1/messages/${messageId}`, {
      method: 'GET',
      query: { user_id_type: 'open_id', card_msg_content_type: 'raw_card_content' },
      as: 'user',
    });
    if (res.code !== 0) {
      throw new Error(`API error: code=${res.code} msg=${res.msg}`);
    }
    return res.data?.items ?? [];
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 格式化单条消息对象。
 *
 * 使用 convertMessageContent 将 body.content 转为 AI 可读文本，
 * 并过滤掉 AI 不需要的字段（upper_message_id、tenant_key 等）。
 */
export async function formatMessageItem(
  item: ApiMessageItem,
  accountId: string,
  nameResolver: (openId: string) => string | undefined,
  ctxOverrides?: Partial<import('../../../messaging/converters/types.js').ConvertContext>,
): Promise<FormattedMessage> {
  const messageId: string = item.message_id ?? '';
  const msgType: string = item.msg_type ?? 'unknown';

  // 使用 converter 处理消息内容
  let content = '';
  try {
    const rawContent: string = item.body?.content ?? '';
    if (rawContent) {
      const ctx = {
        ...buildConvertContextFromItem(item, messageId, accountId),
        ...ctxOverrides,
      };
      const result = await convertMessageContent(rawContent, msgType, ctx);
      content = result.content;
    }
  } catch (err) {
    log.warn('converter failed, falling back to raw content', {
      messageId,
      msgType,
      error: err instanceof Error ? err.message : String(err),
    });
    content = item.body?.content ?? '';
  }

  // 构建 sender（从 UAT 缓存中读取名字）
  const senderId: string = item.sender?.id ?? '';
  const senderType: string = item.sender?.sender_type ?? 'unknown';
  let senderName: string | undefined;
  if (senderId && senderType === 'user') {
    senderName = nameResolver(senderId);
  }

  const sender: FormattedMessage['sender'] = {
    id: senderId,
    sender_type: senderType,
  };
  if (senderName) {
    sender.name = senderName;
  }

  // 构建 mentions（简化格式）
  let mentions: FormattedMessage['mentions'];
  if (item.mentions && item.mentions.length > 0) {
    mentions = item.mentions.map((m) => ({
      key: m.key ?? '',
      id: extractMentionOpenId(m.id),
      name: m.name ?? '',
    }));
  }

  // 转换 create_time（飞书 API 返回毫秒时间戳字符串 → ISO 8601 +08:00）
  const createTime = item.create_time ? millisStringToDateTime(item.create_time) : '';

  const formatted: FormattedMessage = {
    message_id: messageId,
    msg_type: msgType,
    content,
    sender,
    create_time: createTime,
    deleted: item.deleted ?? false,
    updated: item.updated ?? false,
  };

  // 可选字段
  // reply_to（parent_id）和 thread_id 的展示逻辑参考 Go MCP：
  // - 有 thread_id 时只展示 thread_id，省略 reply_to（话题上下文可推断）
  // - 无 thread_id 但有 parent_id 时，展示为 reply_to
  if (item.thread_id) {
    formatted.thread_id = item.thread_id;
  } else if (item.parent_id) {
    formatted.reply_to = item.parent_id;
  }
  if (mentions) {
    formatted.mentions = mentions;
  }

  return formatted;
}

/**
 * 批量格式化消息列表（UAT 路径）。
 *
 * 先批量解析所有 sender 的名字（写入 UAT 缓存），再逐条格式化。
 * 这样 formatMessageItem 中的 sender.name 和 converter 的
 * resolveUserName 都能从 UAT 缓存中读到名字。
 */
export async function formatMessageList(
  items: ApiMessageItem[],
  account: LarkAccount,
  log: (...args: unknown[]) => void,
  client: ToolClient,
): Promise<FormattedMessage[]> {
  const accountId = account.accountId;
  const nameResolver = (openId: string) => getUATUserName(accountId, openId);

  // 1. 把 mention 自带的名字写入 UAT 缓存（免费信息）
  const mentionNames = new Map<string, string>();
  for (const item of items) {
    for (const m of item.mentions ?? []) {
      const openId = extractMentionOpenId(m.id);
      if (openId && m.name) {
        mentionNames.set(openId, m.name);
      }
    }
  }
  if (mentionNames.size > 0) {
    setUATUserNames(accountId, mentionNames);
  }

  // 2. 收集所有 user 类型 sender 的 open_id
  const senderIds = [
    ...new Set(
      items
        .map((item) => (item.sender?.sender_type === 'user' ? item.sender.id : undefined))
        .filter((id): id is string => !!id),
    ),
  ];

  // 3. 批量解析 UAT 缓存中缺失的名字
  if (senderIds.length > 0) {
    const missing = senderIds.filter((id) => getUATUserName(accountId, id) === undefined);
    if (missing.length > 0) {
      await batchResolveUserNamesAsUser({ client, openIds: missing, log });
    }
  }

  // 4. 构建 merge_forward 展开所需的回调
  const uatBatchResolve = async (openIds: string[]) => {
    await batchResolveUserNamesAsUser({ client, openIds, log });
  };
  const ctxOverrides = {
    account,
    accountId,
    resolveUserName: nameResolver,
    batchResolveNames: uatBatchResolve,
    fetchSubMessages: createUATFetchSubMessages(client),
  };

  // 5. 逐条格式化
  return Promise.all(items.map((item) => formatMessageItem(item, accountId, nameResolver, ctxOverrides)));
}
