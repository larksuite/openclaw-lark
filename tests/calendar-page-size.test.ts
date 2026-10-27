import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { FeishuCalendarCalendarSchema } from '../src/tools/oapi/calendar/calendar';

describe('Feishu calendar list page size', () => {
  it('accepts omitted page size and values in the documented range', () => {
    expect(Value.Check(FeishuCalendarCalendarSchema, { action: 'list' })).toBe(true);
    expect(Value.Check(FeishuCalendarCalendarSchema, { action: 'list', page_size: 50 })).toBe(true);
    expect(Value.Check(FeishuCalendarCalendarSchema, { action: 'list', page_size: 1000 })).toBe(true);
  });

  it('rejects page sizes outside the API range before making a request', () => {
    expect(Value.Check(FeishuCalendarCalendarSchema, { action: 'list', page_size: 49 })).toBe(false);
    expect(Value.Check(FeishuCalendarCalendarSchema, { action: 'list', page_size: 1001 })).toBe(false);
    expect(Value.Check(FeishuCalendarCalendarSchema, { action: 'list', page_size: 50.5 })).toBe(false);
  });
});
