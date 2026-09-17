import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import type { Client } from '@larksuiteoapi/node-sdk';
import type { ConfiguredLarkAccount } from '../src/core/types';
import { ToolClient } from '../src/core/tool-client';
import { getAppGrantedScopes } from '../src/core/app-scope-checker';
import { getStoredToken } from '../src/core/token-store';
import * as helpers from '../src/tools/helpers';
import { registerBotMessageReadTools } from '../src/tools/tat/im/message-read';
import { registerMessageReadTools } from '../src/tools/oapi/im/message-read';
import { TOOL_SCOPES } from '../src/core/tool-scopes';

vi.mock('../src/core/app-scope-checker', async (original) => ({
  ...(await original<typeof import('../src/core/app-scope-checker')>()),
  getAppGrantedScopes: vi.fn(),
}));
vi.mock('../src/core/token-store', () => ({
  getStoredToken: vi.fn(() => {
    throw new Error('must not read UAT');
  }),
}));
vi.mock('../src/tools/oapi/im/user-name-uat', () => ({
  batchResolveUserNamesAsUser: vi.fn(() => {
    throw new Error('must not resolve names as user');
  }),
  getUATUserName: vi.fn(() => {
    throw new Error('must not read UAT names');
  }),
  setUATUserNames: vi.fn(() => {
    throw new Error('must not write UAT names');
  }),
}));

type Tool = {
  name: string;
  parameters: { properties: Record<string, unknown> };
  execute: (id: string, params: unknown) => Promise<{ details: any }>;
};
const request = vi.fn();
const tools = new Map<string, Tool>();
let api: OpenClawPluginApi;
let client: ToolClient;
const listName = 'feishu_im_bot_get_messages';
const threadName = 'feishu_im_bot_get_thread_messages';
const searchName = 'feishu_im_bot_search_messages';
const message = (id: string, text = 'hello') => ({
  message_id: id,
  chat_id: 'oc_group',
  msg_type: 'text',
  create_time: '1772150400000',
  body: { content: JSON.stringify({ text }) },
  sender: { id: 'ou_sender', sender_type: 'user' },
});
const run = async (name: string, params: unknown) => (await tools.get(name)!.execute('call', params)).details;

beforeEach(() => {
  vi.restoreAllMocks();
  request.mockReset();
  tools.clear();
  vi.mocked(getAppGrantedScopes).mockResolvedValue(['im:message:readonly', 'search:message', 'im:chat:read']);
  api = {
    config: { channels: { feishu: { appId: 'cli_test', appSecret: 'test' } } },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
  } as unknown as OpenClawPluginApi;
  client = new ToolClient({
    config: api.config,
    account: {
      accountId: 'second-account',
      configured: true,
      enabled: true,
      appId: 'cli_test',
      appSecret: 'test',
      config: {},
    } as ConfiguredLarkAccount,
    senderOpenId: undefined,
    sdk: { request } as unknown as Client,
  });
  vi.spyOn(helpers, 'createToolContext').mockReturnValue({
    toolClient: () => client,
    getClient: () => client.sdk,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  });
  vi.spyOn(client, 'invoke');
  registerBotMessageReadTools(api);
});

describe('tenant IM message tools', () => {
  it('registers three independent tools and preserves user tool registration', () => {
    expect([...tools.keys()]).toEqual([listName, threadName, searchName]);
    expect(registerMessageReadTools(api)).toEqual([
      'feishu_im_user_get_messages',
      'feishu_im_user_get_thread_messages',
      'feishu_im_user_search_messages',
    ]);
    expect(tools.size).toBe(6);
    expect(tools.get(listName)!.parameters.properties).not.toHaveProperty('open_id');
  });

  it('honors deny and missing config', () => {
    api.config = { channels: { feishu: { tools: { deny: [searchName] } } } } as typeof api.config;
    expect(registerBotMessageReadTools(api)).toEqual([listName, threadName]);
    expect(registerBotMessageReadTools({ ...api, config: undefined } as unknown as OpenClawPluginApi)).toEqual([]);
  });

  it('reads history with no sender or UAT and preserves pagination', async () => {
    request.mockResolvedValue({ code: 0, data: { items: [message('om_one')], has_more: true, page_token: 'next' } });
    const result = await run(listName, {
      chat_id: 'oc_group',
      start_time: '2026-02-27T00:00:00+08:00',
      page_size: 7,
      page_token: 'previous',
      sort_rule: 'create_time_asc',
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: '/open-apis/im/v1/messages',
        method: 'GET',
        params: expect.objectContaining({
          container_id_type: 'chat',
          container_id: 'oc_group',
          page_size: 7,
          page_token: 'previous',
          start_time: '1772121600',
          sort_type: 'ByCreateTimeAsc',
        }),
      }),
    );
    expect(result).toMatchObject({
      messages: [{ message_id: 'om_one', content: 'hello', sender: { id: 'ou_sender' } }],
      has_more: true,
      page_token: 'next',
    });
    expect(client.invoke).toHaveBeenCalledWith('feishu_im_bot_get_messages.default', expect.any(Function), {
      as: 'tenant',
    });
    expect(getStoredToken).not.toHaveBeenCalled();
  });

  it('reads threads and expands forwarded messages only through tenant requests', async () => {
    request.mockResolvedValueOnce({
      code: 0,
      data: { items: [{ ...message('om_forward'), msg_type: 'merge_forward', body: { content: '{}' } }] },
    });
    request.mockResolvedValueOnce({
      code: 0,
      data: { items: [{ ...message('om_child', 'forwarded text'), upper_message_id: 'om_forward' }] },
    });
    const result = await run(threadName, { thread_id: 'omt_thread' });
    expect(request.mock.calls[0][0].params).toMatchObject({
      container_id_type: 'thread',
      container_id: 'omt_thread',
      sort_type: 'ByCreateTimeDesc',
    });
    expect(request.mock.calls[1][0].url).toBe('/open-apis/im/v1/messages/om_forward');
    expect(result.messages[0].content).toContain('forwarded text');
    expect(vi.mocked(getAppGrantedScopes).mock.calls.every((call) => call[2] === 'tenant')).toBe(true);
    expect(getStoredToken).not.toHaveBeenCalled();
  });

  it.each([
    [listName, { open_id: 'ou_user' }],
    [listName, {}],
    [listName, { chat_id: 'oc_group', page_size: 1.5 }],
    [listName, { chat_id: 'oc_group', page_size: 51 }],
    [listName, { chat_id: 'oc_group', relative_time: 'today', start_time: '2026-02-27' }],
    [listName, { chat_id: 'oc_group', start_time: 'invalid' }],
    [listName, { chat_id: 'oc_group', start_time: '2026-03-01', end_time: '2026-02-01' }],
    [threadName, { thread_id: 'omt_thread', relative_time: 'today' }],
    [searchName, { sender_type: 'all', query: ' ' }],
  ])('rejects invalid parameters before API calls: %s %j', async (name, params) => {
    expect(await run(name, params)).toHaveProperty('error');
    expect(request).not.toHaveBeenCalled();
  });

  it('maps search to new IM filters, decodes metadata IDs, retains server ordering and notice', async () => {
    request.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [{ meta_data: { message_id: 'om_b' } }, { meta_data: { message_id: 'om_a' } }],
        has_more: true,
        page_token: 'next',
        notice: 'limited visibility',
      },
    });
    request.mockResolvedValueOnce({ code: 0, data: { items: [message('om_a'), message('om_b')] } });
    request.mockResolvedValueOnce({
      code: 0,
      data: { items: [{ chat_id: 'oc_group', chat_mode: 'group', name: '群聊' }] },
    });
    const result = await run(searchName, {
      query: 'hello',
      chat_id: 'oc_group',
      sender_ids: ['ou_sender'],
      mention_ids: ['ou_mention'],
      message_type: 'media',
      sender_type: 'bot',
      chat_type: 'group',
      start_time: '2026-02-27T00:00:00+08:00',
      end_time: '2026-02-28T00:00:00+08:00',
      page_size: 2,
      page_token: 'previous',
    });
    expect(request.mock.calls[0][0]).toEqual({
      url: '/open-apis/im/v1/messages/search',
      method: 'POST',
      params: { page_size: 2, page_token: 'previous' },
      data: {
        query: 'hello',
        filter: {
          chat_ids: ['oc_group'],
          from_ids: ['ou_sender'],
          at_chatter_ids: ['ou_mention'],
          include_attachment_types: ['video'],
          from_types: ['bot'],
          chat_type: 'group',
          time_range: { start_time: '2026-02-27T00:00:00+08:00', end_time: '2026-02-28T00:00:00+08:00' },
        },
      },
    });
    expect(request.mock.calls[1][0].url).toBe('/open-apis/im/v1/messages/mget?message_ids=om_b&message_ids=om_a');
    expect(result.messages.map((item: any) => item.message_id)).toEqual(['om_b', 'om_a']);
    expect(result.messages[0]).toMatchObject({ chat_id: 'oc_group', chat_name: '群聊', chat_type: 'group' });
    expect(result).toMatchObject({ has_more: true, page_token: 'next', notice: 'limited visibility' });
    expect(getStoredToken).not.toHaveBeenCalled();
  });

  it('converts relative time to ISO for search and skips enrichment for empty pages', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T08:00:00Z'));
    try {
      request.mockResolvedValue({ code: 0, data: { items: [], has_more: true, page_token: 'more', notice: 'notice' } });
      const result = await run(searchName, { relative_time: 'last_3_hours' });
      expect(request.mock.calls[0][0].data.filter.time_range).toEqual({
        start_time: '2026-09-11T13:00:00+08:00',
        end_time: '2026-09-11T16:00:00+08:00',
      });
      expect(request.mock.calls[0][0].data.filter).not.toHaveProperty('from_types');
      expect(result).toEqual({ messages: [], has_more: true, page_token: 'more', notice: 'notice' });
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns messages when optional chat permissions are absent, reports missing details', async () => {
    vi.mocked(getAppGrantedScopes).mockResolvedValue(['im:message:readonly', 'search:message']);
    request.mockResolvedValueOnce({
      code: 0,
      data: { items: [{ meta_data: { message_id: 'om_one' } }, { meta_data: { message_id: 'om_missing' } }] },
    });
    request.mockResolvedValueOnce({ code: 0, data: { items: [message('om_one')] } });
    const result = await run(searchName, { query: 'hello' });
    expect(result.messages).toHaveLength(1);
    expect(result.warning).toContain('im:chat:read');
    expect(result.missing_message_ids).toEqual(['om_missing']);
    expect(request).toHaveBeenCalledTimes(2);
    expect(getStoredToken).not.toHaveBeenCalled();
  });

  it('reports API failure instead of returning empty success', async () => {
    request.mockResolvedValue({ code: 234004, msg: 'App not in chat' });
    expect(await run(listName, { chat_id: 'oc_group' })).toEqual({ error: 'App not in chat' });
  });

  it('reports application permissions without an OAuth action', async () => {
    vi.mocked(getAppGrantedScopes).mockResolvedValue(['im:chat:read']);
    const result = await run(searchName, { query: 'hello' });
    expect(result.error).toContain('search:message');
    expect(result).not.toHaveProperty('next_tool_call');
    expect(request).not.toHaveBeenCalled();
    expect(getStoredToken).not.toHaveBeenCalled();
  });

  it('accepts conditional bot permissions and uses API sender names without contacts', async () => {
    vi.mocked(getAppGrantedScopes).mockResolvedValue(['im:message.group_msg']);
    request.mockResolvedValue({
      code: 0,
      data: {
        items: [{ ...message('om_named'), sender: { id: 'ou_sender', sender_type: 'user', sender_name: '张三' } }],
      },
    });
    const result = await run(listName, { chat_id: 'oc_group' });
    expect(result.messages[0].sender.name).toBe('张三');
    expect(request.mock.calls[0][0].params.with_sender_name).toBe('true');
    expect(getStoredToken).not.toHaveBeenCalled();
  });

  it('surfaces search and detail errors instead of silently losing search hits', async () => {
    request.mockResolvedValueOnce({ code: 99991672, msg: 'search permission denied' });
    expect(await run(searchName, { query: 'hello' })).toHaveProperty('error');
    request.mockResolvedValueOnce({ code: 0, data: { items: [{ meta_data: { message_id: 'om_one' } }] } });
    request.mockResolvedValueOnce({ code: 234004, msg: 'App not in chat' });
    expect(await run(searchName, { query: 'hello' })).toEqual({ error: 'App not in chat' });
  });

  it('does not attach user-only scopes to bot actions', () => {
    for (const [action, scopes] of Object.entries(TOOL_SCOPES)) {
      if (!action.startsWith('feishu_im_bot_')) continue;
      expect(
        scopes.some(
          (scope) => scope.includes('get_as_user') || scope.startsWith('contact:') || scope === 'offline_access',
        ),
      ).toBe(false);
    }
  });
});
