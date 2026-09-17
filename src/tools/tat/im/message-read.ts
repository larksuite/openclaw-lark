/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * 应用身份消息读取。所有请求均使用 SDK 管理的 tenant_access_token。
 * 搜索契约参考飞书官方 CLI shortcuts/im/im_messages_search.go：
 * POST /im/v1/messages/search 使用 filter，返回 items[].meta_data.message_id。
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { type Static, Type } from '@sinclair/typebox';
import type { ToolClient } from '../../../core/tool-client';
import type { ToolActionKey } from '../../../core/tool-scopes';
import type { ApiMessageItem } from '../../../messaging/converters/types';
import { extractMentionOpenId } from '../../../messaging/converters/content-converter';
import { StringEnum, assertLarkOk, createToolContext, formatLarkError, json, registerTool } from '../../oapi/helpers';
import { formatMessageItem } from '../../oapi/im/format-messages';
import { GetMessagesSchema, GetThreadMessagesSchema, SearchMessagesSchema } from '../../oapi/im/message-read';
import { dateTimeToSecondsString, parseTimeRangeToSeconds, secondsStringToDateTime } from '../../oapi/im/time-utils';

const Pagination = {
  page_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: '每页 1-50 条，默认 50' })),
};
const BotGetMessagesSchema = Type.Object(
  {
    ...Type.Omit(GetMessagesSchema, ['open_id', 'chat_id']).properties,
    ...Pagination,
    chat_id: Type.String({ minLength: 1, description: '机器人可访问的会话 ID（oc_xxx）；单聊是用户与机器人的单聊' }),
  },
  { additionalProperties: false },
);
const BotGetThreadMessagesSchema = Type.Object(
  {
    ...GetThreadMessagesSchema.properties,
    ...Pagination,
  },
  { additionalProperties: false },
);
const BotSearchMessagesSchema = Type.Object(
  {
    ...SearchMessagesSchema.properties,
    ...Pagination,
    message_type: Type.Optional(
      StringEnum(['file', 'image', 'media', 'video', 'link'], {
        description: '附件类型过滤；media 是 video 的兼容别名。匹配含此类附件的消息',
      }),
    ),
    sender_type: Type.Optional(StringEnum(['user', 'bot', 'all'], { description: '发送者类型，默认 all' })),
  },
  { additionalProperties: false },
);

interface TimeParams {
  relative_time?: string;
  start_time?: string;
  end_time?: string;
  page_size?: number;
}
type SearchParams = Static<typeof BotSearchMessagesSchema>;
type Message = ApiMessageItem & { chat_id?: string; sender?: ApiMessageItem['sender'] & { sender_name?: string } };
interface Response<T> {
  code?: number;
  msg?: string;
  data?: T;
}
interface MessagePage {
  items?: Message[];
  has_more?: boolean;
  page_token?: string;
}
interface ChatContext {
  chat_id?: string;
  name?: string;
  chat_mode?: string;
  p2p_target_id?: string;
}

const BOT_ACCESS =
  '【以应用/机器人身份，使用 tenant_access_token，无需用户 OAuth 授权】' +
  '只能读取应用可见且机器人有权访问的会话；应用需开启机器人能力，群消息需机器人在群内并开通 im:message.group_msg，单聊需 im:message.p2p_msg:readonly。';

function resolveTime(p: TimeParams) {
  if (p.page_size !== undefined && (!Number.isInteger(p.page_size) || p.page_size < 1 || p.page_size > 50)) {
    throw new Error('page_size must be an integer between 1 and 50');
  }
  if (p.relative_time && (p.start_time || p.end_time)) {
    throw new Error('cannot use both relative_time and start_time/end_time');
  }
  const time = p.relative_time
    ? parseTimeRangeToSeconds(p.relative_time)
    : {
        start: p.start_time ? dateTimeToSecondsString(p.start_time) : undefined,
        end: p.end_time ? dateTimeToSecondsString(p.end_time) : undefined,
      };
  if (time.start && time.end && Number(time.start) > Number(time.end)) {
    throw new Error('start_time cannot be later than end_time');
  }
  return time;
}

/** SDK request 自动注入 TAT；不使用只注入 UAT 的 invokeByPath。 */
async function request<T>(
  client: ToolClient,
  action: ToolActionKey,
  url: string,
  method: 'GET' | 'POST',
  params?: Record<string, unknown>,
  data?: Record<string, unknown>,
): Promise<T | undefined> {
  const res = await client.invoke(action, (sdk) => sdk.request<Response<T>>({ url, method, params, data }), {
    as: 'tenant',
  });
  assertLarkOk(res);
  return res.data;
}

/** 不访问 UAT 姓名缓存或通讯录；姓名采用消息自带 sender/mention 数据，缺失时保留 ID。 */
async function formatMessages(items: Message[], client: ToolClient) {
  const names = new Map<string, string>();
  const collectNames = (messages: Message[]) => {
    for (const item of messages) {
      if (item.sender?.id && item.sender.sender_name) names.set(item.sender.id, item.sender.sender_name);
      for (const mention of item.mentions ?? []) {
        const id = extractMentionOpenId(mention.id);
        if (id && mention.name) names.set(id, mention.name);
      }
    }
  };
  collectNames(items);
  const nameResolver = (id: string) => names.get(id);
  const accountId = client.account.accountId;
  return Promise.all(
    items.map(async (item) => ({
      ...(await formatMessageItem(item, accountId, nameResolver, {
        account: client.account,
        accountId,
        resolveUserName: nameResolver,
        batchResolveNames: async () => {},
        fetchSubMessages: async (messageId) => {
          const data = await request<MessagePage>(
            client,
            'feishu_im_bot_get_messages.default',
            `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
            'GET',
            { user_id_type: 'open_id', card_msg_content_type: 'raw_card_content', with_sender_name: 'true' },
          );
          const children = data?.items ?? [];
          collectNames(children);
          return children;
        },
      })),
      ...(item.chat_id ? { chat_id: item.chat_id } : {}),
    })),
  );
}

function registerList(api: OpenClawPluginApi, thread: boolean): string | undefined {
  const name = thread ? 'feishu_im_bot_get_thread_messages' : 'feishu_im_bot_get_messages';
  const action = thread ? 'feishu_im_bot_get_thread_messages.default' : 'feishu_im_bot_get_messages.default';
  const { toolClient, log } = createToolContext(api, name);
  const registered = registerTool(
    api,
    {
      name,
      label: thread ? 'Feishu: Get Thread Messages (Bot)' : 'Feishu: Get IM Messages (Bot)',
      description:
        BOT_ACCESS +
        (thread
          ? '通过 thread_id 获取话题消息，支持 sort_rule、page_size、page_token，不支持时间过滤。'
          : '通过 chat_id 获取群聊或与机器人的单聊历史消息，不支持 open_id。支持 relative_time 或 start_time/end_time（互斥），以及排序和分页。') +
        '返回 messages、has_more、page_token；消息格式与用户工具一致，姓名可能省略。',
      parameters: thread ? BotGetThreadMessagesSchema : BotGetMessagesSchema,
      async execute(_toolCallId: string, params: unknown) {
        try {
          const p = params as Static<typeof BotGetMessagesSchema> & { thread_id?: string; open_id?: string };
          if (p.open_id !== undefined) throw new Error('bot identity requires chat_id; open_id is not supported');
          if (thread && (p.relative_time || p.start_time || p.end_time))
            throw new Error('thread messages do not support time filters');
          const container = thread ? p.thread_id : p.chat_id;
          if (!container?.trim()) throw new Error(thread ? 'thread_id is required' : 'chat_id is required');
          const time = resolveTime(p);
          const client = toolClient();
          const data = await request<MessagePage>(client, action, '/open-apis/im/v1/messages', 'GET', {
            container_id_type: thread ? 'thread' : 'chat',
            container_id: container,
            ...(time.start ? { start_time: time.start } : {}),
            ...(time.end ? { end_time: time.end } : {}),
            sort_type: p.sort_rule === 'create_time_asc' ? 'ByCreateTimeAsc' : 'ByCreateTimeDesc',
            page_size: p.page_size ?? 50,
            page_token: p.page_token,
            card_msg_content_type: 'raw_card_content',
            with_sender_name: 'true',
          });
          const messages = await formatMessages(data?.items ?? [], client);
          log.info(`list: returned ${messages.length} messages, has_more=${data?.has_more ?? false}`);
          return json({ messages, has_more: data?.has_more ?? false, page_token: data?.page_token });
        } catch (err) {
          return json({ error: formatLarkError(err) });
        }
      },
    },
    { name },
  );
  return registered ? name : undefined;
}

function searchFilter(p: SearchParams, time: ReturnType<typeof resolveTime>) {
  const filter: Record<string, unknown> = {};
  if (p.chat_id) filter.chat_ids = [p.chat_id];
  if (p.sender_ids?.length) filter.from_ids = p.sender_ids;
  if (p.mention_ids?.length) filter.at_chatter_ids = p.mention_ids;
  if (p.message_type) filter.include_attachment_types = [p.message_type === 'media' ? 'video' : p.message_type];
  if (p.sender_type && p.sender_type !== 'all') filter.from_types = [p.sender_type];
  if (p.chat_type) filter.chat_type = p.chat_type;
  if (time.start || time.end)
    filter.time_range = {
      ...(time.start ? { start_time: secondsStringToDateTime(time.start) } : {}),
      ...(time.end ? { end_time: secondsStringToDateTime(time.end) } : {}),
    };
  return filter;
}

function registerSearch(api: OpenClawPluginApi): string | undefined {
  const name = 'feishu_im_bot_search_messages';
  const action = 'feishu_im_bot_search_messages.default';
  const { toolClient, log } = createToolContext(api, name);
  const registered = registerTool(
    api,
    {
      name,
      label: 'Feishu: Search Messages (Bot)',
      description:
        BOT_ACCESS +
        '使用 IM 消息搜索 API 跨应用可访问的会话搜索。' +
        '支持 query、chat_id、sender_ids、mention_ids、message_type（附件类型）、sender_type（默认 all）、chat_type、时间范围和分页。' +
        '至少提供一个有效搜索条件。搜索需应用权限 search:message；会话名称补充需 im:chat:read，缺失不影响消息返回。' +
        '返回 messages、has_more、page_token 和服务端 notice（如有）；姓名可能省略，失败的会话信息补充会返回 warning。' +
        '用 feishu_im_bot_get_messages / feishu_im_bot_get_thread_messages 查看上下文。',
      parameters: BotSearchMessagesSchema,
      async execute(_toolCallId: string, params: unknown) {
        try {
          const p = params as SearchParams;
          const time = resolveTime(p);
          const filter = searchFilter(p, time);
          if (!p.query?.trim() && Object.keys(filter).length === 0)
            throw new Error('at least one search filter is required');
          const client = toolClient();
          const search = await request<{
            items?: Array<{ meta_data?: { message_id?: string } }>;
            has_more?: boolean;
            page_token?: string;
            notice?: string;
          }>(
            client,
            action,
            '/open-apis/im/v1/messages/search',
            'POST',
            { page_size: p.page_size ?? 50, page_token: p.page_token },
            { query: p.query ?? '', filter },
          );
          const ids = [
            ...new Set(
              (search?.items ?? []).map((item) => item.meta_data?.message_id).filter((id): id is string => !!id),
            ),
          ];
          if (search?.items?.length && !ids.length)
            throw new Error('message search returned items without message IDs');
          const pagination = {
            has_more: search?.has_more ?? false,
            page_token: search?.page_token,
            ...(search?.notice ? { notice: search.notice } : {}),
          };
          if (!ids.length) return json({ messages: [], ...pagination });
          // 显式重复 message_ids 参数，避免 SDK 通用 request 的数组序列化格式差异。
          const query = ids.map((id) => `message_ids=${encodeURIComponent(id)}`).join('&');
          const details = await request<MessagePage>(client, action, `/open-apis/im/v1/messages/mget?${query}`, 'GET', {
            user_id_type: 'open_id',
            card_msg_content_type: 'raw_card_content',
            with_sender_name: 'true',
          });
          const byId = new Map((details?.items ?? []).map((item) => [item.message_id, item]));
          const items = ids.map((id) => byId.get(id)).filter((item): item is Message => !!item);
          const missingIds = ids.filter((id) => !byId.has(id));
          const chats = new Map<string, ChatContext>();
          const chatIds = [...new Set(items.map((item) => item.chat_id).filter((id): id is string => !!id))];
          let warning: string | undefined;
          if (chatIds.length) {
            try {
              const contexts = await request<{ items?: ChatContext[] }>(
                client,
                'feishu_im_bot_search_messages.chat_context',
                '/open-apis/im/v1/chats/batch_query',
                'POST',
                { user_id_type: 'open_id' },
                { chat_ids: chatIds },
              );
              for (const chat of contexts?.items ?? []) if (chat.chat_id) chats.set(chat.chat_id, chat);
            } catch (err) {
              warning = `chat context unavailable: ${formatLarkError(err)}`;
              log.warn(warning);
            }
          }
          const messages = (await formatMessages(items, client)).map((message) => {
            const chat = message.chat_id ? chats.get(message.chat_id) : undefined;
            return {
              ...message,
              ...(chat
                ? {
                    chat_type: chat.chat_mode,
                    ...(chat.chat_mode === 'p2p'
                      ? { chat_partner: chat.p2p_target_id ? { open_id: chat.p2p_target_id } : undefined }
                      : { chat_name: chat.name || undefined }),
                  }
                : {}),
            };
          });
          log.info(`search: returned ${messages.length} messages, has_more=${pagination.has_more}`);
          return json({
            messages,
            ...pagination,
            ...(warning ? { warning } : {}),
            ...(missingIds.length ? { missing_message_ids: missingIds } : {}),
          });
        } catch (err) {
          return json({ error: formatLarkError(err) });
        }
      },
    },
    { name },
  );
  return registered ? name : undefined;
}

export function registerBotMessageReadTools(api: OpenClawPluginApi): string[] {
  if (!api.config) return [];
  return [registerList(api, false), registerList(api, true), registerSearch(api)].filter(
    (name): name is string => !!name,
  );
}
