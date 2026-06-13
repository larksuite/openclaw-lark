import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dispatchReplyFromConfigMock, createReplyDispatcherHooks } = vi.hoisted(() => ({
  dispatchReplyFromConfigMock: vi.fn(),
  createReplyDispatcherHooks: [] as Array<Record<string, unknown>>,
}));

vi.mock('../src/core/lark-client', () => ({
  LarkClient: {
    runtime: {
      channel: {
        text: {
          resolveTextChunkLimit: () => 4000,
          resolveChunkMode: () => 'paragraph',
          resolveMarkdownTableMode: () => 'plain',
          convertMarkdownTables: (text: string) => text,
          chunkTextWithMode: (text: string) => (text ? [text] : []),
        },
        reply: {
          createReplyDispatcherWithTyping: (hooks: Record<string, unknown>) => {
            createReplyDispatcherHooks.push(hooks);
            return {
              dispatcher: {
                waitForIdle: vi.fn().mockResolvedValue(undefined),
                getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
                markComplete: vi.fn(),
              },
              replyOptions: {},
              markDispatchIdle: vi.fn(),
            };
          },
          resolveHumanDelayConfig: () => null,
          dispatchReplyFromConfig: dispatchReplyFromConfigMock,
        },
      },
    },
  },
}));

vi.mock('../src/core/accounts', () => ({
  createAccountScopedConfig: vi.fn((cfg) => cfg),
  getLarkAccount: () => ({ accountId: 'default', config: { streaming: false } }),
}));
vi.mock('../src/core/footer-config', () => ({ resolveFooterConfig: () => null }));
vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../src/messaging/outbound/send', () => ({
  sendMessageFeishu: vi.fn().mockResolvedValue({ messageId: 'om_sent' }),
  sendMarkdownCardFeishu: vi.fn().mockResolvedValue({ messageId: 'om_card' }),
  buildI18nMarkdownCard: vi.fn(),
  sendCardFeishu: vi.fn(),
}));
vi.mock('../src/messaging/outbound/deliver', () => ({ sendMediaLark: vi.fn() }));
vi.mock('../src/messaging/outbound/typing', () => ({
  addTypingIndicator: vi.fn().mockResolvedValue(null),
  removeTypingIndicator: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/card/card-error', () => ({ isCardTableLimitError: () => false }));
vi.mock('../src/card/reply-mode', () => ({
  resolveReplyMode: () => 'static',
  expandAutoMode: () => 'static',
  shouldUseCard: () => false,
}));
vi.mock('../src/card/unavailable-guard', () => ({
  UnavailableGuard: class {
    shouldSkip() {
      return false;
    }
    terminate() {
      return false;
    }
    get isTerminated() {
      return false;
    }
  },
}));
vi.mock('openclaw/plugin-sdk/channel-runtime', () => ({
  createReplyPrefixContext: () => ({
    responsePrefix: '',
    responsePrefixContextProvider: () => null,
    onModelSelected: vi.fn(),
  }),
  createTypingCallbacks: () => ({ onReplyStart: vi.fn(), onIdle: vi.fn(), onCleanup: vi.fn() }),
}));
vi.mock('openclaw/plugin-sdk/channel-feedback', () => ({ logTypingFailure: vi.fn() }));
vi.mock('../src/card/tool-use-config', () => ({
  resolveToolUseDisplayConfig: () => ({
    mode: 'off',
    showToolUse: false,
    showToolResultDetails: false,
    showFullPaths: false,
  }),
}));
vi.mock('../src/card/tool-use-trace-store', () => ({ startToolUseTraceRun: vi.fn(), clearToolUseTraceRun: vi.fn() }));
vi.mock('../src/channel/chat-queue', () => ({
  buildQueueKey: () => 'queue-key',
  registerActiveDispatcher: vi.fn(),
  unregisterActiveDispatcher: vi.fn(),
  threadScopedKey: () => 'thread-key',
}));
vi.mock('../src/messaging/inbound/dispatch-context', () => ({
  buildDispatchContext: vi.fn((params) => params.__dc),
  resolveThreadSessionKey: vi.fn(),
}));
vi.mock('../src/messaging/inbound/dispatch-builders', () => ({
  buildMessageBody: vi.fn(() => 'message-body'),
  buildEnvelopeWithHistory: vi.fn(() => ({ combinedBody: 'combined-body', historyKey: undefined })),
  buildBodyForAgent: vi.fn(() => 'body-for-agent'),
  buildInboundPayload: vi.fn(() => ({ kind: 'ctx-payload' })),
}));
vi.mock('../src/messaging/inbound/dispatch-commands', () => ({
  dispatchPermissionNotification: vi.fn(),
  dispatchSystemCommand: vi.fn(),
}));
vi.mock('../src/core/chat-info-cache', () => ({ isThreadCapableGroup: vi.fn(), injectLarkClient: vi.fn() }));
vi.mock('../src/core/targets', () => ({ encodeFeishuRouteTarget: vi.fn() }));
vi.mock('../src/commands/doctor', () => ({ runFeishuDoctorI18n: vi.fn() }));
vi.mock('../src/commands/auth', () => ({ runFeishuAuthI18n: vi.fn() }));
vi.mock('../src/commands/index', () => ({ getFeishuHelpI18n: vi.fn(), runFeishuStartI18n: vi.fn() }));
vi.mock('../src/messaging/inbound/mention', () => ({ mentionedBot: vi.fn(() => false) }));
vi.mock('../src/messaging/inbound/gate', () => ({ resolveRespondToMentionAll: vi.fn(() => false) }));
vi.mock('../src/channel/abort-detect', () => ({ isLikelyAbortText: vi.fn(() => false) }));
vi.mock('../src/core/lark-ticket', () => ({ ticketElapsed: () => 1 }));

import { createFeishuReplyDispatcher, NO_VISIBLE_REPLY_FALLBACK_TEXT } from '../src/card/reply-dispatcher';
import { dispatchToAgent } from '../src/messaging/inbound/dispatch';
import { sendMessageFeishu } from '../src/messaging/outbound/send';

const toolUseDisplay = { mode: 'off' as const, showToolUse: false, showToolResultDetails: false, showFullPaths: false };

function baseDispatcherParams() {
  return {
    cfg: {} as never,
    agentId: 'main',
    sessionKey: 'agent:main:feishu:dm:user-1',
    chatId: 'chat-1',
    accountId: 'default',
    chatType: 'p2p' as const,
    replyToMessageId: 'om_msg_1',
    replyInThread: false,
    skipTyping: true,
    toolUseDisplay,
  };
}

function createDispatchContext() {
  return {
    ctx: {
      chatId: 'chat-1',
      messageId: 'om_msg_1',
      senderId: 'ou_sender_1',
      senderName: 'Alice',
      content: 'hello',
      chatType: 'p2p',
      mentions: [],
      resources: [],
      contentType: 'text',
      mentionAll: false,
      rawMessage: {},
      rawSender: {},
    },
    accountScopedCfg: {},
    account: { accountId: 'default', enabled: true, brand: 'feishu', config: {} },
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    log: vi.fn(),
    error: vi.fn(),
    core: {
      channel: {
        commands: { isControlCommandMessage: vi.fn(() => false) },
        reply: { dispatchReplyFromConfig: dispatchReplyFromConfigMock },
      },
    },
    isGroup: false,
    isThread: false,
    feishuFrom: 'feishu:ou_sender_1',
    feishuTo: 'user:ou_sender_1',
    envelopeFrom: 'ou_sender_1',
    envelopeOptions: {},
    route: { sessionKey: 'session-1', agentId: 'default', channel: 'feishu', accountId: 'default' },
    threadSessionKey: undefined,
    commandAuthorized: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  createReplyDispatcherHooks.length = 0;
  dispatchReplyFromConfigMock.mockResolvedValue({ queuedFinal: false, counts: { final: 0 } });
  (sendMessageFeishu as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ messageId: 'om_sent' });
});

describe('no-visible-reply fallback', () => {
  it('sends a fallback when dispatch completes with no final replies and no visible output', async () => {
    const dc = createDispatchContext();

    await dispatchToAgent({
      ctx: { ...dc.ctx, __dc: dc } as never,
      mediaPayload: {},
      account: dc.account as never,
      accountScopedCfg: {} as never,
      historyLimit: 0,
    });

    expect(sendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'chat-1',
        text: NO_VISIBLE_REPLY_FALLBACK_TEXT,
        replyToMessageId: 'om_msg_1',
        accountId: 'default',
      }),
    );
  });

  it('does not fallback for an intentional silent final reply', async () => {
    const result = createFeishuReplyDispatcher(baseDispatcherParams());
    const hooks = createReplyDispatcherHooks.at(-1) as {
      onReplyStart: () => Promise<void>;
      onSkip: (payload: unknown, info: { kind: string; reason: string }) => void;
    };

    await hooks.onReplyStart();
    hooks.onSkip({}, { kind: 'final', reason: 'silent' });

    const sent = await result.ensureNoVisibleReplyFallback('dispatch-complete-zero-final');

    expect(sent).toBe(false);
    expect(sendMessageFeishu).not.toHaveBeenCalled();
    expect(result.getVisibleReplyState()).toEqual({ visibleReplySent: false, skippedFinalReason: 'silent' });
  });

  it('does not duplicate fallback after visible static delivery', async () => {
    const result = createFeishuReplyDispatcher(baseDispatcherParams());
    const hooks = createReplyDispatcherHooks.at(-1) as {
      deliver: (payload: { text: string }, info: { kind: string }) => Promise<void>;
    };

    await hooks.deliver({ text: 'visible answer' }, { kind: 'final' });
    const sent = await result.ensureNoVisibleReplyFallback('dispatch-complete-zero-final');

    expect(sent).toBe(false);
    expect(sendMessageFeishu).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishu).toHaveBeenCalledWith(expect.objectContaining({ text: 'visible answer' }));
  });

  it('resets visible/silent state on each reply start', async () => {
    const result = createFeishuReplyDispatcher(baseDispatcherParams());
    const hooks = createReplyDispatcherHooks.at(-1) as {
      onReplyStart: () => Promise<void>;
      onSkip: (payload: unknown, info: { kind: string; reason: string }) => void;
    };

    await hooks.onReplyStart();
    hooks.onSkip({}, { kind: 'final', reason: 'silent' });
    expect(result.getVisibleReplyState().skippedFinalReason).toBe('silent');

    await hooks.onReplyStart();
    expect(result.getVisibleReplyState()).toEqual({ visibleReplySent: false, skippedFinalReason: null });
  });
});
