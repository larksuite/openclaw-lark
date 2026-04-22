import { describe, expect, it } from 'vitest';
import { FeishuAccountConfigSchema, FeishuGroupSchema } from '../src/core/config-schema';

describe('allowBots schema', () => {
  it('accepts boolean true on group', () => {
    const r = FeishuGroupSchema.safeParse({ allowBots: true });
    expect(r.success).toBe(true);
    expect(r.data!.allowBots).toBe(true);
  });

  it('accepts "mentions" string on group', () => {
    const r = FeishuGroupSchema.safeParse({ allowBots: 'mentions' });
    expect(r.success).toBe(true);
    expect(r.data!.allowBots).toBe('mentions');
  });

  it('rejects other strings', () => {
    const r = FeishuGroupSchema.safeParse({ allowBots: 'yes' });
    expect(r.success).toBe(false);
  });

  it('accepts allowBots on account-level', () => {
    const r = FeishuAccountConfigSchema.safeParse({ allowBots: false });
    expect(r.success).toBe(true);
    expect(r.data!.allowBots).toBe(false);
  });

  it('defaults to undefined', () => {
    const r = FeishuAccountConfigSchema.safeParse({});
    expect(r.success).toBe(true);
    expect(r.data!.allowBots).toBeUndefined();
  });
});
