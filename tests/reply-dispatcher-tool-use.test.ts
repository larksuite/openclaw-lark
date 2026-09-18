import { beforeEach, describe, expect, it, vi } from 'vitest';

const { replyModeState } = vi.hoisted(() => ({
  replyModeState: { mode: 'streaming' as 'streaming' | 'static' },
}));

const controllerSpies = {
  ensureCardCreated: vi.fn().mockResolvedValue(undefined),
  onDeliver: vi.fn().mockResolvedValue(undefined),
  onReasoningStream: vi.fn().mockResolvedValue(undefined),
  onToolPayload: vi.fn().mockResolvedValue(undefined),
  onIdle: vi.fn().mockResolvedValue(undefined),
  abortCard: vi.fn().mockResolvedValue(undefined),
  shouldSkipForUnavailable: vi.fn().mockReturnValue(false),
};

vi.mock('openclaw/plugin-sdk/channel-outbound', () => ({
  createReplyPrefixContext: () => ({
    responsePrefix: '',
    responsePrefixContextProvider: () => null,
    onModelSelected: () => {},
  }),
  createTypingCallbacks: () => ({
    onReplyStart: vi.fn().mockResolvedValue(undefined),
    onIdle: vi.fn().mockResolvedValue(undefined),
    onCleanup: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock('openclaw/plugin-sdk/channel-feedback', () => ({
  logTypingFailure: vi.fn(),
}));
vi.mock('../src/core/accounts', () => ({
  createAccountScopedConfig: vi.fn(),
  getLarkAccount: () => ({ config: { streaming: true } }),
}));
vi.mock('../src/core/footer-config', () => ({
  resolveFooterConfig: () => null,
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
          createReplyDispatcherWithTyping: (hooks: { deliver: (payload: unknown, ctx?: { kind?: string }) => Promise<void> }) => ({
            dispatcher: {
              sendToolResult: (payload: unknown) => {
                void hooks.deliver(payload, { kind: 'tool' });
                return true;
              },
              sendBlockReply: () => true,
              sendFinalReply: (payload: unknown) => {
                void hooks.deliver(payload, { kind: 'final' });
                return true;
              },
              waitForIdle: async () => {},
              getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
              markComplete: () => {},
            },
            replyOptions: {},
            markDispatchIdle: () => {},
          }),
          resolveHumanDelayConfig: () => null,
        },
      },
    },
  },
}));
vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../src/messaging/outbound/send', () => ({
  sendMessageFeishu: vi.fn(),
  sendMarkdownCardFeishu: vi.fn(),
}));
vi.mock('../src/messaging/outbound/deliver', () => ({
  sendMediaLark: vi.fn(),
}));
vi.mock('../src/messaging/outbound/typing', () => ({
  addTypingIndicator: vi.fn().mockResolvedValue(null),
  removeTypingIndicator: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/card/card-error', () => ({
  isCardTableLimitError: () => false,
}));
vi.mock('../src/card/reply-mode', () => ({
  resolveReplyMode: () => replyModeState.mode,
  expandAutoMode: ({ mode }: { mode: string }) => mode,
  shouldUseCard: () => false,
}));
vi.mock('../src/card/streaming-card-controller', () => ({
  StreamingCardController: class {
    cardMessageId = 'om_card';
    isTerminated = false;
    isAborted = false;
    ensureCardCreated = controllerSpies.ensureCardCreated;
    onDeliver = controllerSpies.onDeliver;
    onReasoningStream = controllerSpies.onReasoningStream;
    onToolPayload = controllerSpies.onToolPayload;
    onIdle = controllerSpies.onIdle;
    abortCard = controllerSpies.abortCard;
    shouldSkipForUnavailable = controllerSpies.shouldSkipForUnavailable;
    terminateIfUnavailable() { return false; }
  },
}));
vi.mock('../src/card/unavailable-guard', () => ({
  UnavailableGuard: class {
    shouldSkip() { return false; }
    terminate() { return false; }
    get isTerminated() { return false; }
  },
}));

import { createFeishuReplyDispatcher } from '../src/card/reply-dispatcher';

beforeEach(() => {
  vi.clearAllMocks();
  replyModeState.mode = 'streaming';
});

describe('reply-dispatcher tool_use mode', () => {
  it('keeps reasoning streaming callbacks alongside tool_use mode', async () => {
    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: 'main',
      sessionKey: 'agent:main:feishu:dm:user-1',
      chatId: 'chat-1',
      accountId: 'default',
      chatType: 'p2p',
      replyInThread: false,
      skipTyping: true,
      toolUseDisplay: {
        mode: 'on',
        showToolUse: true,
        showToolResultDetails: false,
        showFullPaths: false,
      },
    });

    expect(result.replyOptions).toHaveProperty('onReasoningStream');
    expect(result.replyOptions).not.toHaveProperty('onReasoningEnd');
    expect(result.replyOptions).not.toHaveProperty('onAssistantMessageStart');
    expect(result.replyOptions).toHaveProperty('onToolStart');
    expect((result.replyOptions.shouldEmitToolResult as (() => boolean))()).toBe(false);
    expect((result.replyOptions.shouldEmitToolOutput as (() => boolean))()).toBe(false);

    await (result.replyOptions.onReasoningStream as (payload: { text: string }) => Promise<void>)({
      text: 'Reasoning:\n_first pass_',
    });

    expect(controllerSpies.onReasoningStream).toHaveBeenCalledWith({
      text: 'Reasoning:\n_first pass_',
    });
  });

  it('routes tool payloads to the controller instead of the answer text path', async () => {
    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: 'main',
      sessionKey: 'agent:main:feishu:dm:user-1',
      chatId: 'chat-1',
      accountId: 'default',
      chatType: 'p2p',
      replyInThread: false,
      skipTyping: true,
      toolUseDisplay: {
        mode: 'on',
        showToolUse: true,
        showToolResultDetails: false,
        showFullPaths: false,
      },
    });

    result.dispatcher.sendToolResult({ text: 'Read main.ts' });
    await Promise.resolve();

    expect(controllerSpies.onToolPayload).toHaveBeenCalledWith({ text: 'Read main.ts' });
    expect(controllerSpies.onDeliver).not.toHaveBeenCalled();
  });

  it('routes reasoning payload text through the streaming card reasoning lane', async () => {
    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: 'main',
      sessionKey: 'agent:main:feishu:dm:user-1',
      chatId: 'chat-1',
      accountId: 'default',
      chatType: 'p2p',
      replyInThread: false,
      skipTyping: true,
      toolUseDisplay: {
        mode: 'on',
        showToolUse: true,
        showToolResultDetails: false,
        showFullPaths: false,
      },
    });

    result.dispatcher.sendFinalReply({ text: 'Reasoning:\n_checking context_', isReasoning: true });
    await Promise.resolve();

    expect(controllerSpies.ensureCardCreated).toHaveBeenCalled();
    expect(controllerSpies.onReasoningStream).toHaveBeenCalledWith({
      text: 'Reasoning:\n_checking context_',
      isReasoning: true,
    });
    expect(controllerSpies.onDeliver).not.toHaveBeenCalled();
  });

  it('routes bare reasoning payload text through the streaming card reasoning lane', async () => {
    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: 'main',
      sessionKey: 'agent:main:feishu:dm:user-1',
      chatId: 'chat-1',
      accountId: 'default',
      chatType: 'p2p',
      replyInThread: false,
      skipTyping: true,
      toolUseDisplay: {
        mode: 'on',
        showToolUse: true,
        showToolResultDetails: false,
        showFullPaths: false,
      },
    });

    result.dispatcher.sendFinalReply({ text: 'checking context', isReasoning: true });
    await Promise.resolve();

    expect(controllerSpies.ensureCardCreated).toHaveBeenCalled();
    expect(controllerSpies.onReasoningStream).toHaveBeenCalledWith({
      text: 'checking context',
      isReasoning: true,
    });
    expect(controllerSpies.onDeliver).not.toHaveBeenCalled();
  });

  it('preserves SDK tool-result emission in static mode', () => {
    replyModeState.mode = 'static';

    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: 'main',
      sessionKey: 'agent:main:feishu:dm:user-1',
      chatId: 'chat-1',
      accountId: 'default',
      chatType: 'p2p',
      replyInThread: false,
      skipTyping: true,
      toolUseDisplay: {
        mode: 'full',
        showToolUse: true,
        showToolResultDetails: true,
        showFullPaths: false,
      },
    });

    expect(result.replyOptions).not.toHaveProperty('onToolStart');
    expect(result.replyOptions).not.toHaveProperty('shouldEmitToolResult');
    expect(result.replyOptions).not.toHaveProperty('shouldEmitToolOutput');
  });
});
