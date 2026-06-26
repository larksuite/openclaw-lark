import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatchPluginInteractiveHandler: vi.fn(),
  sendMessageFeishu: vi.fn(),
  sendCardFeishu: vi.fn(),
  updateCardFeishu: vi.fn(),
}));

vi.mock('openclaw/plugin-sdk/plugin-runtime', () => ({
  dispatchPluginInteractiveHandler: mocks.dispatchPluginInteractiveHandler,
}));

vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

vi.mock('../src/messaging/outbound/send', () => ({
  sendMessageFeishu: mocks.sendMessageFeishu,
  sendCardFeishu: mocks.sendCardFeishu,
  updateCardFeishu: mocks.updateCardFeishu,
}));

import { dispatchFeishuPluginInteractiveHandler } from '../src/channel/interactive-dispatch';

describe('dispatchFeishuPluginInteractiveHandler', () => {
  it('dispatches legacy card actions from action.value.action', async () => {
    const handler = vi.fn().mockReturnValue({ toast: { type: 'success', content: 'ok' } });
    mocks.dispatchPluginInteractiveHandler.mockImplementationOnce(async ({ data, invoke }) => {
      expect(data).toBe('followup_demo:submit');
      await invoke({
        registration: { handler },
        namespace: 'followup_demo',
        payload: 'submit',
      });
      return { matched: true };
    });

    const result = await dispatchFeishuPluginInteractiveHandler({
      cfg: {} as never,
      accountId: 'default',
      data: {
        operator: { open_id: 'ou_123' },
        open_chat_id: 'oc_123',
        open_message_id: 'om_123',
        action: { value: { action: 'followup_demo:submit' } },
      },
    });

    expect(result).toEqual({ toast: { type: 'success', content: 'ok' } });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'followup_demo:submit',
        namespace: 'followup_demo',
        payload: 'submit',
        senderId: 'ou_123',
        conversationId: 'oc_123',
        messageId: 'om_123',
      }),
    );
  });

  it('falls back to action.name for Schema 2 form submit callbacks', async () => {
    const handler = vi.fn().mockReturnValue({ toast: { type: 'success', content: 'submitted' } });
    mocks.dispatchPluginInteractiveHandler.mockImplementationOnce(async ({ data, invoke }) => {
      expect(data).toBe('followup_demo:submit:fu_123');
      await invoke({
        registration: { handler },
        namespace: 'followup_demo',
        payload: 'submit:fu_123',
      });
      return { matched: true };
    });

    const event = {
      operator: { user_id: 'ou_456' },
      context: {
        open_chat_id: 'oc_456',
        open_message_id: 'om_456',
      },
      action: {
        tag: 'button',
        name: 'followup_demo:submit:fu_123',
        form_value: {
          feedback: 'works',
        },
      },
    };

    const result = await dispatchFeishuPluginInteractiveHandler({
      cfg: {} as never,
      accountId: 'default',
      data: event,
    });

    expect(result).toEqual({ toast: { type: 'success', content: 'submitted' } });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'followup_demo:submit:fu_123',
        namespace: 'followup_demo',
        payload: 'submit:fu_123',
        senderId: 'ou_456',
        conversationId: 'oc_456',
        messageId: 'om_456',
        rawEvent: event,
      }),
    );
  });
});
