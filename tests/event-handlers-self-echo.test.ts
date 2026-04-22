import { describe, expect, it, vi } from 'vitest';
import { handleMessageEvent } from '../src/channel/event-handlers';
import type { MonitorContext } from '../src/channel/types';

// Spy on handleFeishuMessage to assert it was not invoked
vi.mock('../src/messaging/inbound/handler', () => ({
  handleFeishuMessage: vi.fn().mockResolvedValue(undefined),
}));

const mockEnqueueFeishuChatTask = vi.fn(async (params: { task: () => Promise<void> }) => {
  await params.task();
  return { status: 'immediate' as const };
});

vi.mock('../src/channel/chat-queue', () => ({
  buildQueueKey: (accountId: string, chatId: string, threadId?: string) =>
    threadId ? `${accountId}:${chatId}:thread:${threadId}` : `${accountId}:${chatId}`,
  enqueueFeishuChatTask: (params: unknown) => mockEnqueueFeishuChatTask(params as never),
  hasActiveTask: () => false,
  getActiveDispatcher: () => undefined,
  threadScopedKey: (base: string, threadId?: string) =>
    threadId ? `${base}:thread:${threadId}` : base,
}));

import { handleFeishuMessage as handlerMock } from '../src/messaging/inbound/handler';

function makeCtx(botOpenId: string): MonitorContext & { _recorded: string[] } {
  const recorded: string[] = [];
  return {
    cfg: {} as never,
    accountId: 'acct-1',
    chatHistories: new Map(),
    messageDedup: {
      tryRecord: (id: string) => {
        recorded.push(id);
        return true;
      },
    } as never,
    lark: { botOpenId, account: { appId: 'cli_x' } } as never,
    log: () => {},
    error: () => {},
    _recorded: recorded,
  } as MonitorContext & { _recorded: string[] };
}

function makeEvent(senderOpenId: string) {
  return {
    app_id: 'cli_x',
    sender: { sender_id: { open_id: senderOpenId }, sender_type: 'bot' },
    message: {
      message_id: `msg_${senderOpenId}`,
      chat_id: 'oc_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'hi' }),
      create_time: String(Date.now()),
    },
  };
}

describe('handleMessageEvent self-echo drop', () => {
  it('drops message when sender.open_id === bot.openId (before dedup)', async () => {
    (handlerMock as ReturnType<typeof vi.fn>).mockClear();
    const ctx = makeCtx('ou_bot_self');
    await handleMessageEvent(ctx, makeEvent('ou_bot_self'));
    expect(handlerMock).not.toHaveBeenCalled();
    expect(ctx._recorded).toEqual([]); // dedup not touched
  });

  it('still processes messages from a different sender', async () => {
    (handlerMock as ReturnType<typeof vi.fn>).mockClear();
    const ctx = makeCtx('ou_bot_self');
    await handleMessageEvent(ctx, makeEvent('ou_other'));
    expect(handlerMock).toHaveBeenCalledOnce();
    expect(ctx._recorded.length).toBeGreaterThan(0);
  });
});
