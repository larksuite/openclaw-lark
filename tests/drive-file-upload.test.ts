/**
 * feishu_drive_file upload parent_type routing (issue #582).
 *
 * Regression tests: the upload action must accept `parent_type`
 * (explorer | bitable_file | bitable_image) and route bitable parents
 * through the media upload API, whose file_tokens are accepted by Bitable
 * attachment fields. Previously `parent_type: 'explorer'` was hardcoded, so
 * tokens could never be written into Bitable attachments.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerFeishuDriveFileTool } from '../src/tools/oapi/drive/file';

let capturedTool: any = null;
let mockClient: any = null;
let mockSdk: any = null;
const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeSdk() {
  const call = (fn: (...args: unknown[]) => unknown) => vi.fn(fn);
  const file = {
    uploadAll: call((payload: unknown) => ({ code: 0, data: { file_token: 'file_tok_explorer' } })),
    uploadPrepare: call((payload: unknown) => ({
      code: 0,
      data: { upload_id: 'up_1', block_size: 1048576, block_num: 2 },
    })),
    uploadPart: call((payload: unknown) => ({ code: 0, data: {} })),
    uploadFinish: call((payload: unknown) => ({ code: 0, data: { file_token: 'file_tok_chunked' } })),
  };
  const media = {
    uploadAll: call((payload: unknown) => ({ code: 0, data: { file_token: 'media_tok_bitable' } })),
    uploadPrepare: call((payload: unknown) => ({
      code: 0,
      data: { upload_id: 'up_2', block_size: 1048576, block_num: 2 },
    })),
    uploadPart: call((payload: unknown) => ({ code: 0, data: {} })),
    uploadFinish: call((payload: unknown) => ({ code: 0, data: { file_token: 'media_tok_chunked' } })),
  };
  mockSdk = { drive: { file, media } };
  mockClient = {
    invoke: vi.fn(async (_name: string, cb: (sdk: unknown, opts: unknown) => unknown) => cb(mockSdk, {})),
  };
  return mockSdk;
}

vi.mock('../src/tools/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tools/helpers')>();
  return {
    ...actual,
    registerTool: (_api: any, tool: any) => {
      capturedTool = tool;
      return true;
    },
    createToolContext: () => ({
      getClient: () => mockClient,
      toolClient: () => mockClient,
      log: mockLog,
    }),
  };
});

function registerApi() {
  const api = { config: {} } as any;
  const ok = registerFeishuDriveFileTool(api);
  expect(ok).toBe(true);
  return capturedTool;
}

const B64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

beforeEach(() => {
  capturedTool = null;
  makeSdk();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('feishu_drive_file upload parent_type (#582)', () => {
  it('defaults to explorer and calls drive.file.uploadAll', async () => {
    const tool = registerApi();
    const res = await tool.execute('c1', {
      action: 'upload',
      file_content_base64: B64('hello'),
      file_name: 'a.txt',
      size: 5,
    });
    expect(res.details.file_token).toBe('file_tok_explorer');
    expect(mockClient.invoke).toHaveBeenCalledTimes(1);
    const sdk = mockSdk;
    expect(sdk.drive.file.uploadAll).toHaveBeenCalledTimes(1);
    expect(sdk.drive.file.uploadAll.mock.calls[0][0].data.parent_type).toBe('explorer');
    expect(sdk.drive.media.uploadAll).not.toHaveBeenCalled();
  });

  it('routes bitable_image through drive.media.uploadAll', async () => {
    const tool = registerApi();
    const res = await tool.execute('c2', {
      action: 'upload',
      parent_type: 'bitable_image',
      parent_node: 'app_token_123',
      file_content_base64: B64('img'),
      file_name: 'p.png',
      size: 3,
    });
    expect(res.details.file_token).toBe('media_tok_bitable');
    const sdk = mockSdk;
    expect(sdk.drive.media.uploadAll).toHaveBeenCalledTimes(1);
    const payload = sdk.drive.media.uploadAll.mock.calls[0][0];
    expect(payload.data.parent_type).toBe('bitable_image');
    expect(payload.data.parent_node).toBe('app_token_123');
    expect(sdk.drive.file.uploadAll).not.toHaveBeenCalled();
  });

  it('routes bitable_file through drive.media.uploadAll', async () => {
    const tool = registerApi();
    await tool.execute('c3', {
      action: 'upload',
      parent_type: 'bitable_file',
      parent_node: 'app_token_456',
      file_content_base64: B64('doc'),
      file_name: 'd.docx',
      size: 3,
    });
    const sdk = mockSdk;
    expect(sdk.drive.media.uploadAll).toHaveBeenCalledTimes(1);
    expect(sdk.drive.media.uploadAll.mock.calls[0][0].data.parent_type).toBe('bitable_file');
  });

  it('routes large bitable uploads through the media chunked API', async () => {
    const tool = registerApi();
    // 16MB > 15MB threshold
    const big = Buffer.alloc(16 * 1024 * 1024, 1);
    await tool.execute('c4', {
      action: 'upload',
      parent_type: 'bitable_file',
      parent_node: 'app_token_789',
      file_content_base64: big.toString('base64'),
      file_name: 'big.bin',
      size: big.length,
    });
    const sdk = mockSdk;
    expect(sdk.drive.media.uploadPrepare).toHaveBeenCalledTimes(1);
    expect(sdk.drive.media.uploadPrepare.mock.calls[0][0].data.parent_type).toBe('bitable_file');
    expect(sdk.drive.media.uploadPart).toHaveBeenCalled();
    expect(sdk.drive.media.uploadFinish).toHaveBeenCalled();
    expect(sdk.drive.file.uploadPrepare).not.toHaveBeenCalled();
  });

  it('keeps large explorer uploads on the file chunked API', async () => {
    const tool = registerApi();
    const big = Buffer.alloc(16 * 1024 * 1024, 2);
    await tool.execute('c5', {
      action: 'upload',
      file_content_base64: big.toString('base64'),
      file_name: 'big.bin',
      size: big.length,
    });
    const sdk = mockSdk;
    expect(sdk.drive.file.uploadPrepare).toHaveBeenCalledTimes(1);
    expect(sdk.drive.file.uploadPrepare.mock.calls[0][0].data.parent_type).toBe('explorer');
    expect(sdk.drive.media.uploadPrepare).not.toHaveBeenCalled();
  });

  it('exposes parent_type in the tool schema', () => {
    const tool = registerApi();
    const uploadSchema = (tool.parameters as any).anyOf.find(
      (s: any) => s.properties?.action?.const === 'upload' || s.properties?.action?.enum?.includes('upload'),
    );
    const parentType = uploadSchema?.properties?.parent_type;
    expect(parentType).toBeTruthy();
    expect(parentType.enum).toContain('explorer');
    expect(parentType.enum).toContain('bitable_file');
    expect(parentType.enum).toContain('bitable_image');
  });
});
