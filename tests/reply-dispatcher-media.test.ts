/**
 * Tests for media delivery in createFeishuReplyDispatcher.
 *
 * The dispatcher has many infra dependencies — we mock them all at the
 * module level with vi.mock() and only exercise the deliver() path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_MEDIA_LOCAL_ROOTS = ['/home/node/.openclaw/media', '/home/node/.openclaw/workspace'];
const LOCAL_DOCX_PATH = '/home/node/.openclaw/media/outbound/report.docx';
const RAW_LOCAL_DOCX_PATH = '/home/node/.openclaw/workspace/outputs/report.docx';

const { mockGetAgentScopedMediaLocalRoots, replyModeState, streamingControllerSpies, streamingControllerState } =
  vi.hoisted(() => ({
    mockGetAgentScopedMediaLocalRoots: vi.fn(),
    replyModeState: { mode: 'static' as 'static' | 'streaming' },
    streamingControllerState: {
      cardMessageId: 'om_card' as string | null,
      isTerminated: false,
      isAborted: false,
    },
    streamingControllerSpies: {
      ensureCardCreated: vi.fn().mockResolvedValue(undefined),
      onDeliver: vi.fn().mockResolvedValue(undefined),
      onPartialReply: vi.fn().mockResolvedValue(undefined),
      onReasoningStream: vi.fn().mockResolvedValue(undefined),
      onToolPayload: vi.fn().mockResolvedValue(undefined),
      onToolStart: vi.fn().mockResolvedValue(undefined),
      onIdle: vi.fn().mockResolvedValue(undefined),
      abortCard: vi.fn().mockResolvedValue(undefined),
      markFullyComplete: vi.fn(),
      shouldSkipForUnavailable: vi.fn().mockReturnValue(false),
      terminateIfUnavailable: vi.fn().mockReturnValue(false),
    },
  }));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

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
vi.mock('openclaw/plugin-sdk/agent-media-payload', () => ({
  getAgentScopedMediaLocalRoots: mockGetAgentScopedMediaLocalRoots,
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
    get cardMessageId() {
      return streamingControllerState.cardMessageId;
    }
    get isTerminated() {
      return streamingControllerState.isTerminated;
    }
    get isAborted() {
      return streamingControllerState.isAborted;
    }
    ensureCardCreated = streamingControllerSpies.ensureCardCreated;
    onDeliver = streamingControllerSpies.onDeliver;
    onPartialReply = streamingControllerSpies.onPartialReply;
    onReasoningStream = streamingControllerSpies.onReasoningStream;
    onToolPayload = streamingControllerSpies.onToolPayload;
    onToolStart = streamingControllerSpies.onToolStart;
    onIdle = streamingControllerSpies.onIdle;
    abortCard = streamingControllerSpies.abortCard;
    markFullyComplete = streamingControllerSpies.markFullyComplete;
    shouldSkipForUnavailable = streamingControllerSpies.shouldSkipForUnavailable;
    terminateIfUnavailable = streamingControllerSpies.terminateIfUnavailable;
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
  replyOptions: Record<string, unknown>;
  sentText: unknown[];
  sentCards: unknown[];
  sentMedia: unknown[];
}

function createDispatcher(
  options: {
    sendMediaImpl?: (payload: unknown) => Promise<void>;
    terminateReturn?: boolean;
    replyMode?: 'static' | 'streaming';
  } = {},
): TestContext {
  const sentText: unknown[] = [];
  const sentCards: unknown[] = [];
  const sentMedia: unknown[] = [];

  // Reset module-level state
  terminateReturn = options.terminateReturn ?? true;
  terminateCalls.length = 0;
  replyModeState.mode = options.replyMode ?? 'static';

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
    replyOptions: result.replyOptions,
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
  replyModeState.mode = 'static';
  streamingControllerState.cardMessageId = 'om_card';
  streamingControllerState.isTerminated = false;
  streamingControllerState.isAborted = false;
  mockGetAgentScopedMediaLocalRoots.mockReturnValue(TEST_MEDIA_LOCAL_ROOTS);
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

  it('passes agent-scoped roots when delivering a staged local DOCX', async () => {
    const ctx = createDispatcher();

    await ctx.dispatcher.deliver({ text: '', mediaUrl: LOCAL_DOCX_PATH });

    expect(mockGetAgentScopedMediaLocalRoots).toHaveBeenCalledWith(expect.anything(), 'agent-test');
    expect(ctx.sentMedia).toHaveLength(1);
    expect(ctx.sentMedia[0]).toEqual(
      expect.objectContaining({
        mediaUrl: LOCAL_DOCX_PATH,
        mediaLocalRoots: TEST_MEDIA_LOCAL_ROOTS,
      }),
    );
  });

  it('delivers local media after updating a streaming card', async () => {
    const ctx = createDispatcher({ replyMode: 'streaming' });

    await ctx.dispatcher.deliver({
      text: 'The report is ready.',
      mediaUrl: LOCAL_DOCX_PATH,
    });

    expect(streamingControllerSpies.ensureCardCreated).toHaveBeenCalledOnce();
    expect(streamingControllerSpies.onDeliver).toHaveBeenCalledWith({
      text: 'The report is ready.',
      mediaUrl: LOCAL_DOCX_PATH,
    });
    expect(ctx.sentText).toHaveLength(0);
    expect(ctx.sentMedia).toEqual([
      expect.objectContaining({
        mediaUrl: LOCAL_DOCX_PATH,
        mediaLocalRoots: TEST_MEDIA_LOCAL_ROOTS,
      }),
    ]);
  });

  it('keeps pre-normalized partial media in the streaming preview path', async () => {
    const ctx = createDispatcher({ replyMode: 'streaming' });
    const onPartialReply = ctx.replyOptions.onPartialReply as (payload: Record<string, unknown>) => Promise<void>;
    const payload = { text: 'The report is ready.', mediaUrls: [RAW_LOCAL_DOCX_PATH] };

    await onPartialReply(payload);

    expect(streamingControllerSpies.onPartialReply).toHaveBeenCalledWith(payload);
    expect(ctx.sentMedia).toHaveLength(0);
  });

  it('does not send streaming media after the reply is aborted during card delivery', async () => {
    const ctx = createDispatcher({ replyMode: 'streaming' });
    streamingControllerSpies.onDeliver.mockImplementationOnce(async () => {
      streamingControllerState.isAborted = true;
    });

    await ctx.dispatcher.deliver({ text: 'The report is ready.', mediaUrl: LOCAL_DOCX_PATH });

    expect(streamingControllerSpies.onDeliver).toHaveBeenCalledOnce();
    expect(ctx.sentMedia).toHaveLength(0);
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
