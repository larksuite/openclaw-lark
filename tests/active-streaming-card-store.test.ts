import { describe, expect, it, vi } from 'vitest';
import {
  deliverTextToActiveStreamingCard,
  registerActiveStreamingCard,
} from '../src/card/active-streaming-card-store';
import type { StreamingCardController } from '../src/card/streaming-card-controller';

function createController() {
  return {
    cardMessageId: 'om_card',
    onDeliver: vi.fn().mockResolvedValue(undefined),
  } as unknown as StreamingCardController & { onDeliver: ReturnType<typeof vi.fn> };
}

describe('active streaming card store', () => {
  it('routes same-session text-only sends to the active card', async () => {
    const controller = createController();
    const unregister = registerActiveStreamingCard({
      sessionKey: 'Agent:Main:Feishu:Direct:User',
      accountId: 'default',
      chatId: 'oc_chat',
      controller,
    });

    try {
      const result = await deliverTextToActiveStreamingCard({
        sessionKey: 'agent:main:feishu:direct:user',
        accountId: 'default',
        to: 'chat:oc_chat',
        text: 'final answer',
      });

      expect(result).toEqual({
        ok: true,
        messageId: 'om_card',
        chatId: 'oc_chat',
        routedViaStreamingCard: true,
      });
      expect(controller.onDeliver).toHaveBeenCalledWith({ text: 'final answer' });
    } finally {
      unregister();
    }
  });

  it('does not route card, media, or different-target sends', async () => {
    const controller = createController();
    const unregister = registerActiveStreamingCard({
      sessionKey: 'session-2',
      accountId: 'default',
      chatId: 'oc_chat',
      controller,
    });

    try {
      await expect(deliverTextToActiveStreamingCard({ sessionKey: 'session-2', text: 'x', card: {} })).resolves.toBe(
        null,
      );
      await expect(
        deliverTextToActiveStreamingCard({ sessionKey: 'session-2', text: 'x', mediaUrl: 'https://example.test/a.png' }),
      ).resolves.toBe(null);
      await expect(
        deliverTextToActiveStreamingCard({ sessionKey: 'session-2', text: 'x', to: 'oc_other' }),
      ).resolves.toBe(null);
      expect(controller.onDeliver).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });
});
