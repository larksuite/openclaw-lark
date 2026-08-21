/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Verifies the reaction reply policy (`reactionNotifications`):
 *
 *   - "off"  — reactions never reach the agent (resolveReactionContext null).
 *   - "own"  — only reactions on the bot's own messages are dispatched.
 *   - "all"  — reactions on any message are dispatched.
 *
 * In every mode the policy gate still enforces group admission, sender
 * allowlists, and DM pairing; only the @-mention requirement is waived
 * (the mode itself IS the policy — reaction events can never carry a
 * mention).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import type { HistoryEntry } from 'openclaw/plugin-sdk/reply-history';
import type { FeishuMessageInfo } from '../src/messaging/shared/message-lookup';
import type { FeishuReactionCreatedEvent } from '../src/messaging/types';
import type { ReactionContext } from '../src/messaging/inbound/reaction-handler';
import { setLarkRuntime } from '../src/core/runtime-store';

const { dispatchToAgentMock, resolveUserNameMock, getMessageFeishuMock, isThreadCapableGroupMock } = vi.hoisted(
  () => ({
    dispatchToAgentMock: vi.fn(),
    resolveUserNameMock: vi.fn(),
    getMessageFeishuMock: vi.fn(),
    isThreadCapableGroupMock: vi.fn(),
  }),
);

vi.mock('../src/messaging/inbound/dispatch', () => ({
  dispatchToAgent: dispatchToAgentMock,
}));

vi.mock('../src/messaging/inbound/user-name-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/messaging/inbound/user-name-cache')>();
  return {
    ...actual,
    resolveUserName: resolveUserNameMock,
  };
});

vi.mock('../src/messaging/shared/message-lookup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/messaging/shared/message-lookup')>();
  return {
    ...actual,
    getMessageFeishu: getMessageFeishuMock,
  };
});

vi.mock('../src/core/chat-info-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/chat-info-cache')>();
  return {
    ...actual,
    getChatTypeFeishu: vi.fn(async () => 'group'),
    isThreadCapableGroup: isThreadCapableGroupMock,
  };
});

vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { handleFeishuReaction, resolveReactionContext } from '../src/messaging/inbound/reaction-handler';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GROUP_CHAT = 'oc_g1';
const BOT_APP_ID = 'cli_x';
const OPERATOR = 'ou_reactor';
const OTHER = 'ou_other';
const MESSAGE_ID = 'om_123';

function makeEvent(overrides: Partial<FeishuReactionCreatedEvent> = {}): FeishuReactionCreatedEvent {
  return {
    message_id: MESSAGE_ID,
    reaction_type: { emoji_type: '👍' },
    operator_type: 'user',
    user_id: { open_id: OPERATOR },
    action_time: String(Date.now()),
    ...overrides,
  };
}

function makeMsg(overrides: Partial<FeishuMessageInfo> = {}): FeishuMessageInfo {
  return {
    messageId: MESSAGE_ID,
    chatId: GROUP_CHAT,
    chatType: 'group',
    senderId: OTHER,
    senderType: 'user',
    content: '今天天气不错',
    contentType: 'text',
    ...overrides,
  };
}

function makePreResolved(overrides: Partial<ReactionContext> = {}): ReactionContext {
  return {
    chatId: GROUP_CHAT,
    chatType: 'group',
    msg: makeMsg(),
    ...overrides,
  };
}

function makeCfg(feishu: Record<string, unknown> = {}): ClawdbotConfig {
  return {
    channels: { feishu: { appId: BOT_APP_ID, appSecret: 's', ...feishu } },
  } as unknown as ClawdbotConfig;
}

function dispatchReaction(params: {
  cfg: ClawdbotConfig;
  preResolved: ReactionContext;
  chatHistories?: Map<string, HistoryEntry[]>;
}): Promise<void> {
  return handleFeishuReaction({
    cfg: params.cfg,
    event: makeEvent(),
    botOpenId: 'ou_bot',
    accountId: 'a1',
    chatHistories: params.chatHistories,
    preResolved: params.preResolved,
  });
}

// ---------------------------------------------------------------------------
// SDK runtime mock (same shape as gate-bot-sender.test.ts, plus pairing)
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  resolveUserNameMock.mockResolvedValue({});
  getMessageFeishuMock.mockResolvedValue(null);
  isThreadCapableGroupMock.mockResolvedValue(false);
  setLarkRuntime({
    channel: {
      groups: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        resolveGroupPolicy: ({ cfg, channel, groupId }: any) => {
          const ch = cfg?.channels?.[channel] ?? {};
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        resolveRequireMention: ({ cfg, channel, groupId, requireMentionOverride }: any) => {
          const ch = cfg?.channels?.[channel] ?? {};
          const groups = ch.groups ?? {};
          const groupCfg = groups[groupId ?? ''] ?? {};
          return groupCfg.requireMention ?? groups['*']?.requireMention ?? requireMentionOverride ?? true;
        },
      },
      pairing: {
        readAllowFromStore: async () => [] as string[],
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
});

// ---------------------------------------------------------------------------
// Tests: mode filtering in resolveReactionContext
// ---------------------------------------------------------------------------

describe('resolveReactionContext — mode = reply policy', () => {
  it("'off' never resolves a context (no reply at all)", async () => {
    const ctx = await resolveReactionContext({
      cfg: makeCfg({ reactionNotifications: 'off' }),
      event: makeEvent(),
      botOpenId: 'ou_bot',
      accountId: 'a1',
    });

    expect(ctx).toBeNull();
    expect(getMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("'own' drops reactions on other people's messages", async () => {
    getMessageFeishuMock.mockResolvedValue(makeMsg());

    const ctx = await resolveReactionContext({
      cfg: makeCfg({ reactionNotifications: 'own' }),
      event: makeEvent(),
      botOpenId: 'ou_bot',
      accountId: 'a1',
    });

    expect(ctx).toBeNull();
  });

  it("'own' keeps reactions on the bot's own message and dispatches them", async () => {
    getMessageFeishuMock.mockResolvedValue(makeMsg({ senderId: BOT_APP_ID, senderType: 'app' }));

    const preResolved = await resolveReactionContext({
      cfg: makeCfg({ reactionNotifications: 'own' }),
      event: makeEvent(),
      botOpenId: 'ou_bot',
      accountId: 'a1',
    });

    expect(preResolved).not.toBeNull();

    await handleFeishuReaction({
      cfg: makeCfg({ reactionNotifications: 'own' }),
      event: makeEvent(),
      botOpenId: 'ou_bot',
      accountId: 'a1',
      preResolved: preResolved!,
    });

    expect(dispatchToAgentMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: gate enforcement in handleFeishuReaction
// ---------------------------------------------------------------------------

describe('handleFeishuReaction policy gate', () => {
  it("'all' dispatches a group reaction on another user's message (mention waived by mode)", async () => {
    await dispatchReaction({
      cfg: makeCfg({ reactionNotifications: 'all' }),
      preResolved: makePreResolved(),
    });

    expect(dispatchToAgentMock).toHaveBeenCalledTimes(1);
  });

  it('still drops reactions in groups blocked by group-level policy', async () => {
    await dispatchReaction({
      cfg: makeCfg({ reactionNotifications: 'all', groupPolicy: 'disabled' }),
      preResolved: makePreResolved(),
    });

    expect(dispatchToAgentMock).not.toHaveBeenCalled();
  });

  it('still drops reactions from senders not on the group allowlist', async () => {
    await dispatchReaction({
      cfg: makeCfg({
        reactionNotifications: 'all',
        groups: { [GROUP_CHAT]: { groupPolicy: 'allowlist', allowFrom: ['ou_allowed'] } },
      }),
      preResolved: makePreResolved(),
    });

    expect(dispatchToAgentMock).not.toHaveBeenCalled();
  });

  it('still applies the DM gate (allowlist) to reactions in p2p chats', async () => {
    await dispatchReaction({
      cfg: makeCfg({ reactionNotifications: 'all', dmPolicy: 'allowlist', allowFrom: [] }),
      preResolved: makePreResolved({ chatId: OPERATOR, chatType: 'p2p' }),
    });

    expect(dispatchToAgentMock).not.toHaveBeenCalled();
  });

  it('does not record gate-rejected reactions into chat history', async () => {
    const histories = new Map<string, HistoryEntry[]>();

    await dispatchReaction({
      cfg: makeCfg({ reactionNotifications: 'all', groupPolicy: 'disabled' }),
      preResolved: makePreResolved(),
      chatHistories: histories,
    });

    expect(dispatchToAgentMock).not.toHaveBeenCalled();
    expect(histories.size).toBe(0);
  });
});
