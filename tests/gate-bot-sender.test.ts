import { beforeAll, describe, expect, it } from 'vitest';
import type { MessageContext } from '../src/messaging/types';
import type { LarkAccount, FeishuConfig } from '../src/core/types';
import { checkMessageGate } from '../src/messaging/inbound/gate';
import { setLarkRuntime } from '../src/core/runtime-store';

// Minimal PluginRuntime mock — only the channel.groups APIs that gate.ts touches.
beforeAll(() => {
  setLarkRuntime({
    channel: {
      groups: {
        resolveGroupPolicy: ({
          cfg,
          channel,
          groupId,
        }: {
          cfg: { channels?: Record<string, { groupPolicy?: string; groups?: Record<string, unknown> }> };
          channel: string;
          groupId?: string | null;
        }) => {
          const ch = cfg.channels?.[channel] ?? {};
          const groupPolicy = ch.groupPolicy;
          const groups = ch.groups ?? {};
          const hasGroups = Object.keys(groups).length > 0;
          if (groupPolicy === 'disabled') {
            return { allowed: false, allowlistEnabled: true };
          }
          if (hasGroups || groupPolicy === 'allowlist') {
            const allowed = Boolean(groups[groupId ?? ''] || groups['*']);
            return { allowed, allowlistEnabled: true };
          }
          return { allowed: true, allowlistEnabled: false };
        },
        resolveRequireMention: ({
          cfg,
          channel,
          groupId,
          requireMentionOverride,
        }: {
          cfg: { channels?: Record<string, { groups?: Record<string, { requireMention?: boolean }> }> };
          channel: string;
          groupId?: string | null;
          requireMentionOverride?: boolean;
        }): boolean => {
          const ch = cfg.channels?.[channel] ?? {};
          const groups = ch.groups ?? {};
          const groupCfg = groups[groupId ?? ''] ?? {};
          return groupCfg.requireMention ?? groups['*']?.requireMention ?? requireMentionOverride ?? true;
        },
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
});

function makeCtx(overrides: Partial<MessageContext> = {}): MessageContext {
  return {
    chatId: 'oc_1',
    messageId: 'msg_1',
    senderId: 'ou_bot_b',
    chatType: 'group',
    content: 'hi',
    contentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    senderIsBot: true,
    rawMessage: {} as never,
    rawSender: { sender_id: { open_id: 'ou_bot_b' }, sender_type: 'bot' },
    ...overrides,
  };
}

const acct: LarkAccount = {
  accountId: 'a1',
  enabled: true,
  brand: 'feishu',
  configured: true,
  appId: 'cli_x',
  appSecret: 's',
  config: {} as FeishuConfig,
};

describe('checkMessageGate with bot sender', () => {
  it("defaults to 'mentions' in groups → unmentioned bot is dropped", async () => {
    const r = await checkMessageGate({
      ctx: makeCtx(),
      accountFeishuCfg: {} as FeishuConfig,
      account: acct,
      accountScopedCfg: { channels: { feishu: {} } } as never,
      log: () => {},
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('bot_sender_not_mentioned');
  });

  it("defaults to 'mentions' in groups → mentioned bot passes", async () => {
    const r = await checkMessageGate({
      ctx: makeCtx({
        mentions: [{ key: '@_1', openId: 'ou_me', name: 'Me', isBot: true }],
      }),
      accountFeishuCfg: {} as FeishuConfig,
      account: acct,
      accountScopedCfg: { channels: { feishu: {} } } as never,
      log: () => {},
    });
    expect(r.allowed).toBe(true);
  });

  it("defaults to 'mentions' in DM → pass-through", async () => {
    const r = await checkMessageGate({
      ctx: makeCtx({ chatType: 'p2p' }),
      accountFeishuCfg: {} as FeishuConfig,
      account: acct,
      accountScopedCfg: { channels: { feishu: {} } } as never,
      log: () => {},
    });
    expect(r.allowed).toBe(true);
  });

  it('rejects when allowBots=false', async () => {
    const r = await checkMessageGate({
      ctx: makeCtx(),
      accountFeishuCfg: { allowBots: false } as FeishuConfig,
      account: acct,
      accountScopedCfg: { channels: { feishu: { allowBots: false } } } as never,
      log: () => {},
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('bot_sender_disabled');
  });

  it('rejects when allowBots="mentions" and bot not mentioned', async () => {
    const r = await checkMessageGate({
      ctx: makeCtx({ mentions: [] }),
      accountFeishuCfg: { allowBots: 'mentions' } as FeishuConfig,
      account: acct,
      accountScopedCfg: { channels: { feishu: { allowBots: 'mentions' } } } as never,
      log: () => {},
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('bot_sender_not_mentioned');
  });

  it('passes when allowBots="mentions" and bot is mentioned', async () => {
    const r = await checkMessageGate({
      ctx: makeCtx({
        mentions: [{ key: '@_1', openId: 'ou_me', name: 'Me', isBot: true }],
      }),
      accountFeishuCfg: { allowBots: 'mentions' } as FeishuConfig,
      account: acct,
      accountScopedCfg: { channels: { feishu: { allowBots: 'mentions' } } } as never,
      log: () => {},
    });
    expect(r.allowed).toBe(true);
  });

  it('allowBots="mentions" in DM → pass-through (mentions do not apply in p2p)', async () => {
    const r = await checkMessageGate({
      ctx: makeCtx({ chatType: 'p2p', mentions: [] }),
      accountFeishuCfg: { allowBots: 'mentions' } as FeishuConfig,
      account: acct,
      accountScopedCfg: { channels: { feishu: { allowBots: 'mentions' } } } as never,
      log: () => {},
    });
    expect(r.allowed).toBe(true);
  });

  it('passes with allowBots=true', async () => {
    const r = await checkMessageGate({
      ctx: makeCtx(),
      accountFeishuCfg: { allowBots: true } as FeishuConfig,
      account: acct,
      accountScopedCfg: { channels: { feishu: { allowBots: true } } } as never,
      log: () => {},
    });
    expect(r.allowed).toBe(true);
  });

  it('allowBots=true with explicit requireMention=true + not mentioned → drop (no_mention)', async () => {
    const r = await checkMessageGate({
      ctx: makeCtx(),  // empty mentions
      accountFeishuCfg: {
        allowBots: true,
        requireMention: true,
      } as unknown as FeishuConfig,
      account: acct,
      accountScopedCfg: {
        channels: { feishu: { allowBots: true, requireMention: true } },
      } as never,
      log: () => {},
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('no_mention');
  });

  it('allowBots=true with requireMention unset + not mentioned → allowed (bot path defaults requireMention=false)', async () => {
    const r = await checkMessageGate({
      ctx: makeCtx(),  // empty mentions, no requireMention in cfg
      accountFeishuCfg: { allowBots: true } as FeishuConfig,
      account: acct,
      accountScopedCfg: { channels: { feishu: { allowBots: true } } } as never,
      log: () => {},
    });
    expect(r.allowed).toBe(true);
  });

  it('group-level allowBots overrides account-level', async () => {
    const r = await checkMessageGate({
      ctx: makeCtx(),
      accountFeishuCfg: {
        allowBots: false,
        groups: { oc_1: { allowBots: true } },
      } as unknown as FeishuConfig,
      account: acct,
      accountScopedCfg: {
        channels: {
          feishu: {
            allowBots: false,
            groups: { oc_1: { allowBots: true } },
          },
        },
      } as never,
      log: () => {},
    });
    expect(r.allowed).toBe(true);
  });

  it('does NOT consult allowFrom — bot sender bypasses allowlist', async () => {
    const r = await checkMessageGate({
      ctx: makeCtx({ chatType: 'p2p' }),
      accountFeishuCfg: {
        allowBots: true,
        dmPolicy: 'allowlist',
        allowFrom: [],
      } as unknown as FeishuConfig,
      account: acct,
      accountScopedCfg: {
        channels: { feishu: { allowBots: true, dmPolicy: 'allowlist', allowFrom: [] } },
      } as never,
      log: () => {},
    });
    expect(r.allowed).toBe(true);
  });

  // ---- Layer 1 group access — bot senders subject to same admission as humans ----

  it('rejects bot sender when groupPolicy=disabled even if allowBots=true', async () => {
    const r = await checkMessageGate({
      ctx: makeCtx(),
      accountFeishuCfg: {
        allowBots: true,
        groupPolicy: 'disabled',
      } as unknown as FeishuConfig,
      account: acct,
      accountScopedCfg: {
        channels: { feishu: { allowBots: true, groupPolicy: 'disabled' } },
      } as never,
      log: () => {},
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('group_not_allowed');
  });

  it('rejects bot sender when the matching per-group config is disabled', async () => {
    const r = await checkMessageGate({
      ctx: makeCtx(),
      accountFeishuCfg: {
        allowBots: true,
        groups: { oc_1: { enabled: false } },
      } as unknown as FeishuConfig,
      account: acct,
      accountScopedCfg: {
        channels: { feishu: { allowBots: true, groups: { oc_1: { enabled: false } } } },
      } as never,
      log: () => {},
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('group_disabled');
  });

  it('rejects bot sender when the chat is not in the group allowlist', async () => {
    // groups configured but ctx.chatId (oc_1) is not among them → group access denied
    const r = await checkMessageGate({
      ctx: makeCtx(),
      accountFeishuCfg: {
        allowBots: true,
        groups: { oc_other: {} },
      } as unknown as FeishuConfig,
      account: acct,
      accountScopedCfg: {
        channels: { feishu: { allowBots: true, groups: { oc_other: {} } } },
      } as never,
      log: () => {},
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('group_not_allowed');
  });

});
