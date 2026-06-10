import { describe, expect, it } from 'vitest';
import { convertPost } from '../src/messaging/converters/post';
import type { ConvertContext } from '../src/messaging/converters/types';

// convertPost 仅需 mentions 两个空 Map（resolveMentions 在 size===0 时直接返回原文）。
function ctx(): ConvertContext {
  return {
    mentions: new Map(),
    mentionsByOpenId: new Map(),
    messageId: 'm-test',
  } as ConvertContext;
}

async function run(body: unknown) {
  return convertPost(JSON.stringify(body), ctx());
}

describe('convertPost — content_v2 selection (M1 Task 1)', () => {
  it('AC-M1-H1: prefers non-empty content_v2 over content', async () => {
    const r = await run({
      content: [[{ tag: 'text', text: 'FROM_V1' }]],
      content_v2: [[{ tag: 'text', text: 'FROM_V2' }]],
    });
    expect(r.content).toContain('FROM_V2');
    expect(r.content).not.toContain('FROM_V1');
  });

  it('AC-M1-H1: flat post with only content_v2 is recognized (C1 flat detection)', async () => {
    const r = await run({ content_v2: [[{ tag: 'text', text: 'ONLY_V2' }]] });
    expect(r.content).toContain('ONLY_V2');
  });

  it('AC-M1-E1: empty content_v2 array falls back to content', async () => {
    const r = await run({
      content: [[{ tag: 'text', text: 'FALLBACK_BODY' }]],
      content_v2: [],
    });
    expect(r.content).toBe('FALLBACK_BODY');
  });

  it('AC-M1-E2: missing content_v2 behaves exactly like legacy content', async () => {
    const r = await run({ content: [[{ tag: 'text', text: 'LEGACY' }]] });
    expect(r.content).toBe('LEGACY');
  });

  it('AC-M1-E5: locale-wrapped content_v2 is selected after unwrap', async () => {
    const r = await run({ zh_cn: { content_v2: [[{ tag: 'text', text: 'LOCALE_V2' }]] } });
    expect(r.content).toContain('LOCALE_V2');
  });

  it('AC-M1-R1: non-array content_v2 safely falls back to content without throwing', async () => {
    const r = await run({
      content: [[{ tag: 'text', text: 'SAFE_FALLBACK' }]],
      content_v2: 'not-an-array',
    });
    expect(r.content).toBe('SAFE_FALLBACK');
  });
});
