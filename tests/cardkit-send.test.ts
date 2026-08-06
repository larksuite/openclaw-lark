import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendCardByCardId } from '../src/card/cardkit';
import { LarkClient } from '../src/core/lark-client';

const TEST_CFG = {} as never;

function mockMessageApi(response: unknown) {
  const reply = vi.fn().mockResolvedValue(response);
  const create = vi.fn().mockResolvedValue(response);
  vi.spyOn(LarkClient, 'fromCfg').mockReturnValue({
    sdk: { im: { message: { reply, create } } },
  } as never);
  return { reply, create };
}

describe('sendCardByCardId', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a resolved IM business failure', async () => {
    mockMessageApi({ code: 230001, msg: 'business rejected' });

    await expect(
      sendCardByCardId({
        cfg: TEST_CFG,
        to: 'oc_test',
        cardId: 'card_test',
        replyToMessageId: 'om_parent',
      }),
    ).rejects.toThrow('code=230001');
  });

  it('rejects a resolved IM response without message_id', async () => {
    mockMessageApi({ code: 0, msg: 'success', data: { chat_id: 'oc_test' } });

    await expect(
      sendCardByCardId({
        cfg: TEST_CFG,
        to: 'oc_test',
        cardId: 'card_test',
        replyToMessageId: 'om_parent',
      }),
    ).rejects.toThrow('no message_id returned');
  });
});
