/**
 * Tests for media delivery in createFeishuReplyDispatcher.
 *
 * The dispatcher has many infra dependencies — we mock them all at the
 * module level with vi.mock() and only exercise the deliver() path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const replyModeState = vi.hoisted(() => ({ mode: 'static' as 'static' | 'streaming' }));
const streamingControllerInstances = vi.hoisted(
  () =>
    [] as Array<{
      cardMessageId: string | null;
      ensureCardCreated: ReturnType<typeof vi.fn>;
      isAborted: boolean;
      isTerminated: boolean;
      markMediaDelivered: ReturnType<typeof vi.fn>;
      onDeliver: ReturnType<typeof vi.fn>;
      onIdle: ReturnType<typeof vi.fn>;
      onReasoningStream: ReturnType<typeof vi.fn>;
      onToolPayload: ReturnType<typeof vi.fn>;
      shouldSkipForUnavailable: ReturnType<typeof vi.fn>;
    }>,
);

vi.mock('openclaw/plugin-sdk/channel-runtime', () => ({
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
  getLarkAccount: () => ({ config: {} }),
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
          createReplyDispatcherWithTyping: (hooks: { deliver: unknown; onError: unknown }) => ({
            dispatcher: { deliver: hooks.deliver, onError: hooks.onError },
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

const mockSendMessageFeishu = vi.fn();
const mockSendMarkdownCardFeishu = vi.fn();
vi.mock('../src/messaging/outbound/send', () => ({
  sendMessageFeishu: (...args: unknown[]) => mockSendMessageFeishu(...args),
  sendMarkdownCardFeishu: (...args: unknown[]) => mockSendMarkdownCardFeishu(...args),
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
    cardMessageId: string | null = 'om_stream_card';
    isAborted = false;
    isTerminated = false;
    ensureCardCreated = vi.fn().mockResolvedValue(undefined);
    markMediaDelivered = vi.fn();
    onDeliver = vi.fn().mockResolvedValue(undefined);
    onIdle = vi.fn().mockResolvedValue(undefined);
    onReasoningStream = vi.fn().mockResolvedValue(undefined);
    onToolPayload = vi.fn().mockResolvedValue(undefined);
    shouldSkipForUnavailable = vi.fn().mockReturnValue(false);

    constructor() {
      streamingControllerInstances.push(this);
    }
  },
}));

let terminateReturn = true;
const terminateCalls: Array<{ source: string; err: unknown }> = [];
vi.mock('../src/card/unavailable-guard', () => ({
  UnavailableGuard: class {
    shouldSkip() {
      return false;
    }
    terminate(source: string, err?: unknown) {
      terminateCalls.push({ source, err });
      return terminateReturn;
    }
    get isTerminated() {
      return false;
    }
  },
}));

const mockSendMediaLark = vi.fn();
vi.mock('../src/messaging/outbound/deliver', () => ({
  sendMediaLark: (...args: unknown[]) => mockSendMediaLark(...args),
}));

import { createFeishuReplyDispatcher } from '../src/card/reply-dispatcher';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestContext {
  dispatcher: { deliver: (payload: Record<string, unknown>) => Promise<void> };
  sentText: unknown[];
  sentCards: unknown[];
  sentMedia: unknown[];
}

function createDispatcher(
  options: {
    replyMode?: 'static' | 'streaming';
    sendMediaImpl?: (payload: unknown) => Promise<void>;
    terminateReturn?: boolean;
  } = {},
): TestContext {
  const sentText: unknown[] = [];
  const sentCards: unknown[] = [];
  const sentMedia: unknown[] = [];

  // Reset module-level state
  replyModeState.mode = options.replyMode ?? 'static';
  terminateReturn = options.terminateReturn ?? true;
  terminateCalls.length = 0;

  mockSendMessageFeishu.mockImplementation(async (payload: unknown) => {
    sentText.push(payload);
  });
  mockSendMarkdownCardFeishu.mockImplementation(async (payload: unknown) => {
    sentCards.push(payload);
  });

  const sendMediaImpl =
    options.sendMediaImpl ??
    (async (payload: unknown) => {
      sentMedia.push(payload);
    });
  mockSendMediaLark.mockImplementation(sendMediaImpl);

  const result = createFeishuReplyDispatcher({
    cfg: {} as never,
    agentId: 'agent-test',
    sessionKey: 'session-test',
    chatId: 'chat-test',
    replyToMessageId: 'om_reply',
    accountId: 'default',
    replyInThread: false,
    chatType: 'p2p',
    skipTyping: true,
    toolUseDisplay: {
      mode: 'off',
      showToolUse: false,
      showToolResultDetails: false,
      showFullPaths: false,
    },
  });

  return {
    dispatcher: result.dispatcher as unknown as TestContext['dispatcher'],
    sentText,
    sentCards,
    sentMedia,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  terminateCalls.length = 0;
  streamingControllerInstances.length = 0;
  replyModeState.mode = 'static';
});

describe('reply-dispatcher media delivery', () => {
  it('media-only payload does not send empty text message', async () => {
    const ctx = createDispatcher();

    await ctx.dispatcher.deliver({ text: '', mediaUrl: 'https://example.com/image.png' });

    expect(ctx.sentText).toHaveLength(0);
    expect(ctx.sentCards).toHaveLength(0);
    expect(ctx.sentMedia).toHaveLength(1);
    expect((ctx.sentMedia[0] as { mediaUrl: string }).mediaUrl).toBe('https://example.com/image.png');
  });

  it('mixed payload delivers both text and media', async () => {
    const ctx = createDispatcher();

    await ctx.dispatcher.deliver({
      text: 'hello from feishu',
      mediaUrls: ['https://example.com/image-a.png', 'https://example.com/image-b.png'],
    });

    expect(ctx.sentText).toHaveLength(1);
    expect((ctx.sentText[0] as { text: string }).text).toBe('hello from feishu');
    expect(ctx.sentMedia.map((item) => (item as { mediaUrl: string }).mediaUrl)).toEqual([
      'https://example.com/image-a.png',
      'https://example.com/image-b.png',
    ]);
  });

  it('streaming mixed payload routes text to the active card and still sends media', async () => {
    const ctx = createDispatcher({ replyMode: 'streaming' });

    await ctx.dispatcher.deliver({
      text: 'created image',
      mediaUrl: 'https://example.com/image.png',
    });

    const controller = streamingControllerInstances[0];
    expect(controller.ensureCardCreated).toHaveBeenCalledTimes(1);
    expect(controller.onDeliver).toHaveBeenCalledWith(expect.objectContaining({ text: 'created image' }));
    expect(ctx.sentText).toHaveLength(0);
    expect(ctx.sentCards).toHaveLength(0);
    expect(ctx.sentMedia).toHaveLength(1);
    expect((ctx.sentMedia[0] as { mediaUrl: string }).mediaUrl).toBe('https://example.com/image.png');
  });

  it('streaming media-only payload marks delivered media as a visible result', async () => {
    const ctx = createDispatcher({ replyMode: 'streaming' });

    await ctx.dispatcher.deliver({
      text: '',
      mediaUrl: 'https://example.com/image.png',
    });

    const controller = streamingControllerInstances[0];
    expect(ctx.sentMedia).toHaveLength(1);
    expect(controller.markMediaDelivered).toHaveBeenCalledTimes(1);
  });

  it('failed media send triggers staticGuard terminate', async () => {
    const mediaError = new Error('bot removed from chat');
    const ctx = createDispatcher({
      sendMediaImpl: async () => {
        throw mediaError;
      },
      terminateReturn: true,
    });

    await ctx.dispatcher.deliver({ text: '', mediaUrl: 'https://example.com/image.png' });

    expect(terminateCalls).toHaveLength(1);
    expect(terminateCalls[0].source).toBe('deliver.media');
    expect(terminateCalls[0].err).toBe(mediaError);
  });

  it('terminate on first media aborts remaining media URLs', async () => {
    let sendCount = 0;
    const mediaError = new Error('bot removed from chat');
    createDispatcher({
      sendMediaImpl: async () => {
        sendCount++;
        if (sendCount === 1) throw mediaError;
      },
      terminateReturn: true,
    });

    const ctx = createDispatcher({
      sendMediaImpl: async () => {
        sendCount++;
        if (sendCount === 1) throw mediaError;
      },
      terminateReturn: true,
    });

    await ctx.dispatcher.deliver({
      text: '',
      mediaUrls: ['https://example.com/a.png', 'https://example.com/b.png', 'https://example.com/c.png'],
    });

    expect(sendCount).toBe(1);
    expect(terminateCalls).toHaveLength(1);
    expect(ctx.sentMedia).toHaveLength(0);
  });

  it('non-terminal media error logs and continues to next URL', async () => {
    let sendCount = 0;
    const mediaError = new Error('transient upload failure');
    const sentMedia: unknown[] = [];
    const ctx = createDispatcher({
      sendMediaImpl: async (payload) => {
        sendCount++;
        if (sendCount === 1) throw mediaError;
        sentMedia.push(payload);
      },
      terminateReturn: false,
    });

    await ctx.dispatcher.deliver({
      text: '',
      mediaUrls: ['https://example.com/a.png', 'https://example.com/b.png'],
    });

    expect(sendCount).toBe(2);
    expect(terminateCalls).toHaveLength(1);
    expect(sentMedia).toHaveLength(1);
    expect((sentMedia[0] as { mediaUrl: string }).mediaUrl).toBe('https://example.com/b.png');
  });
});
