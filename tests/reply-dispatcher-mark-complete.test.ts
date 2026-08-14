import { beforeEach, describe, expect, it, vi } from 'vitest';

// The SDK reserves pending=1 when a reply dispatcher is created and only
// releases it via markComplete(). This pins the contract that every
// dispatcher created by this plugin releases its reservation on both the
// success and the failure path (issue #583).
const { markCompleteMock, waitForIdleMock, dispatchReplyFromConfigMock, formatAgentEnvelopeMock } = vi.hoisted(() => ({
  markCompleteMock: vi.fn(),
  waitForIdleMock: vi.fn().mockResolvedValue(undefined),
  dispatchReplyFromConfigMock: vi.fn().mockResolvedValue({ queuedFinal: false, counts: {} }),
  formatAgentEnvelopeMock: vi.fn((input) => input.body),
}));

vi.mock('../src/core/lark-client', () => ({
  LarkClient: {
    runtime: {
      channel: {
        reply: {
          dispatchReplyFromConfig: dispatchReplyFromConfigMock,
          formatAgentEnvelope: formatAgentEnvelopeMock,
        },
      },
    },
  },
}));

vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../src/core/lark-ticket', () => ({
  ticketElapsed: () => 1,
}));

vi.mock('../src/card/reply-dispatcher', () => ({
  createFeishuReplyDispatcher: vi.fn(() => ({
    dispatcher: {
      waitForIdle: waitForIdleMock,
      markComplete: markCompleteMock,
    },
    replyOptions: {},
    markDispatchIdle: vi.fn(),
    markFullyComplete: vi.fn(),
    abortCard: vi.fn(),
  })),
}));

vi.mock('../src/card/tool-use-trace-store', () => ({
  startToolUseTraceRun: vi.fn(),
}));

vi.mock('../src/messaging/inbound/dispatch-builders', () => ({
  buildInboundPayload: vi.fn(),
}));

import { dispatchPermissionNotification } from '../src/messaging/inbound/dispatch-commands';

function createDispatchContext() {
  return {
    ctx: {
      chatId: 'chat-1',
      messageId: 'om_msg_1',
      senderId: 'ou_sender_1',
      content: 'hello',
    },
    accountScopedCfg: {} as never,
    account: { accountId: 'default' },
    log: vi.fn(),
    error: vi.fn(),
    core: {
      channel: {
        reply: {
          dispatchReplyFromConfig: dispatchReplyFromConfigMock,
          formatAgentEnvelope: formatAgentEnvelopeMock,
        },
      },
    },
    envelopeFrom: 'from-test',
    envelopeOptions: {},
    route: { sessionKey: 'session-1' },
    isThread: false,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('dispatcher reservation release (issue #583)', () => {
  it('releases the reservation via markComplete on the success path', async () => {
    await dispatchPermissionNotification(createDispatchContext(), { message: 'denied' } as never, 'om_reply_1');

    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
    expect(waitForIdleMock).toHaveBeenCalledTimes(1);
    expect(markCompleteMock).toHaveBeenCalledTimes(1);
  });

  it('still releases the reservation via markComplete when dispatch throws', async () => {
    dispatchReplyFromConfigMock.mockRejectedValueOnce(new Error('boom'));

    await expect(
      dispatchPermissionNotification(createDispatchContext(), { message: 'denied' } as never, 'om_reply_1'),
    ).rejects.toThrow('boom');

    expect(markCompleteMock).toHaveBeenCalledTimes(1);
  });
});
