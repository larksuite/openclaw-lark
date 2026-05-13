/**
 * Tests for the empty message early-rejection guard in handleFeishuMessage.
 *
 * Verifies that messages with no text content and no media resources
 * are skipped before reaching the enrichment/gate/dispatch pipeline.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks (hoisted)
// ---------------------------------------------------------------------------

const mockParseMessageEvent = vi.fn();
const mockResolveSenderInfo = vi.fn();
const mockPrefetchUserNames = vi.fn();
const mockResolveMedia = vi.fn();
const mockResolveQuotedMessageContext = vi.fn();
const mockSubstituteMediaPaths = vi.fn();

vi.mock('../src/messaging/inbound/parse', () => ({
  parseMessageEvent: (...args: unknown[]) => mockParseMessageEvent(...args),
}));

vi.mock('../src/messaging/inbound/enrich', () => ({
  resolveSenderInfo: (...args: unknown[]) => mockResolveSenderInfo(...args),
  prefetchUserNames: (...args: unknown[]) => mockPrefetchUserNames(...args),
  resolveMedia: (...args: unknown[]) => mockResolveMedia(...args),
  resolveQuotedMessageContext: (...args: unknown[]) => mockResolveQuotedMessageContext(...args),
  substituteMediaPaths: (...args: unknown[]) => mockSubstituteMediaPaths(...args),
}));

vi.mock('../src/messaging/inbound/gate', () => ({
  checkMessageGate: vi.fn().mockResolvedValue({ allowed: true }),
  readFeishuAllowFromStore: vi.fn().mockResolvedValue([]),
}));

vi.mock('../src/messaging/inbound/handler-registry', () => ({
  injectInboundHandler: vi.fn(),
}));

vi.mock('../src/messaging/inbound/dispatch', () => ({
  dispatchToAgent: vi.fn(),
}));

vi.mock('../src/messaging/inbound/policy', () => ({
  resolveFeishuGroupConfig: vi.fn(),
  splitLegacyGroupAllowFrom: vi.fn().mockReturnValue({ senderAllowFrom: [] }),
}));

vi.mock('../src/core/accounts', () => ({
  getLarkAccount: vi.fn().mockReturnValue({
    accountId: 'test-account',
    config: {},
    enabled: true,
    configured: true,
  }),
}));

vi.mock('../src/core/lark-client', () => ({
  LarkClient: {
    runtime: {
      channel: {
        commands: {
          shouldComputeCommandAuthorized: false,
          resolveCommandAuthorizedFromAuthorizers: vi.fn(),
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

vi.mock('openclaw/plugin-sdk/allow-from', () => ({
  isNormalizedSenderAllowed: vi.fn().mockReturnValue(false),
}));

// Import after mocks
import { handleFeishuMessage } from '../src/messaging/inbound/handler';
import { dispatchToAgent } from '../src/messaging/inbound/dispatch';

const mockDispatchToAgent = vi.mocked(dispatchToAgent);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(content: string) {
  return {
    sender: { sender_id: { open_id: 'ou_sender' } },
    message: {
      message_id: 'om_test',
      chat_id: 'oc_chat',
      chat_type: 'p2p' as const,
      message_type: 'text',
      content,
    },
  };
}

function makeCtx(content: string, resources: unknown[] = []) {
  return {
    chatId: 'oc_chat',
    messageId: 'om_test',
    senderId: 'ou_sender',
    chatType: 'p2p' as const,
    content,
    contentType: 'text',
    resources,
    mentions: [],
    mentionAll: false,
    rawMessage: {},
    rawSender: {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleFeishuMessage — empty message guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSenderInfo.mockResolvedValue({
      ctx: makeCtx('hello'),
      permissionError: undefined,
    });
  });

  it('skips messages with empty content and no resources', async () => {
    mockParseMessageEvent.mockResolvedValue(makeCtx('', []));

    await handleFeishuMessage({
      cfg: { channels: { feishu: {} } } as never,
      event: makeEvent(''),
    });

    // Should NOT reach enrichment or dispatch
    expect(mockResolveSenderInfo).not.toHaveBeenCalled();
    expect(mockDispatchToAgent).not.toHaveBeenCalled();
  });

  it('skips messages with whitespace-only content and no resources', async () => {
    mockParseMessageEvent.mockResolvedValue(makeCtx('   ', []));

    await handleFeishuMessage({
      cfg: { channels: { feishu: {} } } as never,
      event: makeEvent('   '),
    });

    expect(mockResolveSenderInfo).not.toHaveBeenCalled();
    expect(mockDispatchToAgent).not.toHaveBeenCalled();
  });

  it('skips messages with empty string content and no resources', async () => {
    // The content converter resolves {"text":""} to "" during parse,
    // so by the time the guard runs ctx.content is already "".
    mockParseMessageEvent.mockResolvedValue(makeCtx('', []));

    await handleFeishuMessage({
      cfg: { channels: { feishu: {} } } as never,
      event: makeEvent(''),
    });

    expect(mockResolveSenderInfo).not.toHaveBeenCalled();
    expect(mockDispatchToAgent).not.toHaveBeenCalled();
  });

  it('allows messages with text content even without resources', async () => {
    mockParseMessageEvent.mockResolvedValue(makeCtx('hello world', []));
    mockResolveMedia.mockResolvedValue({ mediaList: [], payload: undefined });
    mockResolveQuotedMessageContext.mockResolvedValue(undefined);

    await handleFeishuMessage({
      cfg: { channels: { feishu: {} } } as never,
      event: makeEvent('hello world'),
    });

    expect(mockResolveSenderInfo).toHaveBeenCalled();
  });

  it('allows messages with resources even when content is empty', async () => {
    const resources = [{ type: 'image' as const, fileKey: 'img_key' }];
    mockParseMessageEvent.mockResolvedValue(makeCtx('', resources));
    mockResolveMedia.mockResolvedValue({ mediaList: [], payload: undefined });
    mockResolveQuotedMessageContext.mockResolvedValue(undefined);

    await handleFeishuMessage({
      cfg: { channels: { feishu: {} } } as never,
      event: makeEvent(''),
    });

    expect(mockResolveSenderInfo).toHaveBeenCalled();
  });
});
