import { beforeEach, describe, expect, it, vi } from 'vitest';
import { convertMessageContent } from '../src/messaging/converters/content-converter';
import type { ApiMessageItem, ConvertContext } from '../src/messaging/converters/types';
import { downloadResources } from '../src/messaging/inbound/media-resolver';

const mocks = vi.hoisted(() => ({
  getResource: vi.fn(),
  fromCfg: vi.fn(),
  saveMediaBuffer: vi.fn(),
  detectMime: vi.fn(),
}));

vi.mock('../src/core/lark-client', () => ({
  LarkClient: {
    fromCfg: mocks.fromCfg,
    runtime: {
      media: { detectMime: mocks.detectMime },
      channel: { media: { saveMediaBuffer: mocks.saveMediaBuffer } },
    },
  },
}));

vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function context(items: ApiMessageItem[]): ConvertContext {
  return {
    messageId: 'om_forward',
    accountId: 'test-account',
    mentions: new Map(),
    mentionsByOpenId: new Map(),
    fetchSubMessages: vi.fn().mockResolvedValue(items),
  };
}

const htmlItem: ApiMessageItem = {
  message_id: 'om_html',
  msg_type: 'file',
  create_time: '1700000000000',
  body: { content: JSON.stringify({ file_key: 'file_html', file_name: 'example.html' }) },
};
const imageItem: ApiMessageItem = {
  message_id: 'om_image',
  msg_type: 'image',
  create_time: '1700000000001',
  body: { content: JSON.stringify({ image_key: 'img_example' }) },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.fromCfg.mockReturnValue({ sdk: { im: { messageResource: { get: mocks.getResource } } } });
  mocks.saveMediaBuffer.mockImplementation(async (_buffer, contentType, _category, _maxBytes, fileName) => ({
    path: `/inbound/${fileName ?? 'image.png'}`,
    contentType,
  }));
});

describe('merged-forward resources', () => {
  it('downloads HTML and image resources with their owning child message IDs', async () => {
    const html = Buffer.from('<!doctype html><p>forwarded attachment</p>');
    const image = Buffer.from([137, 80, 78, 71]);
    mocks.getResource.mockImplementation(async ({ path }) => {
      if (path.message_id === 'om_html' && path.file_key === 'file_html') {
        return { data: html, headers: { 'content-type': 'text/html' } };
      }
      if (path.message_id === 'om_image' && path.file_key === 'img_example') {
        return { data: image, headers: { 'content-type': 'image/png' } };
      }
      throw new Error('resource requested using the wrong message');
    });
    const result = await convertMessageContent('{}', 'merge_forward', context([htmlItem, imageItem]));
    const cfg = {};
    const media = await downloadResources({
      cfg,
      messageId: 'om_forward',
      accountId: 'test-account',
      resources: result.resources,
      maxBytes: 1024,
    });

    expect(media).toHaveLength(2);
    expect(mocks.getResource.mock.calls.map(([request]) => request)).toEqual([
      { path: { message_id: 'om_html', file_key: 'file_html' }, params: { type: 'file' } },
      { path: { message_id: 'om_image', file_key: 'img_example' }, params: { type: 'image' } },
    ]);
    expect(mocks.fromCfg.mock.calls).toEqual([[cfg, 'test-account'], [cfg, 'test-account']]);
    expect(mocks.saveMediaBuffer).toHaveBeenNthCalledWith(1, html, 'text/html', 'inbound', 1024, 'example.html');
    expect(mocks.saveMediaBuffer).toHaveBeenNthCalledWith(2, image, 'image/png', 'inbound', 1024, undefined);
    expect(result.content).toContain('example.html');
    expect(result.content).toContain('img_example');
  });

  it('collects nested leaf resources without fetching nested containers again', async () => {
    const ctx = context([
      { message_id: 'om_nested', msg_type: 'merge_forward', create_time: '1700000000001' },
      { ...imageItem, upper_message_id: 'om_nested' },
      htmlItem,
    ]);
    const result = await convertMessageContent('{}', 'merge_forward', ctx);

    expect(result.resources).toEqual([
      { type: 'file', fileKey: 'file_html', fileName: 'example.html', messageId: 'om_html' },
      { type: 'image', fileKey: 'img_example', messageId: 'om_image' },
    ]);
    expect(ctx.fetchSubMessages).toHaveBeenCalledExactlyOnceWith('om_forward');
    expect(result.content.indexOf('example.html')).toBeLessThan(result.content.indexOf('img_example'));
  });

  it('keeps the enclosing message ID for ordinary attachments', async () => {
    mocks.getResource.mockResolvedValue({ data: Buffer.from('ordinary'), headers: { 'content-type': 'text/html' } });
    const result = await convertMessageContent(htmlItem.body!.content!, 'file', context([]));
    await downloadResources({ cfg: {}, messageId: 'om_ordinary', resources: result.resources, maxBytes: 1024 });

    expect(mocks.getResource).toHaveBeenCalledExactlyOnceWith({
      path: { message_id: 'om_ordinary', file_key: 'file_html' },
      params: { type: 'file' },
    });
    expect(result.resources[0]).not.toHaveProperty('messageId');
  });

  it('uses API child identity rather than an ID returned by a sub-converter', async () => {
    const resource = { type: 'file' as const, fileKey: 'file_html', messageId: 'om_unrelated' };
    const ctx = context([htmlItem]);
    ctx.convertMessageContent = vi.fn().mockResolvedValue({ content: '[file]', resources: [resource] });
    const result = await convertMessageContent('{}', 'merge_forward', ctx);

    expect(result.resources).toEqual([{ ...resource, messageId: 'om_html' }]);
    expect(resource.messageId).toBe('om_unrelated');
  });

  it.each(['missing callback', 'empty response', 'failed fetch'])('keeps empty-forward behavior for %s', async (scenario) => {
    const ctx = context([]);
    if (scenario === 'missing callback') ctx.fetchSubMessages = undefined;
    if (scenario === 'failed fetch') ctx.fetchSubMessages = vi.fn().mockRejectedValue(new Error('synthetic fetch failure'));
    expect(await convertMessageContent('{}', 'merge_forward', ctx)).toEqual({
      content: '<forwarded_messages/>', resources: [],
    });
    expect(mocks.getResource).not.toHaveBeenCalled();
  });

  it('continues downloading a sibling when another attachment is unavailable', async () => {
    mocks.getResource.mockRejectedValueOnce(new Error('resource unavailable')).mockResolvedValueOnce({
      data: Buffer.from('image bytes'), headers: { 'content-type': 'image/png' },
    });
    const result = await convertMessageContent('{}', 'merge_forward', context([htmlItem, imageItem]));
    const log = vi.fn();
    const media = await downloadResources({ cfg: {}, messageId: 'om_forward', resources: result.resources, maxBytes: 1024, log });

    expect(media).toHaveLength(1);
    expect(media[0].fileKey).toBe('img_example');
    expect(mocks.getResource).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('failed to download file resource file_html'));
  });
});
