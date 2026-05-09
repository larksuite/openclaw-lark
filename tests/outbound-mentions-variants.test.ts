import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeOutboundMentions } from '../src/messaging/outbound/normalize-mentions';
import { normalizeOutboundMentionsTagPass } from '../src/messaging/outbound/normalize-mentions';
import type { LarkAccount } from '../src/core/types';
import { clearUserNameCache, getUserNameCache } from '../src/messaging/inbound/user-name-cache';

describe('tag-level normalization', () => {
  it('passes through standard <at user_id="ou_xxx">Name</at>', () => {
    const t = '<at user_id="ou_abc">Alice</at> hi';
    expect(normalizeOutboundMentionsTagPass(t)).toBe(t);
  });

  it('normalizes single-quoted user_id', () => {
    expect(
      normalizeOutboundMentionsTagPass(`<at user_id='ou_abc'>Alice</at>`),
    ).toBe(`<at user_id="ou_abc">Alice</at>`);
  });

  it('normalizes unquoted user_id', () => {
    expect(normalizeOutboundMentionsTagPass(`<at user_id=ou_abc>Alice</at>`)).toBe(
      `<at user_id="ou_abc">Alice</at>`,
    );
  });

  it('normalizes id= attribute (card syntax leaked to post)', () => {
    expect(normalizeOutboundMentionsTagPass(`<at id="ou_abc">Alice</at>`)).toBe(
      `<at user_id="ou_abc">Alice</at>`,
    );
    expect(normalizeOutboundMentionsTagPass(`<at id=ou_abc></at>`)).toBe(
      `<at user_id="ou_abc"></at>`,
    );
  });

  it('normalizes open_id= attribute', () => {
    expect(normalizeOutboundMentionsTagPass(`<at open_id="ou_abc">Alice</at>`)).toBe(
      `<at user_id="ou_abc">Alice</at>`,
    );
  });

  it('normalizes <at id=all> and <at user_id="all">', () => {
    expect(normalizeOutboundMentionsTagPass(`<at id=all></at>`)).toBe(
      `<at user_id="all">Everyone</at>`,
    );
    expect(normalizeOutboundMentionsTagPass(`<at user_id="all"></at>`)).toBe(
      `<at user_id="all">Everyone</at>`,
    );
  });

  it('@all is idempotent: canonical input unchanged on second pass', () => {
    const canonical = `<at user_id="all">Everyone</at>`;
    expect(normalizeOutboundMentionsTagPass(canonical)).toBe(canonical);
    expect(normalizeOutboundMentionsTagPass(normalizeOutboundMentionsTagPass(canonical))).toBe(canonical);
  });

  it('preserves <person id="ou_xxx"> as-is (legitimate Feishu picker tag)', () => {
    const t = `<person id='ou_abc'></person>`;
    expect(normalizeOutboundMentionsTagPass(t)).toBe(t);
  });
});

const fakeAccount = { accountId: 'acct_t12', appId: 'cli', configured: true, config: {} } as unknown as LarkAccount;

describe('multi-wrap cleanup', () => {
  beforeEach(() => clearUserNameCache());
  afterEach(() => vi.restoreAllMocks());

  it('strips @ prefix from already-wrapped <at>', async () => {
    const result = await normalizeOutboundMentions(
      `hi @<at user_id="ou_abc">Alice</at> there`,
      { chatId: 'oc_x', account: fakeAccount },
    );
    expect(result.normalizedText).toBe(`hi <at user_id="ou_abc">Alice</at> there`);
  });
});

describe('plain @all aliases', () => {
  beforeEach(() => clearUserNameCache());

  it('rewrites plain "@所有人" to <at user_id="all">Everyone</at>', async () => {
    const result = await normalizeOutboundMentions(`@所有人 测试`, {
      chatId: 'oc_x',
      account: fakeAccount,
    });
    expect(result.normalizedText).toBe(`<at user_id="all">Everyone</at> 测试`);
    expect(result.sentinels).toEqual([]);
  });

  it('rewrites plain "@everyone" (case-insensitive) to canonical @all', async () => {
    const result = await normalizeOutboundMentions(`Hi @Everyone, ready?`, {
      chatId: 'oc_x',
      account: fakeAccount,
    });
    expect(result.normalizedText).toBe(`Hi <at user_id="all">Everyone</at>, ready?`);
  });

  it('rewrites plain "@all" to canonical @all', async () => {
    const result = await normalizeOutboundMentions(`@all heads up`, {
      chatId: 'oc_x',
      account: fakeAccount,
    });
    expect(result.normalizedText).toBe(`<at user_id="all">Everyone</at> heads up`);
  });

  it('"@allusers" / "@Allen" remain plain (alias check is exact)', async () => {
    const r1 = await normalizeOutboundMentions(`@allusers ping`, {
      chatId: 'oc_x',
      account: fakeAccount,
    });
    expect(r1.normalizedText).toBe(`@allusers ping`);

    const r2 = await normalizeOutboundMentions(`hi @Allen`, {
      chatId: 'oc_x',
      account: fakeAccount,
    });
    expect(r2.normalizedText).toBe(`hi @Allen`);
  });
});

describe('plain @Name masking', () => {
  beforeEach(() => clearUserNameCache());

  it('skips @ in fenced code blocks', async () => {
    const t = '```\n@Name\n```';
    const result = await normalizeOutboundMentions(t, { chatId: 'oc_x', account: fakeAccount });
    expect(result.normalizedText).toBe(t);
    expect(result.sentinels).toEqual([]);
  });

  it('skips email-like @', async () => {
    const t = 'Email me at alice@example.com please';
    const result = await normalizeOutboundMentions(t, { chatId: 'oc_x', account: fakeAccount });
    expect(result.normalizedText).toBe(t);
    expect(result.sentinels).toEqual([]);
  });

  it('skips @ inside URLs (handle in path / query)', async () => {
    const cases = [
      'see https://twitter.com/@elonmusk for news',
      'docs at https://github.com/@user/repo',
      'click [link](https://twitter.com/@user) here',
      'support: mailto://team@company.com',
    ];
    for (const t of cases) {
      const result = await normalizeOutboundMentions(t, { chatId: 'oc_x', account: fakeAccount });
      expect(result.normalizedText, `case: ${t}`).toBe(t);
      expect(result.sentinels, `case: ${t}`).toEqual([]);
    }
  });

  it('idempotent: running twice gives same output', async () => {
    getUserNameCache('acct_t12').setWithKind('ou_a', 'Alice', 'user');
    const t = `<at user_id="ou_a">Alice</at> @Bob`;
    const r1 = await normalizeOutboundMentions(t, { chatId: 'oc_x', account: fakeAccount });
    const r2 = await normalizeOutboundMentions(r1.normalizedText, { chatId: 'oc_x', account: fakeAccount });
    expect(r2.normalizedText).toBe(r1.normalizedText);
  });
});
