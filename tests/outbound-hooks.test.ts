import { beforeEach, describe, expect, it, vi } from 'vitest';

const { hasHooks, runMessageSending, warn } = vi.hoisted(() => ({
  hasHooks: vi.fn(),
  runMessageSending: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('openclaw/plugin-sdk/plugin-runtime', () => ({
  getGlobalHookRunner: () => ({ hasHooks, runMessageSending }),
}));

vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }),
}));

import { applyFeishuMessageSendingHook, hasFeishuMessageSendingHooks } from '../src/messaging/outbound/hooks';

beforeEach(() => {
  vi.clearAllMocks();
  hasHooks.mockReturnValue(true);
  runMessageSending.mockResolvedValue(undefined);
});

describe('applyFeishuMessageSendingHook', () => {
  it('reports whether message_sending hooks are registered', () => {
    expect(hasFeishuMessageSendingHooks()).toBe(true);
    hasHooks.mockReturnValueOnce(false);
    expect(hasFeishuMessageSendingHooks()).toBe(false);
  });

  it('passes Feishu delivery context and applies rewritten content', async () => {
    runMessageSending.mockResolvedValueOnce({ content: 'rewritten reply' });

    const result = await applyFeishuMessageSendingHook({
      to: 'oc_chat',
      text: 'original reply',
      accountId: 'default',
      mediaUrls: ['https://example.com/image.png'],
    });

    expect(runMessageSending).toHaveBeenCalledWith(
      {
        to: 'oc_chat',
        content: 'original reply',
        metadata: {
          channel: 'feishu',
          accountId: 'default',
          mediaUrls: ['https://example.com/image.png'],
        },
      },
      {
        channelId: 'feishu',
        accountId: 'default',
        conversationId: 'oc_chat',
      },
    );
    expect(result).toEqual({ cancelled: false, text: 'rewritten reply' });
  });

  it('returns the cancellation decision', async () => {
    runMessageSending.mockResolvedValueOnce({ cancel: true });

    await expect(
      applyFeishuMessageSendingHook({
        to: 'oc_chat',
        text: 'original reply',
      }),
    ).resolves.toEqual({ cancelled: true, text: 'original reply' });
  });

  it('does not invoke the runner when no message_sending hooks are registered', async () => {
    hasHooks.mockReturnValueOnce(false);

    await expect(
      applyFeishuMessageSendingHook({
        to: 'oc_chat',
        text: 'original reply',
      }),
    ).resolves.toEqual({ cancelled: false, text: 'original reply' });
    expect(runMessageSending).not.toHaveBeenCalled();
  });

  it('fails open when a hook invocation throws', async () => {
    runMessageSending.mockRejectedValueOnce(new Error('hook failed'));

    await expect(
      applyFeishuMessageSendingHook({
        to: 'oc_chat',
        text: 'original reply',
      }),
    ).resolves.toEqual({ cancelled: false, text: 'original reply' });
    expect(warn).toHaveBeenCalledWith('message_sending hook failed; proceeding with original content', {
      error: 'Error: hook failed',
    });
  });
});
