/**
 * Tests for replyFallbackOnWithdrawn account-scoped config resolution
 * and silent-discard regression guards (sentinel leak, cache symmetry).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import { getLarkAccount } from '../src/core/accounts';
import { getReplyFallbackMode } from '../src/messaging/outbound/send';

// ---------------------------------------------------------------------------
// Deliver-path mocks (hoisted)
// ---------------------------------------------------------------------------

const mockReply = vi.fn();
const mockCreate = vi.fn();

vi.mock('../src/core/lark-client', () => ({
  LarkClient: {
    fromCfg: () => ({
      sdk: {
        im: {
          message: {
            reply: (...args: unknown[]) => mockReply(...args),
            create: (...args: unknown[]) => mockCreate(...args),
          },
        },
      },
    }),
  },
}));

vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../src/core/accounts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/accounts')>();
  return {
    ...actual,
    getLarkAccount: vi.fn().mockReturnValue({
      accountId: 'test-account',
      config: {},
      enabled: true,
      configured: true,
    }),
  };
});

vi.mock('../src/messaging/outbound/normalize-mentions', () => ({
  normalizeOutboundMentions: vi.fn().mockResolvedValue({
    normalizedText: 'normalized',
    sentinels: [{ key: 's1', text: 'sentinel-text', ts: Date.now() }],
  }),
}));

vi.mock('../src/channel/chat-queue', () => ({
  threadScopedKey: (chatId: string, threadId?: string) => `${chatId}:${threadId ?? ''}`,
}));

vi.mock('../src/messaging/inbound/sentinel-store', () => ({
  getSentinelStore: vi.fn().mockReturnValue({
    recordSentinels: vi.fn(),
  }),
}));

// Import after mocks
import { sendTextLark } from '../src/messaging/outbound/deliver';
import { markMessageUnavailable } from '../src/core/message-unavailable';
import { getSentinelStore } from '../src/messaging/inbound/sentinel-store';

vi.mock('../src/core/message-unavailable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/message-unavailable')>();
  return {
    ...actual,
    markMessageUnavailable: vi.fn(actual.markMessageUnavailable),
  };
});

const mockMarkMessageUnavailable = vi.mocked(markMessageUnavailable);
const mockGetSentinelStore = vi.mocked(getSentinelStore);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCfg(feishu: Record<string, unknown>): ClawdbotConfig {
  return { channels: { feishu } } as unknown as ClawdbotConfig;
}

function makeTerminalError(code: number) {
  return { response: { data: { code } } };
}

// ---------------------------------------------------------------------------
// getReplyFallbackMode – account-scoped resolution
// ---------------------------------------------------------------------------

describe('getReplyFallbackMode – account-scoped resolution', () => {
  it('defaults to silent when no config is set', () => {
    const cfg = makeCfg({ appId: 'a', appSecret: 'sa' });
    expect(getReplyFallbackMode(cfg)).toBe('silent');
    expect(getReplyFallbackMode(cfg, 'main')).toBe('silent');
  });

  it('reads top-level replyFallbackOnWithdrawn', () => {
    const cfg = makeCfg({ appId: 'a', appSecret: 'sa', replyFallbackOnWithdrawn: 'top-level' });
    expect(getReplyFallbackMode(cfg)).toBe('top-level');
  });

  it('account override takes precedence over top-level', () => {
    const cfg = makeCfg({
      appId: 'a',
      appSecret: 'sa',
      replyFallbackOnWithdrawn: 'silent',
      accounts: {
        'bot-b': { appId: 'b', appSecret: 'sb', replyFallbackOnWithdrawn: 'top-level' },
      },
    });
    expect(getReplyFallbackMode(cfg)).toBe('silent');
    expect(getReplyFallbackMode(cfg, 'bot-b')).toBe('top-level');
  });

  it('account inherits top-level value when no override is set', () => {
    const cfg = makeCfg({
      appId: 'a',
      appSecret: 'sa',
      replyFallbackOnWithdrawn: 'top-level',
      accounts: {
        'bot-b': { appId: 'b', appSecret: 'sb' },
      },
    });
    expect(getReplyFallbackMode(cfg, 'bot-b')).toBe('top-level');
  });

  it('defaults to silent when account exists but has no override and no top-level value', () => {
    const cfg = makeCfg({
      appId: 'a',
      appSecret: 'sa',
      accounts: {
        'bot-b': { appId: 'b', appSecret: 'sb' },
      },
    });
    expect(getReplyFallbackMode(cfg, 'bot-b')).toBe('silent');
  });
});

// ---------------------------------------------------------------------------
// Silent-discard regression guards
// ---------------------------------------------------------------------------

describe('sendTextLark – silent-discard regression guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: create returns a valid result for top-level fallback path
    mockCreate.mockResolvedValue({
      data: { message_id: 'om_created', chat_id: 'oc_chat' },
    });
  });

  it('does NOT record sentinels when reply is silently discarded (230011)', async () => {
    // im.message.reply throws 230011 (message recalled)
    mockReply.mockRejectedValue(makeTerminalError(230011));

    const cfg = makeCfg({ appId: 'a', appSecret: 'sa', replyFallbackOnWithdrawn: 'silent' });

    const result = await sendTextLark({
      cfg,
      to: 'oc_chat',
      text: 'hello',
      replyToMessageId: 'om_recalled',
    });

    // Silent discard → empty messageId
    expect(result.messageId).toBe('');

    // Sentinels must NOT be recorded (the message was never sent)
    expect(mockGetSentinelStore).not.toHaveBeenCalled();
  });

  it('marks unavailable cache on 230011 terminal error in deliver path', async () => {
    mockReply.mockRejectedValue(makeTerminalError(230011));

    const cfg = makeCfg({ appId: 'a', appSecret: 'sa', replyFallbackOnWithdrawn: 'silent' });

    await sendTextLark({
      cfg,
      to: 'oc_chat',
      text: 'hello',
      replyToMessageId: 'om_recalled',
    });

    expect(mockMarkMessageUnavailable).toHaveBeenCalledWith({
      messageId: 'om_recalled',
      apiCode: 230011,
      operation: 'im.message.reply(post)',
    });
  });

  it('marks unavailable cache on 231003 terminal error in deliver path', async () => {
    mockReply.mockRejectedValue(makeTerminalError(231003));

    const cfg = makeCfg({ appId: 'a', appSecret: 'sa', replyFallbackOnWithdrawn: 'silent' });

    await sendTextLark({
      cfg,
      to: 'oc_chat',
      text: 'hello',
      replyToMessageId: 'om_deleted',
    });

    expect(mockMarkMessageUnavailable).toHaveBeenCalledWith({
      messageId: 'om_deleted',
      apiCode: 231003,
      operation: 'im.message.reply(post)',
    });
  });

  it('records sentinels normally on successful reply', async () => {
    mockReply.mockResolvedValue({
      data: { message_id: 'om_reply', chat_id: 'oc_chat' },
    });

    const cfg = makeCfg({ appId: 'a', appSecret: 'sa' });

    const result = await sendTextLark({
      cfg,
      to: 'oc_chat',
      text: 'hello',
      replyToMessageId: 'om_original',
      threadId: 'om_thread',
    });

    expect(result.messageId).toBe('om_reply');
    expect(mockGetSentinelStore).toHaveBeenCalled();
  });
});
