import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dispatchReplyWithBufferedBlockDispatcherMock, sendMessageFeishuMock } = vi.hoisted(() => ({
  dispatchReplyWithBufferedBlockDispatcherMock: vi.fn(),
  sendMessageFeishuMock: vi.fn().mockResolvedValue({}),
}));

vi.mock('../src/core/lark-client', () => ({
  LarkClient: {
    runtime: {
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: dispatchReplyWithBufferedBlockDispatcherMock,
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
  createFeishuReplyDispatcher: vi.fn(),
}));

vi.mock('../src/card/tool-use-trace-store', () => ({
  startToolUseTraceRun: vi.fn(),
}));

vi.mock('../src/messaging/outbound/send', () => ({
  sendMessageFeishu: sendMessageFeishuMock,
}));

vi.mock('../src/messaging/inbound/dispatch-builders', () => ({
  buildInboundPayload: vi.fn(),
}));

import { dispatchSystemCommand } from '../src/messaging/inbound/dispatch-commands';
import type { DispatchContext } from '../src/messaging/inbound/dispatch-context';

type TestDispatchContext = DispatchContext & {
  log: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

interface BufferedFinalReplyParams {
  dispatcherOptions: {
    deliver: (payload: { text?: string }, info: { kind: 'final' }) => Promise<void>;
    onError?: (err: unknown, info: { kind: 'final' }) => void;
  };
}

async function dispatchBufferedFinalReply(params: BufferedFinalReplyParams, text: string): Promise<void> {
  try {
    await params.dispatcherOptions.deliver({ text }, { kind: 'final' });
  } catch (err) {
    params.dispatcherOptions.onError?.(err, { kind: 'final' });
  }
}

function createDispatchContext(content: string) {
  return {
    ctx: {
      chatId: 'chat-1',
      messageId: 'om_msg_1',
      senderId: 'ou_sender_1',
      content,
    },
    accountScopedCfg: {} as never,
    account: { accountId: 'default' },
    log: vi.fn(),
    error: vi.fn(),
    core: {
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: dispatchReplyWithBufferedBlockDispatcherMock,
        },
      },
    },
    isThread: false,
  } as unknown as TestDispatchContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  sendMessageFeishuMock.mockReset().mockResolvedValue({});
});

describe('dispatchSystemCommand', () => {
  it('redacts email addresses and retries once when Feishu rejects a system reply with code 230028', async () => {
    const auditError = Object.assign(new Error('Request failed with status code 400'), {
      response: {
        data: {
          code: 230028,
          msg: 'The messages do NOT pass the audit, ext=contain sensitive data: EMAIL_ADDRESS',
        },
      },
    });

    sendMessageFeishuMock.mockRejectedValueOnce(auditError).mockResolvedValueOnce({});
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(async (params: BufferedFinalReplyParams) =>
      dispatchBufferedFinalReply(params, 'oauth (User.Name+OAuth@Sub.Example.COM)\nbackup@example.co.uk'),
    );

    const dc = createDispatchContext('/status');
    await dispatchSystemCommand(dc, {} as never, 'om_reply_1');

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
    expect(sendMessageFeishuMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        text: 'oauth (User.Name+OAuth@Sub.Example.COM)\nbackup@example.co.uk',
      }),
    );
    expect(dc.log).toHaveBeenCalledWith(expect.stringContaining('retrying with email addresses redacted'));
    expect(dc.log).toHaveBeenCalledWith(expect.stringContaining('system command dispatched (delivered=true)'));
    expect(dc.log.mock.calls.flat().join('\n')).not.toContain('User.Name+OAuth@Sub.Example.COM');
    expect(dc.log.mock.calls.flat().join('\n')).not.toContain('backup@example.co.uk');
    expect(sendMessageFeishuMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        text: 'oauth (User.Name+OAuth [at] Sub.Example.COM)\nbackup [at] example.co.uk',
      }),
    );
  });

  it('keeps an email address unchanged when Feishu accepts the first system reply', async () => {
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(
      async (params: {
        dispatcherOptions: {
          deliver: (payload: { text?: string }, info: { kind: 'final' }) => Promise<void>;
        };
      }) => {
        await params.dispatcherOptions.deliver({ text: 'Contact user@example.com for help' }, { kind: 'final' });
      },
    );

    await dispatchSystemCommand(createDispatchContext('/help'), {} as never, 'om_reply_1');

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Contact user@example.com for help',
      }),
    );
  });

  it('does not retry an audit rejection when the system reply contains no email address', async () => {
    const auditError = Object.assign(new Error('audit rejected'), {
      code: 230028,
      msg: 'The messages do NOT pass the audit',
    });
    sendMessageFeishuMock.mockRejectedValueOnce(auditError);
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(async (params: BufferedFinalReplyParams) =>
      dispatchBufferedFinalReply(params, 'System status is healthy'),
    );

    const dc = createDispatchContext('/status');
    await dispatchSystemCommand(dc, {} as never, 'om_reply_1');

    expect(dc.error).toHaveBeenCalledWith(expect.stringContaining('command final reply failed: Error: audit rejected'));
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(dc.log).toHaveBeenCalledWith(expect.stringContaining('system command dispatched (delivered=false)'));
  });

  it('does not retry email-containing system replies for unrelated Feishu errors', async () => {
    const unrelatedError = Object.assign(new Error('rate limited'), { code: 230020 });
    sendMessageFeishuMock.mockRejectedValueOnce(unrelatedError);
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(async (params: BufferedFinalReplyParams) =>
      dispatchBufferedFinalReply(params, 'oauth (user@example.com)'),
    );

    const dc = createDispatchContext('/status');
    await dispatchSystemCommand(dc, {} as never, 'om_reply_1');

    expect(dc.error).toHaveBeenCalledWith(expect.stringContaining('command final reply failed: Error: rate limited'));
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(dc.log).toHaveBeenCalledWith(expect.stringContaining('system command dispatched (delivered=false)'));
  });

  it('retries at most once when the redacted system reply is also rejected', async () => {
    const firstAuditError = Object.assign(new Error('first audit rejection'), { code: 230028 });
    const secondAuditError = Object.assign(new Error('second audit rejection'), { code: 230028 });
    sendMessageFeishuMock.mockRejectedValueOnce(firstAuditError).mockRejectedValueOnce(secondAuditError);
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(async (params: BufferedFinalReplyParams) =>
      dispatchBufferedFinalReply(params, 'oauth (user@example.com)'),
    );

    const dc = createDispatchContext('/status');
    await dispatchSystemCommand(dc, {} as never, 'om_reply_1');

    expect(dc.error).toHaveBeenCalledWith(
      expect.stringContaining('command final reply failed: Error: second audit rejection'),
    );
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
    expect(dc.log).toHaveBeenCalledWith(expect.stringContaining('system command dispatched (delivered=false)'));
  });

  it.each(['/new', '/reset'])(
    'suppresses tool detail deliveries for %s session lifecycle commands',
    async (command) => {
      dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(
        async (params: {
          dispatcherOptions: {
            deliver: (payload: { text?: string }, info: { kind: 'tool' | 'final' | 'block' }) => Promise<void>;
          };
          replyOptions: {
            shouldEmitToolResult?: () => boolean;
            shouldEmitToolOutput?: () => boolean;
          };
        }) => {
          expect(params.replyOptions.shouldEmitToolResult).toBeUndefined();
          expect(params.replyOptions.shouldEmitToolOutput).toBeUndefined();

          await params.dispatcherOptions.deliver({ text: '📖 Read startup.md' }, { kind: 'tool' });
          await params.dispatcherOptions.deliver({ text: 'New session started' }, { kind: 'final' });
        },
      );

      await dispatchSystemCommand(createDispatchContext(command), {} as never, 'om_reply_1');

      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
      expect(sendMessageFeishuMock).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'New session started',
        }),
      );
    },
  );

  it('keeps tool detail deliveries for non-session system commands', async () => {
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(
      async (params: {
        dispatcherOptions: {
          deliver: (payload: { text?: string }, info: { kind: 'tool' | 'final' | 'block' }) => Promise<void>;
        };
        replyOptions: {
          shouldEmitToolResult?: () => boolean;
          shouldEmitToolOutput?: () => boolean;
        };
      }) => {
        expect(params.replyOptions.shouldEmitToolResult).toBeUndefined();
        expect(params.replyOptions.shouldEmitToolOutput).toBeUndefined();

        await params.dispatcherOptions.deliver({ text: '🔧 Help lookup' }, { kind: 'tool' });
        await params.dispatcherOptions.deliver({ text: 'Help text' }, { kind: 'final' });
      },
    );

    await dispatchSystemCommand(createDispatchContext('/help'), {} as never, 'om_reply_1');

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
    expect(sendMessageFeishuMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        text: '🔧 Help lookup',
      }),
    );
    expect(sendMessageFeishuMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        text: 'Help text',
      }),
    );
  });
});
