import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockWithTicket = vi.fn();
const mockEnqueueFeishuChatTask = vi.fn();
const mockHandleFeishuMessage = vi.fn();

vi.mock('../src/core/lark-ticket', () => ({
  withTicket: (...args: unknown[]) => mockWithTicket(...args),
}));

vi.mock('../src/channel/chat-queue', () => ({
  enqueueFeishuChatTask: (...args: unknown[]) => mockEnqueueFeishuChatTask(...args),
}));

vi.mock('../src/messaging/inbound/handler-registry', () => ({
  getInboundHandler: () => mockHandleFeishuMessage,
}));

import { dispatchSyntheticTextMessage } from '../src/messaging/inbound/synthetic-message';

describe('dispatchSyntheticTextMessage session override', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithTicket.mockImplementation(async (_ticket: unknown, fn: () => unknown) => await fn());
    mockEnqueueFeishuChatTask.mockImplementation(({ task }: { task: () => Promise<void> }) => ({
      status: 'queued',
      promise: task(),
    }));
  });

  it('forwards sessionRouteOverride to inbound handler and ticket context', async () => {
    await dispatchSyntheticTextMessage({
      cfg: {} as any,
      accountId: 'default',
      chatId: 'oc_123',
      senderOpenId: 'ou_123',
      text: 'resume',
      syntheticMessageId: 'om_synthetic',
      replyToMessageId: 'om_origin',
      chatType: 'group',
      threadId: 'omt_1',
      sessionRouteOverride: {
        agentId: 'agent_sub',
        sessionKey: 'session_sub',
        accountId: 'default',
        chatId: 'oc_123',
        chatType: 'group',
        threadId: 'omt_1',
      },
    });

    expect(mockWithTicket).toHaveBeenCalledTimes(1);
    expect(mockWithTicket.mock.calls[0]![0]).toMatchObject({
      messageId: 'om_synthetic',
      chatId: 'oc_123',
      accountId: 'default',
      senderOpenId: 'ou_123',
      chatType: 'group',
      threadId: 'omt_1',
    });

    expect(mockHandleFeishuMessage).toHaveBeenCalledTimes(1);
    expect(mockHandleFeishuMessage.mock.calls[0]![0]).toMatchObject({
      accountId: 'default',
      replyToMessageId: 'om_origin',
      sessionRouteOverride: {
        agentId: 'agent_sub',
        sessionKey: 'session_sub',
        accountId: 'default',
        chatId: 'oc_123',
        chatType: 'group',
        threadId: 'omt_1',
      },
    });
  });
});
