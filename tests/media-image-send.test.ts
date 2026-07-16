import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fromCfg: vi.fn(),
  imageCreate: vi.fn(),
  messageCreate: vi.fn(),
  messageReply: vi.fn(),
}));

vi.mock('../src/core/lark-client', () => ({
  LarkClient: {
    fromCfg: mocks.fromCfg,
  },
}));

vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { uploadAndSendImageLark } from '../src/messaging/outbound/media';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l4p2bQAAAABJRU5ErkJggg==',
  'base64',
);

function installSdkMock(): void {
  mocks.fromCfg.mockReturnValue({
    sdk: {
      im: {
        image: {
          create: mocks.imageCreate,
        },
        message: {
          create: mocks.messageCreate,
          reply: mocks.messageReply,
        },
      },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  installSdkMock();
  mocks.imageCreate.mockResolvedValue({ code: 0, data: { image_key: 'img_test' } });
  mocks.messageCreate.mockResolvedValue({ code: 0, data: { message_id: 'om_test', chat_id: 'oc_test' } });
  mocks.messageReply.mockResolvedValue({ code: 0, data: { message_id: 'om_reply', chat_id: 'oc_test' } });
});

describe('uploadAndSendImageLark', () => {
  it('uploads and sends a real image message from a buffer', async () => {
    const result = await uploadAndSendImageLark({
      cfg: {} as never,
      to: 'oc_test',
      imageBuffer: PNG_1X1,
      fileName: 'no-extension',
    });

    expect(mocks.imageCreate).toHaveBeenCalledTimes(1);
    expect(mocks.imageCreate.mock.calls[0][0].data.image_type).toBe('message');
    expect(mocks.messageCreate).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_test',
        msg_type: 'image',
        content: JSON.stringify({ image_key: 'img_test' }),
      },
    });
    expect(result).toMatchObject({
      messageId: 'om_test',
      chatId: 'oc_test',
      imageKey: 'img_test',
      imageFormat: 'png',
      width: 1,
      height: 1,
    });
  });

  it('rejects non-image buffers before upload', async () => {
    await expect(
      uploadAndSendImageLark({
        cfg: {} as never,
        to: 'oc_test',
        imageBuffer: Buffer.from('not an image'),
      }),
    ).rejects.toThrow('unable to recognise the image format');

    expect(mocks.imageCreate).not.toHaveBeenCalled();
    expect(mocks.messageCreate).not.toHaveBeenCalled();
  });

  it('fails when Feishu does not return a message_id', async () => {
    mocks.messageCreate.mockResolvedValueOnce({ code: 0, data: { chat_id: 'oc_test' } });

    await expect(
      uploadAndSendImageLark({
        cfg: {} as never,
        to: 'oc_test',
        imageBuffer: PNG_1X1,
      }),
    ).rejects.toThrow('without a message_id');
  });
});
