import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LarkAccount } from '../src/core/types';
import { LarkClient } from '../src/core/lark-client';
import {
  clearUserNameCache,
  getUserNameCache,
} from '../src/messaging/inbound/user-name-cache';
import { normalizeOutboundMentions } from '../src/messaging/outbound/normalize-mentions';

const fakeAccount: LarkAccount = {
  accountId: 'acct_t13',
  appId: 'cli',
  configured: true,
  config: {},
} as unknown as LarkAccount;

describe('cache unique hit', () => {
  beforeEach(() => clearUserNameCache());
  afterEach(() => vi.restoreAllMocks());

  it('uses cache openId when single match', async () => {
    // Cache pre-seeded as if by inbound mention enrichment.
    getUserNameCache('acct_t13').setWithKind('ou_alice', 'Alice', 'user');

    const result = await normalizeOutboundMentions(`Hi @Alice`, {
      chatId: 'oc_x',
      account: fakeAccount,
    });

    expect(result.normalizedText).toBe(`Hi <at user_id="ou_alice">Alice</at>`);
    expect(result.sentinels).toEqual([]);
  });
});

describe('ambiguous match emits sentinel', () => {
  beforeEach(() => clearUserNameCache());

  it('emits ambiguous sentinel when cache returns multiple candidates', async () => {
    const cache = getUserNameCache('acct_t13');
    cache.setWithKind('ou_a', 'Zhang', 'user');
    cache.setWithKind('ou_b', 'Zhang', 'user');

    const result = await normalizeOutboundMentions(`Hi @Zhang`, {
      chatId: 'oc_x',
      account: fakeAccount,
    });

    expect(result.normalizedText).toBe(`Hi @Zhang`); // original text preserved
    expect(result.sentinels).toHaveLength(1);
    expect(result.sentinels[0].reason).toBe('ambiguous');
    expect(result.sentinels[0].candidates).toHaveLength(2);
  });
});

describe('cache miss → lazy chat-member fetch', () => {
  beforeEach(() => clearUserNameCache());
  afterEach(() => vi.restoreAllMocks());

  it('triggers prefetchChatBots on miss and resolves', async () => {
    vi.spyOn(LarkClient, 'fromAccount').mockReturnValue({
      sdk: {
        request: vi.fn().mockResolvedValue({
          data: { items: [{ open_id: 'ou_bot_c', name: 'BotC' }] },
        }),
      } as any,
    } as any);

    const result = await normalizeOutboundMentions(`Hi @BotC`, {
      chatId: 'oc_x',
      account: fakeAccount,
    });

    expect(result.normalizedText).toBe(`Hi <at user_id="ou_bot_c">BotC</at>`);
  });

  it('falls back to prefetchChatMembers when chat-bots is empty', async () => {
    let calls = 0;
    vi.spyOn(LarkClient, 'fromAccount').mockReturnValue({
      sdk: {
        request: vi.fn().mockImplementation(({ url }: any) => {
          calls += 1;
          if (url.includes('/members/bots')) {
            return { data: { items: [] } };
          }
          // /members
          return { data: { items: [{ open_id: 'ou_user_c', name: 'CharlieUser', member_type: 'user' }] } };
        }),
      } as any,
    } as any);

    const result = await normalizeOutboundMentions(`Hi @CharlieUser`, {
      chatId: 'oc_x',
      account: fakeAccount,
    });

    expect(calls).toBe(2);
    expect(result.normalizedText).toBe(`Hi <at user_id="ou_user_c">CharlieUser</at>`);
  });

  it('drops candidate (no sentinel) when both lazy fetches return empty', async () => {
    // Cache miss + chat-bots miss + chat-members miss → drop. Emitting a
    // not_found sentinel here would mislead next-turn disambiguation
    // because the regex matches CJK runs after `@` that are usually not
    // real mentions (pronouns, short noun phrases).
    vi.spyOn(LarkClient, 'fromAccount').mockReturnValue({
      sdk: {
        request: vi.fn().mockResolvedValue({ data: { items: [] } }),
      } as any,
    } as any);

    const result = await normalizeOutboundMentions(`Hi @PhantomUser`, {
      chatId: 'oc_x',
      account: fakeAccount,
    });

    expect(result.normalizedText).toBe(`Hi @PhantomUser`);
    expect(result.sentinels).toEqual([]);
  });
});

describe('rename scenario', () => {
  beforeEach(() => clearUserNameCache());

  it('after rename old name is not resolvable', async () => {
    const cache = getUserNameCache('acct_t13');
    cache.setWithKind('ou_a', 'OldName', 'user');
    cache.setWithKind('ou_a', 'NewName', 'user'); // rename

    const result = await normalizeOutboundMentions(`Hi @OldName`, {
      chatId: 'oc_x',
      account: fakeAccount,
    });

    // OldName must no longer resolve; a full cache + lazy-fetch miss emits no sentinel.
    expect(result.normalizedText).toBe(`Hi @OldName`);
    expect(result.sentinels).toEqual([]);

    const result2 = await normalizeOutboundMentions(`Hi @NewName`, {
      chatId: 'oc_x',
      account: fakeAccount,
    });
    expect(result2.normalizedText).toBe(`Hi <at user_id="ou_a">NewName</at>`);
  });
});
