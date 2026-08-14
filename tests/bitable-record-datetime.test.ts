/**
 * feishu_bitable_app_table_record DateTime field normalization (issue #586).
 *
 * Regression tests: numeric ms-timestamp values for Bitable DateTime fields
 * (type 5 / 1005) must be coerced to strings before hitting the API —
 * the API rejects numbers with DatetimeFieldConvFail (1254064). Other field
 * types pass through untouched, and a failed field-metadata lookup never
 * blocks the write.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerFeishuBitableAppTableRecordTool } from '../src/tools/oapi/bitable/app-table-record';

let capturedTool: any = null;
let mockClient: any = null;
let mockSdk: any = null;
const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeSdk(items: Array<{ field_name: string; type: number }>) {
  const listFields = vi.fn(async () => ({ code: 0, data: { items } }));
  const recordOk = vi.fn(async (payload: unknown) => ({
    code: 0,
    data: { record: { record_id: 'rec_1' } },
  }));
  const batchOk = vi.fn(async (payload: unknown) => ({
    code: 0,
    data: { records: [{ record_id: 'rec_1' }] },
  }));
  mockSdk = {
    bitable: {
      appTableField: { list: listFields },
      appTableRecord: {
        create: recordOk,
        update: recordOk,
        batchCreate: batchOk,
        batchUpdate: batchOk,
      },
    },
  };
  mockClient = {
    invoke: vi.fn(async (_name: string, cb: (sdk: unknown, opts: unknown) => unknown) => cb(mockSdk, {})),
  };
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
  registerFeishuBitableAppTableRecordTool(api);
  expect(capturedTool).toBeTruthy();
  return capturedTool;
}

beforeEach(() => {
  capturedTool = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('feishu_bitable_app_table_record DateTime normalization (#586)', () => {
  it('coerces DateTime numbers to strings on create, leaves other types alone', async () => {
    makeSdk([
      { field_name: '首次发现时间', type: 5 },
      { field_name: '结束时间', type: 1005 },
      { field_name: '数量', type: 2 },
    ]);
    const tool = registerApi();
    await tool.execute('c1', {
      action: 'create',
      app_token: 'app_t1',
      table_id: 'tbl_1',
      fields: {
        首次发现时间: 1783582702000,
        结束时间: 1783582702000,
        数量: 5,
        事项名称: '测试',
      },
    });
    const sent = mockSdk.bitable.appTableRecord.create.mock.calls[0][0];
    expect(sent.data.fields['首次发现时间']).toBe('1783582702000');
    expect(sent.data.fields['结束时间']).toBe('1783582702000');
    expect(sent.data.fields['数量']).toBe(5);
    expect(sent.data.fields['事项名称']).toBe('测试');
  });

  it('coerces DateTime numbers on update', async () => {
    makeSdk([{ field_name: '截止时间', type: 5 }]);
    const tool = registerApi();
    await tool.execute('c2', {
      action: 'update',
      app_token: 'app_t2',
      table_id: 'tbl_2',
      record_id: 'rec_9',
      fields: { 截止时间: 1783582702000 },
    });
    const sent = mockSdk.bitable.appTableRecord.update.mock.calls[0][0];
    expect(sent.data.fields['截止时间']).toBe('1783582702000');
  });

  it('normalizes every record in batch_create', async () => {
    makeSdk([{ field_name: '首次发现时间', type: 5 }]);
    const tool = registerApi();
    await tool.execute('c3', {
      action: 'batch_create',
      app_token: 'app_t3',
      table_id: 'tbl_3',
      records: [
        { fields: { 首次发现时间: 1783582702000 } },
        { fields: { 首次发现时间: 1783582703000 } },
      ],
    });
    const sent = mockSdk.bitable.appTableRecord.batchCreate.mock.calls[0][0];
    expect(sent.data.records[0].fields['首次发现时间']).toBe('1783582702000');
    expect(sent.data.records[1].fields['首次发现时间']).toBe('1783582703000');
  });

  it('normalizes every record in batch_update', async () => {
    makeSdk([{ field_name: '办结时间', type: 5 }]);
    const tool = registerApi();
    await tool.execute('c4', {
      action: 'batch_update',
      app_token: 'app_t4',
      table_id: 'tbl_4',
      records: [{ record_id: 'rec_1', fields: { 办结时间: 1783582702000 } }],
    });
    const sent = mockSdk.bitable.appTableRecord.batchUpdate.mock.calls[0][0];
    expect(sent.data.records[0].fields['办结时间']).toBe('1783582702000');
  });

  it('passes values through unchanged when the field lookup fails', async () => {
    makeSdk([]);
    mockSdk.bitable.appTableField.list.mockRejectedValueOnce(new Error('no permission'));
    const tool = registerApi();
    const res = await tool.execute('c5', {
      action: 'create',
      app_token: 'app_t5',
      table_id: 'tbl_5',
      fields: { 首次发现时间: 1783582702000, 数量: 5 },
    });
    expect(res.details.record.record_id).toBe('rec_1');
    const sent = mockSdk.bitable.appTableRecord.create.mock.calls[0][0];
    expect(sent.data.fields['首次发现时间']).toBe(1783582702000); // untouched
    expect(sent.data.fields['数量']).toBe(5);
    expect(mockLog.warn).toHaveBeenCalled();
  });

  it('caches field metadata per table within the TTL', async () => {
    makeSdk([{ field_name: '首次发现时间', type: 5 }]);
    const tool = registerApi();
    await tool.execute('c6a', {
      action: 'create',
      app_token: 'app_t6',
      table_id: 'tbl_6',
      fields: { 首次发现时间: 1783582702000 },
    });
    await tool.execute('c6b', {
      action: 'create',
      app_token: 'app_t6',
      table_id: 'tbl_6',
      fields: { 首次发现时间: 1783582703000 },
    });
    expect(mockSdk.bitable.appTableField.list).toHaveBeenCalledTimes(1);
    const sent = mockSdk.bitable.appTableRecord.create.mock.calls[1][0];
    expect(sent.data.fields['首次发现时间']).toBe('1783582703000');
  });
});
