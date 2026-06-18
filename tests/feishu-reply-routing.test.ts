/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for resolveFeishuReplyRouting:
 *  - bot-peer suppression in groups (the bot→bot topic-view trap, #32980)
 *  - topic-group thread inference from root_id (threadSession=true)
 *  - default replyInThread = dc.isThread for non-bot peers
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { isThreadCapableGroupMock } = vi.hoisted(() => ({
  isThreadCapableGroupMock: vi.fn(),
}));

vi.mock('../src/core/chat-info-cache', () => ({
  isThreadCapableGroup: isThreadCapableGroupMock,
  injectLarkClient: vi.fn(),
}));

vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { resolveFeishuReplyRouting } from '../src/messaging/inbound/bot-content';

function makeDc(overrides: {
  isGroup?: boolean;
  isThread?: boolean;
  senderIsBot?: boolean;
  rootId?: string;
  threadId?: string;
  threadSession?: boolean;
}) {
  return {
    isGroup: overrides.isGroup ?? false,
    isThread: overrides.isThread ?? false,
    ctx: {
      chatId: 'oc_test',
      senderIsBot: overrides.senderIsBot ?? false,
      rootId: overrides.rootId,
      threadId: overrides.threadId,
    },
    account: {
      accountId: 'default',
      config: { threadSession: overrides.threadSession },
    },
    accountScopedCfg: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  isThreadCapableGroupMock.mockReset();
});

describe('resolveFeishuReplyRouting — bot-peer suppression', () => {
  it('bot peer in group + inbound thread → suppress thread, route to main chat', async () => {
    const dc = makeDc({ isGroup: true, isThread: true, senderIsBot: true, threadId: 'thr_1' });
    const routing = await resolveFeishuReplyRouting(dc);
    expect(routing.suppressForBotPeer).toBe(true);
    expect(routing.replyInThread).toBe(false);
    expect(routing.threadId).toBeUndefined();
  });

  it('bot peer in DM → no suppression (DMs never have the topic-view trap)', async () => {
    const dc = makeDc({ isGroup: false, isThread: false, senderIsBot: true });
    const routing = await resolveFeishuReplyRouting(dc);
    expect(routing.suppressForBotPeer).toBe(false);
    expect(routing.replyInThread).toBe(false);
  });

  it('human peer in group + inbound thread → preserves original threading', async () => {
    const dc = makeDc({ isGroup: true, isThread: true, senderIsBot: false, threadId: 'thr_2' });
    const routing = await resolveFeishuReplyRouting(dc);
    expect(routing.suppressForBotPeer).toBe(false);
    expect(routing.replyInThread).toBe(true);
    expect(routing.threadId).toBe('thr_2');
  });

  it('human peer in group + flat message → no thread', async () => {
    const dc = makeDc({ isGroup: true, isThread: false, senderIsBot: false });
    const routing = await resolveFeishuReplyRouting(dc);
    expect(routing.replyInThread).toBe(false);
    expect(routing.threadId).toBeUndefined();
  });
});

describe('resolveFeishuReplyRouting — topic-group thread inference', () => {
  it('isGroup + rootId + threadSession=true + threadCapable → infer thread and mutate dc', async () => {
    isThreadCapableGroupMock.mockResolvedValueOnce(true);
    const dc = makeDc({
      isGroup: true,
      isThread: false,
      rootId: 'om_root_1',
      threadSession: true,
    });
    const routing = await resolveFeishuReplyRouting(dc);
    expect(dc.isThread).toBe(true);
    expect(dc.ctx.threadId).toBe('om_root_1');
    expect(routing.replyInThread).toBe(true);
    expect(routing.threadId).toBe('om_root_1');
  });

  it('threadCapable=false → no inference', async () => {
    isThreadCapableGroupMock.mockResolvedValueOnce(false);
    const dc = makeDc({
      isGroup: true,
      isThread: false,
      rootId: 'om_root_2',
      threadSession: true,
    });
    const routing = await resolveFeishuReplyRouting(dc);
    expect(dc.isThread).toBe(false);
    expect(routing.replyInThread).toBe(false);
  });

  it('threadSession not enabled → skip inference (no API call)', async () => {
    const dc = makeDc({
      isGroup: true,
      isThread: false,
      rootId: 'om_root_3',
      threadSession: false,
    });
    const routing = await resolveFeishuReplyRouting(dc);
    expect(isThreadCapableGroupMock).not.toHaveBeenCalled();
    expect(dc.isThread).toBe(false);
    expect(routing.replyInThread).toBe(false);
  });

  it('inferred thread + bot peer with threadSession on → topic session, stays threaded', async () => {
    // Aligns with openclaw core PR #89783: a deliberate topic session
    // (threadSession enabled) is human-visible, so bot↔bot replies are NOT
    // forced out of the thread.
    isThreadCapableGroupMock.mockResolvedValueOnce(true);
    const dc = makeDc({
      isGroup: true,
      isThread: false,
      senderIsBot: true,
      rootId: 'om_root_4',
      threadSession: true,
    });
    const routing = await resolveFeishuReplyRouting(dc);
    expect(dc.isThread).toBe(true);
    expect(routing.suppressForBotPeer).toBe(false);
    expect(routing.replyInThread).toBe(true);
    expect(routing.threadId).toBe('om_root_4');
  });
});

describe('resolveFeishuReplyRouting — topic/config escape hatches (#89783 parity)', () => {
  it('bot peer in a real topic session (threadSession on + in thread) → not suppressed', async () => {
    const dc = makeDc({
      isGroup: true,
      isThread: true,
      senderIsBot: true,
      threadId: 'thr_topic',
      threadSession: true,
    });
    const routing = await resolveFeishuReplyRouting(dc);
    expect(routing.suppressForBotPeer).toBe(false);
    expect(routing.replyInThread).toBe(true);
    expect(routing.threadId).toBe('thr_topic');
  });

  it('bot peer + replyInThread config → not suppressed even without threadSession', async () => {
    const dc = makeDc({ isGroup: true, isThread: true, senderIsBot: true, threadId: 'thr_cfg' });
    const routing = await resolveFeishuReplyRouting(dc, { replyInThreadConfig: true });
    expect(routing.suppressForBotPeer).toBe(false);
    expect(routing.replyInThread).toBe(true);
    expect(routing.threadId).toBe('thr_cfg');
  });

  it('bot peer in thread WITHOUT threadSession or config → still suppressed (#32980 guard)', async () => {
    const dc = makeDc({ isGroup: true, isThread: true, senderIsBot: true, threadId: 'thr_x' });
    const routing = await resolveFeishuReplyRouting(dc);
    expect(routing.suppressForBotPeer).toBe(true);
    expect(routing.replyInThread).toBe(false);
    expect(routing.threadId).toBeUndefined();
  });
});
