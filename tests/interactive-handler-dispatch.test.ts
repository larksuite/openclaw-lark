import { describe, expect, it, vi } from 'vitest';

import { dispatchFeishuInteractiveHandler } from '../src/channel/interactive-handler-dispatch';
import * as syntheticMessage from '../src/messaging/inbound/synthetic-message';

describe('dispatchFeishuInteractiveHandler', () => {
  it('returns default ack and dispatches rendered prompt to Agent', async () => {
    const dispatchSpy = vi
      .spyOn(syntheticMessage, 'dispatchSyntheticTextMessage')
      .mockResolvedValue('queued');
    const cfg = {
      channels: {
        feishu: {
          interactive: {
            enabled: true,
            defaultAck: {
              toast: { type: 'info', content: 'Processing…' },
              cardPatch: 'processing',
            },
            handlers: {
              approval: {
                prompt: 'Process card action {{action}} with context:\n{{context}}',
              },
            },
          },
        },
      },
    };
    const result = await dispatchFeishuInteractiveHandler({
      cfg: cfg as never,
      accountId: 'default',
      data: {
        operator: { open_id: 'ou_1' },
        open_chat_id: 'oc_1',
        open_message_id: 'om_1',
        action: {
          value: {
            action: 'approval:approve',
            approval: { action: 'approve', payload: { requestId: 'req-1' } },
          },
        },
      },
    });
    expect(result).toMatchObject({
      toast: { type: 'info', content: 'Processing…' },
      card: { type: 'raw' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const call = dispatchSpy.mock.calls[0]?.[0];
    expect(call?.text).toContain('Process card action approval:approve');
    expect(call?.text).toContain('"requestId": "req-1"');
    expect(call?.forceMention).toBe(true);
    dispatchSpy.mockRestore();
  });

  it('returns undefined when namespace handler is not configured', async () => {
    const result = await dispatchFeishuInteractiveHandler({
      cfg: { channels: { feishu: { interactive: { handlers: {} } } } } as never,
      accountId: 'default',
      data: {
        action: { value: { action: 'unknown:go' } },
      },
    });
    expect(result).toBeUndefined();
  });
});
