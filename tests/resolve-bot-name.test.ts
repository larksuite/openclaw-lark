/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Behavior contract for resolveBotName.
 *
 * Aligned with upstream PR #89783's bot-name resolver design:
 *   - calls /open-apis/bot/v3/bots/basic_batch (contact API can't see bots)
 *   - shares the account-scoped LRU+TTL cache so repeated lookups stay cheap
 *   - i18n-names fallback chain (zh_cn → en_us)
 *   - best-effort on permission errors (don't surface as agent-visible)
 *
 * The local fork already implemented this functionality in
 * src/messaging/inbound/user-name-cache.ts; this test pins the behavior so
 * future refactors don't accidentally regress the bot-at-bot reception path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearUserNameCache, getUserNameCache, resolveBotName } from '../src/messaging/inbound/user-name-cache';
import type { LarkAccount } from '../src/core/types';

const requestMock = vi.fn();

vi.mock('../src/core/lark-client', () => ({
  LarkClient: {
    fromAccount: () => ({
      sdk: { request: (...args: unknown[]) => requestMock(...args) },
    }),
  },
}));

const account = {
  accountId: 'acct1',
  appId: 'cli_test',
  configured: true as const,
  enabled: true,
  brand: 'feishu' as const,
  config: {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as unknown as LarkAccount;

const noopLog = () => undefined;

beforeEach(() => {
  requestMock.mockReset();
  clearUserNameCache(account.accountId);
});

afterEach(() => {
  clearUserNameCache(account.accountId);
});

describe('resolveBotName', () => {
  it('resolves a bot name via /open-apis/bot/v3/bots/basic_batch', async () => {
    requestMock.mockResolvedValueOnce({
      data: { bots: { ou_bot: { name: 'AlphaBot' } } },
    });
    const r = await resolveBotName({ account, openId: 'ou_bot', log: noopLog });
    expect(r.name).toBe('AlphaBot');
    expect(requestMock).toHaveBeenCalledWith({
      method: 'GET',
      url: '/open-apis/bot/v3/bots/basic_batch',
      params: { bot_ids: ['ou_bot'] },
    });
  });

  it('falls back to i18n_names.zh_cn when name field is empty', async () => {
    requestMock.mockResolvedValueOnce({
      data: { bots: { ou_bot: { name: '', i18n_names: { zh_cn: '阿尔法机器人', en_us: 'AlphaBot' } } } },
    });
    const r = await resolveBotName({ account, openId: 'ou_bot', log: noopLog });
    expect(r.name).toBe('阿尔法机器人');
  });

  it('falls back to i18n_names.en_us when name and zh_cn are empty', async () => {
    requestMock.mockResolvedValueOnce({
      data: { bots: { ou_bot: { name: '', i18n_names: { en_us: 'AlphaBot' } } } },
    });
    const r = await resolveBotName({ account, openId: 'ou_bot', log: noopLog });
    expect(r.name).toBe('AlphaBot');
  });

  it('serves a second call from cache without re-calling the API', async () => {
    requestMock.mockResolvedValueOnce({
      data: { bots: { ou_bot: { name: 'AlphaBot' } } },
    });
    await resolveBotName({ account, openId: 'ou_bot', log: noopLog });
    await resolveBotName({ account, openId: 'ou_bot', log: noopLog });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('caches an empty name when the bot has no resolvable display name', async () => {
    requestMock.mockResolvedValueOnce({ data: { bots: {} } });
    const r = await resolveBotName({ account, openId: 'ou_bot', log: noopLog });
    expect(r.name).toBeUndefined();
    // Second call must not hit the API — empty-name caching prevents retry storms.
    await resolveBotName({ account, openId: 'ou_bot', log: noopLog });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('swallows permission errors and caches empty (no agent-visible failure)', async () => {
    requestMock.mockRejectedValueOnce({
      response: { data: { code: 99991663, msg: 'permission denied' } },
    });
    const r = await resolveBotName({ account, openId: 'ou_bot', log: noopLog });
    expect(r.name).toBeUndefined();
    expect(r.permissionError).toBeUndefined();
    // Cached: no second API call.
    await resolveBotName({ account, openId: 'ou_bot', log: noopLog });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('swallows network errors and caches empty (graceful degradation)', async () => {
    requestMock.mockRejectedValueOnce(new Error('network down'));
    const r = await resolveBotName({ account, openId: 'ou_bot', log: noopLog });
    expect(r.name).toBeUndefined();
  });

  it('returns empty when account is not configured', async () => {
    const r = await resolveBotName({
      account: { ...account, configured: false },
      openId: 'ou_bot',
      log: noopLog,
    });
    expect(r.name).toBeUndefined();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('shares the account-scoped cache with user-name lookups', async () => {
    requestMock.mockResolvedValueOnce({
      data: { bots: { ou_bot: { name: 'AlphaBot' } } },
    });
    await resolveBotName({ account, openId: 'ou_bot', log: noopLog });
    const cache = getUserNameCache(account.accountId);
    expect(cache.get('ou_bot')).toBe('AlphaBot');
  });
});
