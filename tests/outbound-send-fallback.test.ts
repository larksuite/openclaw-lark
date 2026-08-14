/**
 * System-command / reply send error handling (issue #588).
 *
 * Regression tests: sendMessageFeishu / sendCardFeishu must not swallow
 * non-zero Feishu API codes (e.g. 230001 invalid container_id) — a failed
 * reply previously reported `delivered=true` while nothing was sent. Non-
 * thread replies now fall back to a direct create so the message arrives.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let mockSdk: any = null;

vi.mock('../src/core/lark-client', () => ({
  LarkClient: {
    fromCfg: () => ({ sdk: mockSdk }),
  },
}));

import { sendCardFeishu, sendMessageFeishu } from '../src/messaging/outbound/send';

const CFG = { appId: 'cli_test_app', appSecret: 'secret' } as any;

function makeSdk() {
  const reply = vi.fn();
  const create = vi.fn();
  mockSdk = { im: { message: { reply, create } } };
  return { reply, create };
}

beforeEach(() => {
  makeSdk();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('sendMessageFeishu reply error handling (#588)', () => {
  it('surfaces a non-zero reply code for thread replies (no fallback)', async () => {
    const { reply, create } = mockSdk.im.message;
    reply.mockResolvedValue({ code: 230001, msg: 'invalid container_id' });

    await expect(
      sendMessageFeishu({
        cfg: CFG,
        to: 'oc_chat_1',
        text: 'hello',
        replyToMessageId: 'om_msg_1',
        accountId: 'acc',
        replyInThread: true,
      }),
    ).rejects.toThrow('230001');
    expect(create).not.toHaveBeenCalled();
  });

  it('falls back to a direct create when a non-thread reply fails', async () => {
    const { reply, create } = mockSdk.im.message;
    reply.mockResolvedValue({ code: 230001, msg: 'invalid container_id' });
    create.mockResolvedValue({ code: 0, data: { message_id: 'om_created', chat_id: 'oc_chat_1' } });

    const res = await sendMessageFeishu({
      cfg: CFG,
      to: 'oc_chat_1',
      text: 'hello',
      replyToMessageId: 'om_msg_1',
      accountId: 'acc',
      replyInThread: false,
    });

    expect(create).toHaveBeenCalledTimes(1);
    const createCall = create.mock.calls[0][0];
    expect(createCall.params.receive_id_type).toBe('chat_id');
    expect(createCall.data.receive_id).toBe('oc_chat_1');
    expect(createCall.data.msg_type).toBe('post');
    expect(res.messageId).toBe('om_created');
  });

  it('does not fall back when the reply succeeds', async () => {
    const { reply, create } = mockSdk.im.message;
    reply.mockResolvedValue({ code: 0, data: { message_id: 'om_replied', chat_id: 'oc_chat_1' } });

    const res = await sendMessageFeishu({
      cfg: CFG,
      to: 'oc_chat_1',
      text: 'hello',
      replyToMessageId: 'om_msg_1',
      accountId: 'acc',
      replyInThread: false,
    });

    expect(res.messageId).toBe('om_replied');
    expect(create).not.toHaveBeenCalled();
  });

  it('falls back when the reply throws (e.g. withdrawn message)', async () => {
    const { reply, create } = mockSdk.im.message;
    reply.mockRejectedValue(new Error('boom'));
    create.mockResolvedValue({ code: 0, data: { message_id: 'om_fb', chat_id: 'oc_chat_1' } });

    const res = await sendMessageFeishu({
      cfg: CFG,
      to: 'oc_chat_1',
      text: 'hello',
      replyToMessageId: 'om_msg_1',
      accountId: 'acc',
      replyInThread: false,
    });

    expect(res.messageId).toBe('om_fb');
  });

  it('propagates the error when the fallback create also fails', async () => {
    const { reply, create } = mockSdk.im.message;
    reply.mockResolvedValue({ code: 230001, msg: 'invalid container_id' });
    create.mockResolvedValue({ code: 99991661, msg: 'no permission' });

    await expect(
      sendMessageFeishu({
        cfg: CFG,
        to: 'oc_chat_1',
        text: 'hello',
        replyToMessageId: 'om_msg_1',
        accountId: 'acc',
        replyInThread: false,
      }),
    ).rejects.toThrow('99991661');
  });
});

describe('sendCardFeishu reply error handling (#588)', () => {
  it('surfaces a non-zero reply code for thread cards (no fallback)', async () => {
    const { reply, create } = mockSdk.im.message;
    reply.mockResolvedValue({ code: 230001, msg: 'invalid container_id' });

    await expect(
      sendCardFeishu({
        cfg: CFG,
        to: 'oc_chat_1',
        card: { type: 'card', data: {} },
        replyToMessageId: 'om_msg_1',
        accountId: 'acc',
        replyInThread: true,
      }),
    ).rejects.toThrow('230001');
    expect(create).not.toHaveBeenCalled();
  });

  it('falls back to a direct create when a non-thread card reply fails', async () => {
    const { reply, create } = mockSdk.im.message;
    reply.mockResolvedValue({ code: 230001, msg: 'invalid container_id' });
    create.mockResolvedValue({ code: 0, data: { message_id: 'om_card', chat_id: 'oc_chat_1' } });

    const res = await sendCardFeishu({
      cfg: CFG,
      to: 'oc_chat_1',
      card: { type: 'card', data: {} },
      replyToMessageId: 'om_msg_1',
      accountId: 'acc',
      replyInThread: false,
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data.msg_type).toBe('interactive');
    expect(res.messageId).toBe('om_card');
  });
});
