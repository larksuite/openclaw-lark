import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LarkAccount } from '../src/core/types';
import { LarkClient } from '../src/core/lark-client';
import { clearUserNameCache, getUserNameCache } from '../src/messaging/inbound/user-name-cache';
import { prefetchChatBots } from '../src/messaging/inbound/user-name-cache';

const noopLog = () => {};

function makeAccount(): LarkAccount {
  return {
    accountId: 'acct1',
    appId: 'cli_test',
    configured: true,
    config: {},
  } as unknown as LarkAccount;
}

describe('prefetchChatBots', () => {
  beforeEach(() => {
    clearUserNameCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls /open-apis/im/v1/chats/{id}/members/bots and seeds cache', async () => {
    const account = makeAccount();
    const requestSpy = vi.fn().mockResolvedValue({
      data: { items: [{ open_id: 'ou_bot1', name: 'BotOne' }, { open_id: 'ou_bot2', name: 'BotTwo' }] },
    });
    vi.spyOn(LarkClient, 'fromAccount').mockReturnValue({
      sdk: { request: requestSpy } as any,
    } as any);

    await prefetchChatBots(account, 'oc_chat1', noopLog);

    expect(requestSpy).toHaveBeenCalledWith({
      method: 'GET',
      url: '/open-apis/im/v1/chats/oc_chat1/members/bots',
      params: {},
    });

    const cache = getUserNameCache('acct1');
    expect(cache.getChatBots('oc_chat1')!.members).toEqual([
      { openId: 'ou_bot1', name: 'BotOne', kind: 'bot' },
      { openId: 'ou_bot2', name: 'BotTwo', kind: 'bot' },
    ]);
    expect(cache.lookupByName('BotOne')).toEqual([{ openId: 'ou_bot1', name: 'BotOne', kind: 'bot' }]);
  });

  it('dedups concurrent calls to same chatId', async () => {
    const account = makeAccount();
    let resolveRequest: (value: any) => void = () => {};
    const requestSpy = vi.fn().mockReturnValue(
      new Promise((res) => {
        resolveRequest = res;
      }),
    );
    vi.spyOn(LarkClient, 'fromAccount').mockReturnValue({
      sdk: { request: requestSpy } as any,
    } as any);

    const p1 = prefetchChatBots(account, 'oc_chat1', noopLog);
    const p2 = prefetchChatBots(account, 'oc_chat1', noopLog);

    expect(requestSpy).toHaveBeenCalledTimes(1); // second call dedups via in-flight cache
    resolveRequest({ data: { items: [{ open_id: 'ou_x', name: 'X' }] } });
    await Promise.all([p1, p2]);
  });

  it('swallows permission error and writes empty list to avoid retry', async () => {
    const account = makeAccount();
    vi.spyOn(LarkClient, 'fromAccount').mockReturnValue({
      sdk: {
        request: vi.fn().mockRejectedValue({ response: { data: { code: 99991663, msg: 'forbidden' } } }),
      } as any,
    } as any);

    await prefetchChatBots(account, 'oc_chat1', noopLog);

    const cache = getUserNameCache('acct1');
    expect(cache.getChatBots('oc_chat1')!.members).toEqual([]);
  });

  it('does not write cache on network error (preserves retry potential)', async () => {
    const account = makeAccount();
    vi.spyOn(LarkClient, 'fromAccount').mockReturnValue({
      sdk: {
        request: vi.fn().mockRejectedValue(new Error('network down')),
      } as any,
    } as any);

    await prefetchChatBots(account, 'oc_chat1', noopLog);

    const cache = getUserNameCache('acct1');
    expect(cache.getChatBots('oc_chat1')).toBeNull(); // not written on network error
  });

  it('skips when account.configured is false', async () => {
    const account = { ...makeAccount(), configured: false } as LarkAccount;
    const requestSpy = vi.fn();
    vi.spyOn(LarkClient, 'fromAccount').mockReturnValue({ sdk: { request: requestSpy } as any } as any);

    await prefetchChatBots(account, 'oc_chat1', noopLog);

    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('skips API call when chatBots cache already fresh', async () => {
    const account = makeAccount();
    // Pre-seed a fresh chatBots entry
    getUserNameCache('acct1').recordChatBots('oc_chat1', [{ openId: 'ou_b', name: 'Bot' }]);

    const requestSpy = vi.fn();
    vi.spyOn(LarkClient, 'fromAccount').mockReturnValue({ sdk: { request: requestSpy } as any } as any);

    await prefetchChatBots(account, 'oc_chat1', noopLog);

    expect(requestSpy).not.toHaveBeenCalled();
  });
});

import { prefetchChatMembers } from '../src/messaging/inbound/user-name-cache';
import { resolveBotName, resolveUserName } from '../src/messaging/inbound/user-name-cache';

describe('prefetchChatMembers', () => {
  beforeEach(() => {
    clearUserNameCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls /open-apis/im/v1/chats/{id}/members and seeds cache with kind from member_type', async () => {
    const account = makeAccount();
    const requestSpy = vi.fn().mockResolvedValue({
      data: {
        items: [
          { open_id: 'ou_u1', name: 'Alice', member_type: 'user' },
          { open_id: 'ou_b1', name: 'Robo', member_type: 'app' },
        ],
      },
    });
    vi.spyOn(LarkClient, 'fromAccount').mockReturnValue({
      sdk: { request: requestSpy } as any,
    } as any);

    await prefetchChatMembers(account, 'oc_chat2', noopLog);

    expect(requestSpy).toHaveBeenCalledWith({
      method: 'GET',
      url: '/open-apis/im/v1/chats/oc_chat2/members',
      params: { member_id_type: 'open_id', page_size: 100 },
    });

    const cache = getUserNameCache('acct1');
    expect(cache.getChatMembers('oc_chat2')!.members).toEqual([
      { openId: 'ou_u1', name: 'Alice', kind: 'user' },
      { openId: 'ou_b1', name: 'Robo', kind: 'bot' },
    ]);
  });

  it('dedups concurrent calls and swallows permission error', async () => {
    const account = makeAccount();
    vi.spyOn(LarkClient, 'fromAccount').mockReturnValue({
      sdk: {
        request: vi.fn().mockRejectedValue({ response: { data: { code: 99991663, msg: 'no scope' } } }),
      } as any,
    } as any);

    await prefetchChatMembers(account, 'oc_chat3', noopLog);

    const cache = getUserNameCache('acct1');
    expect(cache.getChatMembers('oc_chat3')!.members).toEqual([]);
  });

  it('skips API call when chatMembers cache already fresh', async () => {
    const account = makeAccount();
    getUserNameCache('acct1').recordChatMembers('oc_chat4', [
      { openId: 'ou_u', name: 'User', kind: 'user' },
    ]);

    const requestSpy = vi.fn();
    vi.spyOn(LarkClient, 'fromAccount').mockReturnValue({ sdk: { request: requestSpy } as any } as any);

    await prefetchChatMembers(account, 'oc_chat4', noopLog);

    expect(requestSpy).not.toHaveBeenCalled();
  });
});

describe('resolveBotName / resolveUserName: kind tagging', () => {
  beforeEach(() => clearUserNameCache());
  afterEach(() => vi.restoreAllMocks());

  it('resolveBotName tags kind=bot on cache write', async () => {
    const account = makeAccount();
    vi.spyOn(LarkClient, 'fromAccount').mockReturnValue({
      sdk: {
        request: vi.fn().mockResolvedValue({
          data: { bots: { ou_b: { name: 'BotName' } } },
        }),
      } as any,
    } as any);

    const result = await resolveBotName({ account, openId: 'ou_b', log: noopLog });

    expect(result.name).toBe('BotName');
    expect(getUserNameCache('acct1').lookupByName('BotName')).toEqual([
      { openId: 'ou_b', name: 'BotName', kind: 'bot' },
    ]);
  });

  it('resolveUserName tags kind=user on cache write', async () => {
    const account = makeAccount();
    vi.spyOn(LarkClient, 'fromAccount').mockReturnValue({
      sdk: {
        contact: {
          user: {
            get: vi.fn().mockResolvedValue({ data: { user: { name: 'UserName' } } }),
          },
        },
      } as any,
    } as any);

    const result = await resolveUserName({ account, openId: 'ou_u', log: noopLog });

    expect(result.name).toBe('UserName');
    expect(getUserNameCache('acct1').lookupByName('UserName')).toEqual([
      { openId: 'ou_u', name: 'UserName', kind: 'user' },
    ]);
  });
});
