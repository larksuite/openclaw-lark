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

describe('convertPost — native md passthrough & image intercept (M1 Task 2)', () => {
  it('AC-M1-H2: tag:md native markdown is passed through verbatim', async () => {
    const r = await run({ content_v2: [[{ tag: 'md', text: '## Heading\n- item' }]] });
    expect(r.content).toContain('## Heading\n- item');
  });

  it('AC-M1-E3: feishu image_key registered+normalized; external/data: kept as-is', async () => {
    const md = '![a](img_v3_abc) ![b](https://x/y.png) ![c](data:image/png;base64,AA)';
    const r = await run({ content_v2: [[{ tag: 'md', text: md }]] });
    expect(r.resources).toEqual([{ type: 'image', fileKey: 'img_v3_abc' }]);
    expect(r.content).toContain('![image](img_v3_abc)');
    expect(r.content).toContain('![b](https://x/y.png)');
    expect(r.content).toContain('![c](data:image/png;base64,AA)');
  });

  it('AC-M1-E4: duplicate fileKey registered once; first marker kept, rest → alt, no bare key', async () => {
    const md = '![first](img_v3_dup) then ![second](img_v3_dup)';
    const r = await run({ content_v2: [[{ tag: 'md', text: md }]] });
    expect(r.resources).toEqual([{ type: 'image', fileKey: 'img_v3_dup' }]);
    const markerCount = (r.content.match(/!\[image\]\(img_v3_dup\)/g) ?? []).length;
    expect(markerCount).toBe(1);
    expect(r.content).toContain('second');
    expect(r.content).not.toMatch(/!\[image\]\(img_v3_dup\)[\s\S]*!\[image\]\(img_v3_dup\)/);
  });

  it('§4.3: caps oversized inbound markdown at a safe boundary and tags [truncated]', async () => {
    const huge = ('x'.repeat(50_000) + '\n').repeat(5); // > MAX_INBOUND_MD_LEN(100000)
    const r = await run({ content_v2: [[{ tag: 'md', text: huge }]] });
    expect(r.content.length).toBeLessThanOrEqual(100_020);
    expect(r.content.endsWith('[truncated]')).toBe(true);
  });

  it('§4.3: drops image resources whose marker is truncated away (no orphan downloads)', async () => {
    const filler = 'y'.repeat(100_000);
    const md = `![keep](img_v3_keep)\n${filler}\n![gone](img_v3_gone)`;
    const r = await run({ content_v2: [[{ tag: 'md', text: md }]] });
    expect(r.resources.some((x) => x.fileKey === 'img_v3_keep')).toBe(true);
    expect(r.resources.some((x) => x.fileKey === 'img_v3_gone')).toBe(false);
    expect(r.content).toContain('[truncated]');
  });
});

describe('convertPost — code-block image exclusion (M1 Task 2 enhancement)', () => {
  it('image inside a fenced code block is kept verbatim, never registered', async () => {
    const md = '```\n![a](img_v3_fenced)\n```';
    const r = await run({ content_v2: [[{ tag: 'md', text: md }]] });
    expect(r.resources).toEqual([]);
    expect(r.content).toContain('![a](img_v3_fenced)');
    expect(r.content).not.toContain('![image](img_v3_fenced)');
  });

  it('image inside a language-tagged fenced block is excluded', async () => {
    const md = '```md\nsee ![logo](img_v3_lang) here\n```';
    const r = await run({ content_v2: [[{ tag: 'md', text: md }]] });
    expect(r.resources).toEqual([]);
    expect(r.content).toContain('![logo](img_v3_lang)');
  });

  it('image inside a ~~~ fenced block is excluded', async () => {
    const md = '~~~\n![a](img_v3_tilde)\n~~~';
    const r = await run({ content_v2: [[{ tag: 'md', text: md }]] });
    expect(r.resources).toEqual([]);
    expect(r.content).toContain('![a](img_v3_tilde)');
  });

  it('image inside an inline code span is kept verbatim, never registered', async () => {
    const md = 'use `![a](img_v3_inline)` literally';
    const r = await run({ content_v2: [[{ tag: 'md', text: md }]] });
    expect(r.resources).toEqual([]);
    expect(r.content).toContain('`![a](img_v3_inline)`');
    expect(r.content).not.toContain('![image](img_v3_inline)');
  });

  it('normal-text image after a closed fenced block is still intercepted', async () => {
    const md = '```\ncode\n```\n![real](img_v3_after)';
    const r = await run({ content_v2: [[{ tag: 'md', text: md }]] });
    expect(r.resources).toEqual([{ type: 'image', fileKey: 'img_v3_after' }]);
    expect(r.content).toContain('![image](img_v3_after)');
  });

  it('same key in a code block and in body: only the body occurrence is registered', async () => {
    const md = '```\n![doc](img_v3_both)\n```\nand ![real](img_v3_both)';
    const r = await run({ content_v2: [[{ tag: 'md', text: md }]] });
    expect(r.resources).toEqual([{ type: 'image', fileKey: 'img_v3_both' }]);
    expect(r.content).toContain('![doc](img_v3_both)'); // code block verbatim
    expect(r.content).toContain('![image](img_v3_both)'); // body normalized
  });
});
