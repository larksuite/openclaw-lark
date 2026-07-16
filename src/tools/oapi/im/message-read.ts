/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * 消息读取工具集
 * - list（会话/话题历史）走 TAT（应用身份），因 im.v1.message.list 使用 tenant_access_token
 * - search（跨会话搜索）走 UAT（用户身份）
 *
 * 包含：
 *   - feishu_im_user_get_messages       (chat_id / open_id → 会话消息)
 *   - feishu_im_user_get_thread_messages (thread_id → 话题消息)
 *   - feishu_im_user_search_messages     (跨会话关键词搜索)
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';
import type { ToolClient } from '../helpers';
import { StringEnum, assertLarkOk, createToolContext, getFirstAccount, handleInvokeErrorWithAutoAuth, json, registerTool } from '../helpers';
import { dateTimeToSecondsString, parseTimeRangeToSeconds } from './time-utils';
import { type FormattedMessage, formatMessageList } from './format-messages';
import { batchResolveUserNamesAsUser, getUATUserName } from './user-name-uat';

// ===========================================================================
// Shared helpers
// ===========================================================================

function sortRuleToSortType(rule?: 'create_time_asc' | 'create_time_desc'): 'ByCreateTimeAsc' | 'ByCreateTimeDesc' {
  return rule === 'create_time_asc' ? 'ByCreateTimeAsc' : 'ByCreateTimeDesc';
}

/** open_id → chat_id (P2P 单聊) */
async function resolveP2PChatId(
  client: ToolClient,
  openId: string,
  log: { info: (msg: string) => void },
): Promise<string> {
  const res = await client.invokeByPath<{
    code?: number;
    msg?: string;
    data?: { p2p_chats?: Array<{ chat_id: string }> };
  }>('feishu_im_user_get_messages.default', '/open-apis/im/v1/chat_p2p/batch_query', {
    method: 'POST',
    body: { chatter_ids: [openId] },
    query: { user_id_type: 'open_id' },
    as: 'user',
  });

  const chats = res.data?.p2p_chats;
  if (!chats?.length) {
    log.info(`batch_query: no p2p chat found for open_id=${openId}`);
    throw new Error(`no 1-on-1 chat found with open_id=${openId}. You may not have chat history with this user.`);
  }

  log.info(`batch_query: resolved chat_id=${chats[0].chat_id}`);
  return chats[0].chat_id;
}

/** 解析时间参数，返回秒级时间戳字符串 */
function resolveTimeRange(
  p: { relative_time?: string; start_time?: string; end_time?: string },
  logInfo: (msg: string) => void,
): { start?: string; end?: string } {
  if (p.relative_time) {
    const range = parseTimeRangeToSeconds(p.relative_time);
    logInfo(`relative_time="${p.relative_time}" → start=${range.start}, end=${range.end}`);
    return range;
  }
  return {
    start: p.start_time ? dateTimeToSecondsString(p.start_time) : undefined,
    end: p.end_time ? dateTimeToSecondsString(p.end_time) : undefined,
  };
}

/** 格式化 message.list 结果并返回 */
async function formatAndReturn(res: any, config: any, log: { info: (msg: string) => void }, client: ToolClient) {
  const items = res.data?.items ?? [];
  const account = getFirstAccount(config);
  const messages = await formatMessageList(
    items,
    account,
    (...args: unknown[]) => log.info(args.map(String).join(' ')),
    client,
  );

  const hasMore: boolean = res.data?.has_more ?? false;
  const pageToken: string | undefined = res.data?.page_token;
  log.info(`list: returned ${messages.length} messages, has_more=${hasMore}`);

  return json({ messages, has_more: hasMore, page_token: pageToken });
}

// ===========================================================================
// feishu_im_user_get_messages
// ===========================================================================

const GetMessagesSchema = Type.Object({
  open_id: Type.Optional(
    Type.String({
      description: '用户 open_id（ou_xxx），获取与该用户的单聊消息。与 chat_id 互斥',
    }),
  ),
  chat_id: Type.Optional(
    Type.String({
      description: '会话 ID（oc_xxx），支持单聊和群聊。与 open_id 互斥',
    }),
  ),
  sort_rule: Type.Optional(
    StringEnum(['create_time_asc', 'create_time_desc'], {
      description: '排序方式，默认 create_time_desc（最新消息在前）',
    }),
  ),
  page_size: Type.Optional(Type.Number({ description: '每页消息数（1-50），默认 50', minimum: 1, maximum: 50 })),
  page_token: Type.Optional(Type.String({ description: '分页标记，用于获取下一页' })),
  relative_time: Type.Optional(
    Type.String({
      description:
        '相对时间范围：today / yesterday / day_before_yesterday / this_week / last_week / this_month / last_month / last_{N}_{unit}（unit: minutes/hours/days）。与 start_time/end_time 互斥',
    }),
  ),
  start_time: Type.Optional(
    Type.String({
      description: '起始时间（ISO 8601 格式，如 2026-02-27T00:00:00+08:00）。与 relative_time 互斥',
    }),
  ),
  end_time: Type.Optional(
    Type.String({
      description: '结束时间（ISO 8601 格式，如 2026-02-27T23:59:59+08:00）。与 relative_time 互斥',
    }),
  ),
});

interface GetMessagesParams {
  open_id?: string;
  chat_id?: string;
  sort_rule?: 'create_time_asc' | 'create_time_desc';
  page_size?: number;
  page_token?: string;
  relative_time?: string;
  start_time?: string;
  end_time?: string;
}

function registerGetMessages(api: OpenClawPluginApi): boolean {
  if (!api.config) return false;
  const config = api.config;
  const { toolClient, log } = createToolContext(api, 'feishu_im_user_get_messages');

  return registerTool(
    api,
    {
      name: 'feishu_im_user_get_messages',
      label: 'Feishu: Get IM Messages',
      description:
        '获取群聊或单聊的历史消息。' +
        '\n\n用法：' +
        '\n- 通过 chat_id 获取群聊/单聊消息' +
        '\n- 通过 open_id 获取与指定用户的单聊消息（自动解析 chat_id）' +
        '\n- 支持时间范围过滤：relative_time（如 today、last_3_days）或 start_time/end_time（ISO 8601 格式）' +
        '\n- 支持分页：page_size + page_token' +
        '\n\n【限制】历史消息读取使用应用身份，机器人必须在目标会话中。读取用户与其他人的私聊通常会失败。' +
        '\n\n【参数约束】' +
        '\n- open_id 和 chat_id 必须二选一，不能同时提供' +
        '\n- relative_time 和 start_time/end_time 不能同时使用' +
        '\n- page_size 范围 1-50，默认 50' +
        '\n\n返回消息列表，每条消息包含 message_id、msg_type、content（AI 可读文本）、sender、create_time 等字段。',
      parameters: GetMessagesSchema,
      async execute(_toolCallId: string, params: unknown) {
        const p = params as GetMessagesParams;
        try {
          if (p.open_id && p.chat_id) {
            return json({ error: 'cannot provide both open_id and chat_id, please provide only one' });
          }
          if (!p.open_id && !p.chat_id) {
            return json({ error: 'either open_id or chat_id is required' });
          }
          if (p.relative_time && (p.start_time || p.end_time)) {
            return json({ error: 'cannot use both relative_time and start_time/end_time' });
          }

          const client = toolClient();

          let chatId = p.chat_id ?? '';
          if (p.open_id) {
            log.info(`resolving P2P chat for open_id=${p.open_id}`);
            chatId = await resolveP2PChatId(client, p.open_id, log);
          }

          const time = resolveTimeRange(p, log.info);
          log.info(
            `list: chat_id=${chatId}, sort=${p.sort_rule ?? 'create_time_desc'}, page_size=${p.page_size ?? 50}`,
          );

          const res = await client.invoke(
            'feishu_im_user_get_messages.default',
            (sdk, opts) =>
              sdk.im.v1.message.list(
                {
                  params: {
                    container_id_type: 'chat',
                    container_id: chatId,
                    start_time: time.start,
                    end_time: time.end,
                    sort_type: sortRuleToSortType(p.sort_rule),
                    page_size: p.page_size ?? 50,
                    page_token: p.page_token,
                    card_msg_content_type: 'raw_card_content',
                  } as any,
                },
                opts,
              ),
            {
              as: 'tenant',
            },
          );
          assertLarkOk(res);

          return await formatAndReturn(res, config, log, client);
        } catch (err) {
          return await handleInvokeErrorWithAutoAuth(err, config);
        }
      },
    },
    { name: 'feishu_im_user_get_messages' },
  );
}

// ===========================================================================
// feishu_im_user_get_thread_messages
// ===========================================================================

const GetThreadMessagesSchema = Type.Object({
  thread_id: Type.String({ description: '话题 ID（omt_xxx 格式）' }),
  sort_rule: Type.Optional(
    StringEnum(['create_time_asc', 'create_time_desc'], {
      description: '排序方式，默认 create_time_desc（最新消息在前）',
    }),
  ),
  page_size: Type.Optional(Type.Number({ description: '每页消息数（1-50），默认 50', minimum: 1, maximum: 50 })),
  page_token: Type.Optional(Type.String({ description: '分页标记，用于获取下一页' })),
});

interface GetThreadMessagesParams {
  thread_id: string;
  sort_rule?: 'create_time_asc' | 'create_time_desc';
  page_size?: number;
  page_token?: string;
}

function registerGetThreadMessages(api: OpenClawPluginApi): boolean {
  if (!api.config) return false;
  const config = api.config;
  const { toolClient, log } = createToolContext(api, 'feishu_im_user_get_thread_messages');

  return registerTool(
    api,
    {
      name: 'feishu_im_user_get_thread_messages',
      label: 'Feishu: Get Thread Messages',
      description:
        '获取话题（thread）内的消息列表。' +
        '\n\n用法：' +
        '\n- 通过 thread_id（omt_xxx）获取话题内的所有消息' +
        '\n- 支持分页：page_size + page_token' +
        '\n\n【注意】话题消息不支持时间范围过滤（飞书 API 限制）' +
        '\n\n【限制】历史消息读取使用应用身份，机器人必须在目标会话中。' +
        '\n\n返回消息列表，格式同 feishu_im_user_get_messages。',
      parameters: GetThreadMessagesSchema,
      async execute(_toolCallId: string, params: unknown) {
        const p = params as GetThreadMessagesParams;
        try {
          const client = toolClient();
          log.info(
            `list: thread_id=${p.thread_id}, sort=${p.sort_rule ?? 'create_time_desc'}, page_size=${p.page_size ?? 50}`,
          );

          const res = await client.invoke(
            'feishu_im_user_get_messages.default',
            (sdk, opts) =>
              sdk.im.v1.message.list(
                {
                  params: {
                    container_id_type: 'thread',
                    container_id: p.thread_id,
                    sort_type: sortRuleToSortType(p.sort_rule),
                    page_size: p.page_size ?? 50,
                    page_token: p.page_token,
                    card_msg_content_type: 'raw_card_content',
                  } as any,
                },
                opts,
              ),
            {
              as: 'tenant',
            },
          );
          assertLarkOk(res);

          return await formatAndReturn(res, config, log, client);
        } catch (err) {
          return await handleInvokeErrorWithAutoAuth(err, config);
        }
      },
    },
    { name: 'feishu_im_user_get_thread_messages' },
  );
}

// ===========================================================================
// feishu_im_user_search_messages
// ===========================================================================

const SearchMessagesSchema = Type.Object({
  query: Type.Optional(Type.String({ description: '搜索关键词，匹配消息内容。可为空字符串表示不按内容过滤' })),
  sender_ids: Type.Optional(
    Type.Array(Type.String({ description: '发送者的 open_id（ou_xxx）' }), {
      description: '发送者 open_id 列表。如需根据用户名查找 open_id，请先使用 search_user 工具',
    }),
  ),
  chat_id: Type.Optional(Type.String({ description: '限定搜索范围的会话 ID（oc_xxx）' })),
  mention_ids: Type.Optional(
    Type.Array(Type.String({ description: '被@用户的 open_id（ou_xxx）' }), { description: '被@用户的 open_id 列表' }),
  ),
  message_type: Type.Optional(
    StringEnum(['file', 'image', 'media'], {
      description: '消息类型过滤：file / image / media。为空则搜索所有类型',
    }),
  ),
  sender_type: Type.Optional(
    StringEnum(['user', 'bot', 'all'], {
      description: '发送者类型：user / bot / all。默认 user',
    }),
  ),
  chat_type: Type.Optional(
    StringEnum(['group', 'p2p'], {
      description: '会话类型：group（群聊）/ p2p（单聊）',
    }),
  ),
  relative_time: Type.Optional(
    Type.String({
      description:
        '相对时间范围：today / yesterday / day_before_yesterday / this_week / last_week / this_month / last_month / last_{N}_{unit}（unit: minutes/hours/days）。与 start_time/end_time 互斥',
    }),
  ),
  start_time: Type.Optional(
    Type.String({
      description: '起始时间（ISO 8601 格式，如 2026-02-27T00:00:00+08:00）。与 relative_time 互斥',
    }),
  ),
  end_time: Type.Optional(
    Type.String({
      description: '结束时间（ISO 8601 格式，如 2026-02-27T23:59:59+08:00）。与 relative_time 互斥',
    }),
  ),
  page_size: Type.Optional(Type.Number({ description: '每页消息数（1-50），默认 50', minimum: 1, maximum: 50 })),
  page_token: Type.Optional(Type.String({ description: '分页标记，用于获取下一页' })),
});

interface SearchMessagesParams {
  query?: string;
  sender_ids?: string[];
  chat_id?: string;
  mention_ids?: string[];
  message_type?: 'file' | 'image' | 'media';
  sender_type?: 'user' | 'bot' | 'all';
  chat_type?: 'group' | 'p2p';
  relative_time?: string;
  start_time?: string;
  end_time?: string;
  page_size?: number;
  page_token?: string;
}

// -- search 专用 helpers --

interface ChatContext {
  name: string;
  chat_mode: string;
  p2p_target_id?: string;
}

function buildSearchData(p: SearchMessagesParams, time: { start: string; end: string }): Record<string, unknown> {
  const data: Record<string, unknown> = {
    query: p.query ?? '',
    start_time: time.start,
    end_time: time.end,
  };
  if (p.sender_ids?.length) data.from_ids = p.sender_ids;
  if (p.chat_id) data.chat_ids = [p.chat_id];
  if (p.mention_ids?.length) data.at_chatter_ids = p.mention_ids;
  if (p.message_type) data.message_type = p.message_type;
  if (p.sender_type && p.sender_type !== 'all') data.from_type = p.sender_type;
  if (p.chat_type) data.chat_type = p.chat_type === 'group' ? 'group_chat' : 'p2p_chat';
  return data;
}

async function fetchChatContexts(
  client: ToolClient,
  chatIds: string[],
  logInfo: (msg: string) => void,
  logWarn: (msg: string) => void,
): Promise<Map<string, ChatContext>> {
  const map = new Map<string, ChatContext>();
  if (chatIds.length === 0) return map;

  try {
    logInfo(`batch_query: requesting ${chatIds.length} chat_ids: ${chatIds.join(', ')}`);
    const res = await client.invokeByPath<{
      code?: number;
      msg?: string;
      data?: {
        items?: Array<{
          chat_id?: string;
          name?: string;
          chat_mode?: string;
          p2p_target_id?: string;
        }>;
      };
    }>('feishu_im_user_search_messages.default', '/open-apis/im/v1/chats/batch_query', {
      method: 'POST',
      body: { chat_ids: chatIds },
      query: { user_id_type: 'open_id' },
      as: 'user',
    });
    logInfo(`batch_query: response code=${res.code}, msg=${res.msg}, items=${res.data?.items?.length ?? 0}`);
    if (res.code !== 0) {
      logWarn(`batch_query: API returned error code=${res.code}, msg=${res.msg}`);
    }
    for (const c of res.data?.items ?? []) {
      if (c.chat_id) {
        map.set(c.chat_id, {
          name: c.name ?? '',
          chat_mode: c.chat_mode ?? '',
          p2p_target_id: c.p2p_target_id,
        });
      }
    }
  } catch (err) {
    logInfo(`batch_query chats failed, skipping: ${err}`);
  }
  return map;
}

async function resolveP2PTargetNames(
  chatMap: Map<string, ChatContext>,
  client: ToolClient,
  logFn: (...args: unknown[]) => void,
): Promise<void> {
  const ids = [...new Set([...chatMap.values()].map((c) => c.p2p_target_id).filter((id): id is string => !!id))];
  if (ids.length > 0) {
    await batchResolveUserNamesAsUser({ client, openIds: ids, log: logFn });
  }
}

function enrichMessages(
  messages: FormattedMessage[],
  items: any[],
  chatMap: Map<string, ChatContext>,
  nameResolver: (openId: string) => string | undefined,
) {
  return messages.map((msg, idx) => {
    const chatId: string | undefined = items[idx]?.chat_id;
    const ctx = chatId ? chatMap.get(chatId) : undefined;
    if (!chatId || !ctx) return { ...msg, chat_id: chatId };

    if (ctx.chat_mode === 'p2p' && ctx.p2p_target_id) {
      const name = nameResolver(ctx.p2p_target_id);
      return {
        ...msg,
        chat_id: chatId,
        chat_type: 'p2p' as const,
        chat_name: name || undefined,
        chat_partner: { open_id: ctx.p2p_target_id, name: name || undefined },
      };
    }

    return {
      ...msg,
      chat_id: chatId,
      chat_type: ctx.chat_mode,
      chat_name: ctx.name || undefined,
    };
  });
}

function registerSearchMessages(api: OpenClawPluginApi): boolean {
  if (!api.config) return false;
  const config = api.config;
  const { toolClient, log } = createToolContext(api, 'feishu_im_user_search_messages');

  return registerTool(
    api,
    {
      name: 'feishu_im_user_search_messages',
      label: 'Feishu: Search Messages',
      description:
        '【以用户身份】跨会话搜索飞书消息。' +
        '\n\n用法：' +
        '\n- 按关键词搜索消息内容' +
        '\n- 按发送者、被@用户、消息类型过滤' +
        '\n- 按时间范围过滤：relative_time 或 start_time/end_time' +
        '\n- 限定在某个会话内搜索（chat_id）' +
        '\n- 支持分页：page_size + page_token' +
        '\n\n【参数约束】' +
        '\n- 所有参数均可选，但至少应提供一个过滤条件' +
        '\n- relative_time 和 start_time/end_time 不能同时使用' +
        '\n- page_size 范围 1-50，默认 50' +
        '\n\n返回消息列表，每条消息包含 message_id、msg_type、content、sender、create_time 等字段。' +
        '\n每条消息还包含 chat_id、chat_type（p2p/group）、chat_name（群名或单聊对方名字）。' +
        '\n单聊消息额外包含 chat_partner（对方 open_id 和名字）。' +
        '\n搜索结果中的 chat_id 和 thread_id 可配合 feishu_im_user_get_messages / feishu_im_user_get_thread_messages 查看上下文。',
      parameters: SearchMessagesSchema,

      async execute(_toolCallId: string, params: unknown) {
        const p = params as SearchMessagesParams;
        try {
          if (p.relative_time && (p.start_time || p.end_time)) {
            return json({ error: 'cannot use both relative_time and start_time/end_time' });
          }

          const client = toolClient();
          const account = getFirstAccount(config);
          const logFn = (...args: unknown[]) => log.info(args.map(String).join(' '));

          // 1. 搜索消息 ID
          const time = resolveTimeRange(p, log.info);
          const searchData = buildSearchData(p, {
            start: time.start ?? '978307200',
            end: time.end ?? Math.floor(Date.now() / 1000).toString(),
          });
          log.info(`search: query="${p.query ?? ''}", page_size=${p.page_size ?? 50}`);

          const searchRes = await client.invoke(
            'feishu_im_user_search_messages.default',
            (sdk, opts) =>
              sdk.search.message.create(
                {
                  data: searchData as any,
                  params: {
                    user_id_type: 'open_id',
                    page_size: p.page_size ?? 50,
                    page_token: p.page_token,
                  },
                },
                opts!,
              ),
            {
              as: 'user',
            },
          );
          assertLarkOk(searchRes as any);

          const messageIds: string[] = (searchRes as any).data?.items ?? [];
          const hasMore: boolean = (searchRes as any).data?.has_more ?? false;
          const pageToken: string | undefined = (searchRes as any).data?.page_token;
          log.info(`search: found ${messageIds.length} IDs, has_more=${hasMore}`);

          if (messageIds.length === 0) {
            return json({ messages: [], has_more: hasMore, page_token: pageToken });
          }

          // 2. 批量获取消息详情
          const queryStr = messageIds.map((id) => `message_ids=${encodeURIComponent(id)}`).join('&');
          const mgetRes = await client.invokeByPath<{
            code?: number;
            msg?: string;
            data?: { items?: any[] };
          }>('feishu_im_user_search_messages.default', `/open-apis/im/v1/messages/mget?${queryStr}`, {
            method: 'GET',
            query: { user_id_type: 'open_id', card_msg_content_type: 'raw_card_content' },
            as: 'user',
          });
          const items = mgetRes.data?.items ?? [];
          log.info(`mget: ${items.length} details`);

          // 3. 批量获取会话信息
          const chatIds = [
            ...new Set(items.map((i: any) => i.chat_id as string | undefined).filter(Boolean)),
          ] as string[];
          const chatMap = await fetchChatContexts(client, chatIds, log.info, log.warn);
          const p2pChats = [...chatMap.entries()].filter(([, v]) => v.chat_mode === 'p2p');
          log.info(`chats: ${chatMap.size}/${chatIds.length} resolved, p2p=${p2pChats.length}`);

          // 4. 格式化消息（填充 sender 名字缓存，使用 UAT）
          const messages = await formatMessageList(items, account, logFn, client);

          // 5. 解析 p2p 对方用户名（使用 UAT）
          await resolveP2PTargetNames(chatMap, client, logFn);

          // 6. 拼装返回
          const uatNameResolver = (id: string) => getUATUserName(account.accountId, id);
          const result = enrichMessages(messages, items, chatMap, uatNameResolver);
          log.info(`result: ${result.length} messages, has_more=${hasMore}`);

          return json({ messages: result, has_more: hasMore, page_token: pageToken });
        } catch (err) {
          return await handleInvokeErrorWithAutoAuth(err, config);
        }
      },
    },
    { name: 'feishu_im_user_search_messages' },
  );
}

// ===========================================================================
// Unified registration
// ===========================================================================

export function registerMessageReadTools(api: OpenClawPluginApi): string[] {
  const registered: string[] = [];
  if (registerGetMessages(api)) registered.push('feishu_im_user_get_messages');
  if (registerGetThreadMessages(api)) registered.push('feishu_im_user_get_thread_messages');
  if (registerSearchMessages(api)) registered.push('feishu_im_user_search_messages');
  return registered;
}
