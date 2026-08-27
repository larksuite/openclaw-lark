import { describe, expect, it } from 'vitest';
import { sanitizeLarkResultPayload, formatToolResult } from '../src/tools/helpers';

describe('sanitizeLarkResultPayload', () => {
  it('converts token and *_token fields to *_id to prevent OpenClaw redaction', () => {
    const rawData = {
      files: [
        {
          name: '2026-hailianhui',
          token: 'GHDdfAatEl1JL4dw8zscIuk2nYe',
          parent_token: 'nodcnMRuWz5tUfFIZfHraFfKOzf',
          type: 'folder',
          url: 'https://bcnvp2em7xkt.feishu.cn/drive/folder/GHDdfAatEl1JL4dw8zscIuk2nYe',
        },
        {
          name: '四川海外联谊会理事四川行活动总表.xlsx',
          token: 'LAJ5bGNnXoPhZYxHuIoctzUanRh',
          parent_token: 'nodcnMRuWz5tUfFIZfHraFfKOzf',
          type: 'file',
          url: 'https://bcnvp2em7xkt.feishu.cn/file/LAJ5bGNnXoPhZYxHuIoctzUanRh',
        },
      ],
      page_token: 'next_page_123',
      file_token: 'LAJ5bGNnXoPhZYxHuIoctzUanRh',
      folder_token: 'GHDdfAatEl1JL4dw8zscIuk2nYe',
      spreadsheet_token: 'shtcnXXXXX',
      app_token: 'bascnXXXXX',
      node_token: 'wikcnXXXXX',
    };

    const sanitized = sanitizeLarkResultPayload(rawData);

    // Verify folder token conversion
    expect(sanitized.files[0].folder_id).toBe('GHDdfAatEl1JL4dw8zscIuk2nYe');
    expect(sanitized.files[0].parent_id).toBe('nodcnMRuWz5tUfFIZfHraFfKOzf');
    expect('token' in sanitized.files[0]).toBe(false);
    expect('parent_token' in sanitized.files[0]).toBe(false);

    // Verify file token conversion
    expect(sanitized.files[1].file_id).toBe('LAJ5bGNnXoPhZYxHuIoctzUanRh');
    expect('token' in sanitized.files[1]).toBe(false);

    // Verify explicit *_token conversions
    expect(sanitized.file_id).toBe('LAJ5bGNnXoPhZYxHuIoctzUanRh');
    expect(sanitized.folder_id).toBe('GHDdfAatEl1JL4dw8zscIuk2nYe');
    expect(sanitized.spreadsheet_id).toBe('shtcnXXXXX');
    expect(sanitized.app_id).toBe('bascnXXXXX');
    expect(sanitized.node_id).toBe('wikcnXXXXX');

    // Verify page_token is preserved for pagination
    expect(sanitized.page_token).toBe('next_page_123');

    // Verify no forbidden keys exist
    const jsonStr = JSON.stringify(sanitized);
    expect(jsonStr).not.toContain('"token":');
    expect(jsonStr).not.toContain('"file_token":');
    expect(jsonStr).not.toContain('"folder_token":');
    expect(jsonStr).not.toContain('"spreadsheet_token":');
    expect(jsonStr).not.toContain('"app_token":');
    expect(jsonStr).not.toContain('"node_token":');
  });

  it('formatToolResult properly wraps sanitized payload in content and details', () => {
    const res = formatToolResult({
      file_token: 'GHDdfAatEl1JL4dw8zscIuk2nYe',
      name: 'test.docx',
    });

    expect(res.content[0].text).toContain('"file_id": "GHDdfAatEl1JL4dw8zscIuk2nYe"');
    expect(res.content[0].text).not.toContain('"file_token"');
    expect((res.details as any).file_id).toBe('GHDdfAatEl1JL4dw8zscIuk2nYe');
  });
});
