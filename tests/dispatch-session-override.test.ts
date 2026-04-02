import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockResolveAgentRoute = vi.fn();
const mockEnqueueSystemEvent = vi.fn();
const mockResolveThreadSessionKey = vi.fn();
const mockDispatchReplyFromConfig = vi.fn();
const mockCreateFeishuReplyDispatcher = vi.fn();

vi.mock('../src/core/lark-client', () => ({
  LarkClient: {
    runtime: {
      channel: {
        routing: {
          resolveAgentRoute: (...args: unknown[]) => mockResolveAgentRoute(...args),
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({}),
          dispatchReplyFromConfig: (...args: unknown[]) => mockDispatchReplyFromConfig(...args),
        },
        commands: {
          isControlCommandMessage: () => false,
        },
      },
      system: {
        enqueueSystemEvent: (...args: unknown[]) => mockEnqueueSystemEvent(...args),
      },
    },
  },
}));

vi.mock('../src/messaging/inbound/dispatch-builders', () => ({
  buildMessageBody: () => 'body',
  buildEnvelopeWithHistory: () => ({ combinedBody: 'combined', historyKey: undefined }),
  buildBodyForAgent: () => 'body-for-agent',
  buildInboundPayload: () => ({ body: 'payload' }),
}));

vi.mock('../src/card/reply-dispatcher', () => ({
  createFeishuReplyDispatcher: (...args: unknown[]) => mockCreateFeishuReplyDispatcher(...args),
}));

vi.mock('../src/messaging/inbound/dispatch-commands', () => ({
  dispatchPermissionNotification: vi.fn(),
  dispatchSystemCommand: vi.fn(),
}));

vi.mock('../src/channel/chat-queue', () => ({
  buildQueueKey: () => 'queue',
  registerActiveDispatcher: vi.fn(),
  threadScopedKey: () => 'history',
  unregisterActiveDispatcher: vi.fn(),
}));

vi.mock('../src/channel/abort-detect', () => ({
  isLikelyAbortText: () => false,
}));

vi.mock('../src/core/chat-info-cache', () => ({
  isThreadCapableGroup: vi.fn(),
}));

vi.mock('../src/commands/doctor', () => ({
  runFeishuDoctorI18n: vi.fn(),
}));

vi.mock('../src/commands/auth', () => ({
  runFeishuAuthI18n: vi.fn(),
}));

vi.mock('../src/commands/index', () => ({
  getFeishuHelpI18n: vi.fn(),
  runFeishuStartI18n: vi.fn(),
}));

vi.mock('../src/messaging/outbound/send', () => ({
  buildI18nMarkdownCard: vi.fn(),
  sendCardFeishu: vi.fn(),
  sendMessageFeishu: vi.fn(),
}));

vi.mock('../src/messaging/inbound/mention', () => ({
  mentionedBot: () => false,
}));

vi.mock('../src/messaging/inbound/gate', () => ({
  resolveRespondToMentionAll: () => false,
}));

vi.mock('../src/messaging/inbound/dispatch-context', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveThreadSessionKey: (...args: unknown[]) => mockResolveThreadSessionKey(...args),
  };
});

import { buildDispatchContext } from '../src/messaging/inbound/dispatch-context';
import { dispatchToAgent } from '../src/messaging/inbound/dispatch';

function createMessageContext() {
  return {
    chatId: 'oc_123',
    messageId: 'om_1',
    senderId: 'ou_1',
    senderName: 'U',
    chatType: 'group' as const,
    content: 'hello',
    contentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    threadId: 'omt_1',
    rawMessage: {
      message_id: 'om_1',
      chat_id: 'oc_123',
      chat_type: 'group' as const,
      message_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
      thread_id: 'omt_1',
    },
    rawSender: {
      sender_id: { open_id: 'ou_1' },
    },
  };
}

describe('dispatch session override', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAgentRoute.mockReturnValue({
      agentId: 'agent_main',
      sessionKey: 'session_main',
    });
    mockDispatchReplyFromConfig.mockResolvedValue({
      queuedFinal: true,
      counts: { final: 1 },
    });
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: { waitForIdle: vi.fn().mockResolvedValue(undefined) },
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      markFullyComplete: vi.fn(),
      abortCard: vi.fn(),
    });
    mockResolveThreadSessionKey.mockResolvedValue('thread_session');
  });

  it('applies override only when account/chat/chatType/thread all match', () => {
    const ctx = createMessageContext();
    const account = { accountId: 'default', config: {} } as any;
    const dc = buildDispatchContext({
      ctx,
      account,
      accountScopedCfg: {} as any,
      sessionRouteOverride: {
        agentId: 'agent_sub',
        sessionKey: 'session_sub',
        accountId: 'default',
        chatId: 'oc_123',
        chatType: 'group',
        threadId: 'omt_1',
      },
    });

    expect(dc.route).toMatchObject({
      agentId: 'agent_sub',
      sessionKey: 'session_sub',
    });
    expect(dc.routeOverrideApplied).toBe(true);

    const ignored = buildDispatchContext({
      ctx,
      account,
      accountScopedCfg: {} as any,
      sessionRouteOverride: {
        agentId: 'agent_sub',
        sessionKey: 'session_sub',
        accountId: 'default',
        chatId: 'oc_123',
        chatType: 'group',
        threadId: 'omt_other',
      },
    });

    expect(ignored.route).toMatchObject({
      agentId: 'agent_main',
      sessionKey: 'session_main',
    });
    expect(ignored.routeOverrideApplied).toBe(false);
  });

  it('skips thread session resolution when override has been applied', async () => {
    await dispatchToAgent({
      ctx: createMessageContext(),
      mediaPayload: {},
      account: { accountId: 'default', config: { threadSession: true } } as any,
      accountScopedCfg: {} as any,
      historyLimit: 0,
      sessionRouteOverride: {
        agentId: 'agent_sub',
        sessionKey: 'session_sub',
        accountId: 'default',
        chatId: 'oc_123',
        chatType: 'group',
        threadId: 'omt_1',
      },
    });

    expect(mockResolveThreadSessionKey).not.toHaveBeenCalled();
    expect(mockCreateFeishuReplyDispatcher.mock.calls[0]![0]).toMatchObject({
      agentId: 'agent_sub',
      sessionKey: 'session_sub',
    });
  });
});
