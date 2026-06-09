/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Integration test: the loop-guard cutoff notice must NOT manufacture a Feishu
 * thread. In a normal group a bot↔bot quote-reply chain carries root_id but no
 * thread_id; sending the notice with reply_in_thread=true on such a message
 * mints a brand-new topic for just the notice (pulling it into a thread the
 * debate was never in). The notice should thread ONLY when the inbound is in a
 * real thread (thread_id) AND the account runs deliberate topic sessions —
 * mirroring resolveFeishuReplyRouting.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockParseMessageEvent = vi.fn();
const mockResolveSenderInfo = vi.fn();
const mockResolveMedia = vi.fn();
const mockResolveQuotedContent = vi.fn();
// Tripped: count is over the cap, on the exact "limit + 1" turn that surfaces
// the notice once.
const noteBotTurnAndCheckMock = vi.fn((..._args: unknown[]) => ({ allowed: false, count: 11, limit: 10 }));
const resetBotLoopMock = vi.fn();
const sendMessageFeishuMock = vi.fn(async (..._args: unknown[]) => undefined);

// Mutable account config so each test can toggle threadSession.
let accountConfig: Record<string, unknown> = {};

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
vi.mock('../src/messaging/outbound/send', () => ({
  sendMessageFeishu: (...a: unknown[]) => sendMessageFeishuMock(...a),
}));
vi.mock('../src/core/accounts', () => ({
  getLarkAccount: vi.fn(() => ({ accountId: 'test-account', config: accountConfig, enabled: true, configured: true })),
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

function makeCtx(over: { threadId?: string; rootId?: string }) {
  return {
    chatId: 'oc_topic',
    messageId: 'om_trigger',
    senderId: 'ou_peer_bot',
    senderName: 'PeerBot',
    chatType: 'group' as const,
    content: 'hi',
    contentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    senderIsBot: true,
    threadId: over.threadId,
    rootId: over.rootId,
  };
}

const cfg = { channels: { feishu: {} } } as never;
const event = { sender: { sender_id: { open_id: 'x' } }, message: { message_id: 'om_trigger', chat_id: 'oc_topic' } };

async function runWith(ctx: ReturnType<typeof makeCtx>) {
  mockParseMessageEvent.mockResolvedValue(ctx);
  mockResolveSenderInfo.mockResolvedValue({ ctx, permissionError: undefined });
  await handleFeishuMessage({ cfg, event: event as never, botOpenId: 'ou_self' });
}

describe('loop-guard cutoff notice routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accountConfig = {};
    mockResolveMedia.mockResolvedValue({ mediaList: [], payload: undefined });
    mockResolveQuotedContent.mockResolvedValue(undefined);
  });

  it('does NOT thread the notice for a root_id-only quote-reply chain (no real thread)', async () => {
    accountConfig = {}; // threadSession unset
    await runWith(makeCtx({ threadId: undefined, rootId: 'om_root' }));

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    const arg = sendMessageFeishuMock.mock.calls[0][0] as { replyInThread: boolean; threadId: string | undefined };
    expect(arg.replyInThread).toBe(false); // would-be-thread root_id must NOT force a thread
    expect(arg.threadId).toBeUndefined();
  });

  it('does NOT thread when in a real thread but threadSession is off', async () => {
    accountConfig = {}; // threadSession unset
    await runWith(makeCtx({ threadId: 'omt_real', rootId: undefined }));

    const arg = sendMessageFeishuMock.mock.calls[0][0] as { replyInThread: boolean; threadId: string | undefined };
    expect(arg.replyInThread).toBe(false);
    expect(arg.threadId).toBeUndefined();
  });

  it('DOES thread when in a real thread AND threadSession is on (deliberate topic session)', async () => {
    accountConfig = { threadSession: true };
    await runWith(makeCtx({ threadId: 'omt_real', rootId: undefined }));

    const arg = sendMessageFeishuMock.mock.calls[0][0] as { replyInThread: boolean; threadId: string | undefined };
    expect(arg.replyInThread).toBe(true);
    expect(arg.threadId).toBe('omt_real');
  });

  it('DOES thread when in a real thread AND replyInThread is on (follows the body routing)', async () => {
    accountConfig = { replyInThread: true }; // threadSession off, replyInThread on
    await runWith(makeCtx({ threadId: 'omt_real', rootId: undefined }));

    const arg = sendMessageFeishuMock.mock.calls[0][0] as { replyInThread: boolean; threadId: string | undefined };
    expect(arg.replyInThread).toBe(true);
    expect(arg.threadId).toBe('omt_real');
  });

  it('does NOT thread for a root_id-only chain even with replyInThread on (no real thread)', async () => {
    accountConfig = { replyInThread: true };
    await runWith(makeCtx({ threadId: undefined, rootId: 'om_root' }));

    const arg = sendMessageFeishuMock.mock.calls[0][0] as { replyInThread: boolean; threadId: string | undefined };
    expect(arg.replyInThread).toBe(false); // replyInThread relaxes thread suppression; it never mints a thread
    expect(arg.threadId).toBeUndefined();
  });
});
