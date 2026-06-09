/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Integration test: handleFeishuMessage keys the bot-loop guard by
 * `threadId ?? rootId`. Topic-group reply events often carry only root_id
 * (thread_id is inferred later in dispatch), so the guard must fall back to
 * root_id to count per-topic — matching the dispatch/queue key — instead of
 * merging all topics into one chat-level counter.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockParseMessageEvent = vi.fn();
const mockResolveSenderInfo = vi.fn();
const mockResolveMedia = vi.fn();
const mockResolveQuotedContent = vi.fn();
const noteBotTurnAndCheckMock = vi.fn((..._args: unknown[]) => ({ allowed: true, count: 1, limit: 10 }));
const resetBotLoopMock = vi.fn();

vi.mock('../src/messaging/inbound/parse', () => ({
  parseMessageEvent: (...a: unknown[]) => mockParseMessageEvent(...a),
}));
vi.mock('../src/messaging/inbound/enrich', () => ({
  resolveSenderInfo: (...a: unknown[]) => mockResolveSenderInfo(...a),
  prefetchUserNames: vi.fn(),
  resolveMedia: (...a: unknown[]) => mockResolveMedia(...a),
  resolveQuotedContent: (...a: unknown[]) => mockResolveQuotedContent(...a),
  substituteMediaPaths: vi.fn(),
}));
vi.mock('../src/messaging/inbound/gate', () => ({
  checkMessageGate: vi.fn().mockResolvedValue({ allowed: true }),
  readFeishuAllowFromStore: vi.fn().mockResolvedValue([]),
}));
vi.mock('../src/messaging/inbound/handler-registry', () => ({ injectInboundHandler: vi.fn() }));
vi.mock('../src/messaging/inbound/dispatch', () => ({ dispatchToAgent: vi.fn() }));
vi.mock('../src/messaging/inbound/policy', () => ({
  resolveFeishuGroupConfig: vi.fn(),
  splitLegacyGroupAllowFrom: vi.fn().mockReturnValue({ senderAllowFrom: [] }),
}));
vi.mock('../src/messaging/inbound/bot-loop-guard', () => ({
  noteBotTurnAndCheck: (...a: unknown[]) => noteBotTurnAndCheckMock(...a),
  resetBotLoop: (...a: unknown[]) => resetBotLoopMock(...a),
}));
vi.mock('../src/core/accounts', () => ({
  getLarkAccount: vi.fn().mockReturnValue({ accountId: 'test-account', config: {}, enabled: true, configured: true }),
}));
vi.mock('../src/core/lark-client', () => ({
  LarkClient: {
    runtime: { channel: { commands: { shouldComputeCommandAuthorized: false, resolveCommandAuthorizedFromAuthorizers: vi.fn() } } },
  },
}));
vi.mock('../src/core/lark-logger', () => ({ larkLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../src/core/lark-ticket', () => ({ ticketElapsed: () => 1 }));
vi.mock('../src/channel/chat-queue', () => ({
  threadScopedKey: (chatId: string, threadId?: string) => `${chatId}:${threadId ?? ''}`,
}));
vi.mock('openclaw/plugin-sdk/reply-history', () => ({
  DEFAULT_GROUP_HISTORY_LIMIT: 20,
  recordPendingHistoryEntryIfEnabled: vi.fn(),
}));
vi.mock('openclaw/plugin-sdk/command-auth', () => ({
  resolveSenderCommandAuthorization: vi.fn().mockResolvedValue({ commandAuthorized: false }),
}));
vi.mock('openclaw/plugin-sdk/allow-from', () => ({ isNormalizedSenderAllowed: vi.fn().mockReturnValue(false) }));

import { handleFeishuMessage } from '../src/messaging/inbound/handler';

// Topic-group ctx: root_id present, thread_id absent.
function makeCtx(senderIsBot: boolean) {
  return {
    chatId: 'oc_topic',
    messageId: 'om_msg',
    senderId: senderIsBot ? 'ou_peer_bot' : 'ou_human',
    senderName: senderIsBot ? 'PeerBot' : 'Human',
    chatType: 'group' as const,
    content: 'hi',
    contentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    senderIsBot,
    threadId: undefined,
    rootId: 'om_root',
  };
}

const cfg = { channels: { feishu: {} } } as never;
const event = { sender: { sender_id: { open_id: 'x' } }, message: { message_id: 'om_msg', chat_id: 'oc_topic' } };

describe('handleFeishuMessage — bot-loop guard keys by threadId ?? rootId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveMedia.mockResolvedValue({ mediaList: [], payload: undefined });
    mockResolveQuotedContent.mockResolvedValue(undefined);
  });

  it('a bot turn with only root_id counts under root_id (not chat-level)', async () => {
    const ctx = makeCtx(true);
    mockParseMessageEvent.mockResolvedValue(ctx);
    mockResolveSenderInfo.mockResolvedValue({ ctx, permissionError: undefined });

    await handleFeishuMessage({ cfg, event: event as never, botOpenId: 'ou_self' });

    expect(noteBotTurnAndCheckMock).toHaveBeenCalledWith('oc_topic', 'om_root');
  });

  it('a human turn with only root_id resets under root_id', async () => {
    const ctx = makeCtx(false);
    mockParseMessageEvent.mockResolvedValue(ctx);
    mockResolveSenderInfo.mockResolvedValue({ ctx, permissionError: undefined });

    await handleFeishuMessage({ cfg, event: event as never, botOpenId: 'ou_self' });

    expect(resetBotLoopMock).toHaveBeenCalledWith('oc_topic', 'om_root');
  });
});
