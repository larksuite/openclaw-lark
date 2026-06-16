import { describe, expect, it } from 'vitest';
import { shouldUseCard } from '../src/card/reply-mode';

describe('shouldUseCard — scope A: never force a card for rich text (M2 Task 1)', () => {
  it('AC-M2-H1: a fenced code block no longer forces a card', () => {
    expect(shouldUseCard('```ts\nconst a = 1;\n```')).toBe(false);
  });

  it('AC-M2-H2: a single markdown table no longer forces a card', () => {
    expect(shouldUseCard('| h1 | h2 |\n| --- | --- |\n| 1 | 2 |')).toBe(false);
  });

  it('AC-M2-E1: tables beyond FEISHU_CARD_TABLE_LIMIT stay on the text path (false)', () => {
    const manyTables = Array.from(
      { length: 5 },
      (_, i) => `| a${i} | b |\n| --- | --- |\n| 1 | 2 |`,
    ).join('\n\n');
    expect(shouldUseCard(manyTables)).toBe(false);
  });

  it('plain text without code/tables is unaffected (false)', () => {
    expect(shouldUseCard('just a normal sentence')).toBe(false);
  });
});

import { optimizeMarkdownStyle } from '../src/card/markdown-style';

describe('outbound post text transform — scope A invariants (M2 Task 2)', () => {
  it('AC-M2-H2: a markdown table survives the only remaining transform (no table conversion)', () => {
    const table = '| h1 | h2 |\n| --- | --- |\n| a | b |';
    const out = optimizeMarkdownStyle(table, 1);
    expect(out).toContain('| h1 | h2 |');
    expect(out).toContain('| --- | --- |');
    expect(out).toContain('| a | b |');
  });

  it('AC-M2-H3: heading downgrade is preserved (scope A keeps optimizeMarkdownStyle)', () => {
    expect(optimizeMarkdownStyle('# Title', 1)).toMatch(/^#### Title/);
  });

  it('AC-M2-R1: external image link is still filtered by stripInvalidImageKeys', () => {
    const out = optimizeMarkdownStyle('before ![x](https://a/b.png) after', 1);
    expect(out).not.toContain('https://a/b.png');
  });
});

describe('outbound post text transform — table/paragraph separation (F-3 regression)', () => {
  const table = '| 城市 | 人口 |\n| --- | --- |\n| 北京 | 2189万 |\n| 上海 | 2487万 |';

  it('F-3: table immediately followed by text gets a blank line so it is not lazy-continued', () => {
    const out = optimizeMarkdownStyle(`各城市人口如下:\n${table}\n数据截至2024年,仅供参考。`, 1);
    // The trailing sentence must be a separate paragraph (blank line after the table block).
    expect(out).toMatch(/2487万 \|\n\n数据截至2024年,仅供参考。/);
  });

  it('F-3: a leading sentence directly above the table is also separated', () => {
    const out = optimizeMarkdownStyle(`各城市人口如下:\n${table}`, 1);
    expect(out).toMatch(/各城市人口如下:\n\n\| 城市 \| 人口 \|/);
  });

  it('F-3: idempotent — an already-blank-separated paragraph is not double-spaced', () => {
    const out = optimizeMarkdownStyle(`${table}\n\n数据截至2024年。`, 1);
    expect(out).toContain('| 上海 | 2487万 |\n\n数据截至2024年。');
    expect(out).not.toContain('\n\n\n');
  });

  it('F-3: a table at end of message (no trailing text) is unchanged', () => {
    const out = optimizeMarkdownStyle(table, 1);
    expect(out).toBe(table);
  });

  it('F-3: pipe lines inside a fenced code block are NOT treated as a table', () => {
    const src = '```\n| a | b |\n| c | d |\n```\nafter';
    const out = optimizeMarkdownStyle(src, 1);
    expect(out).toContain('```\n| a | b |\n| c | d |\n```');
  });

  it('F-3: two directly-adjacent tables are not split by a spurious blank line', () => {
    const two = '| a | b |\n| --- | --- |\n| 1 | 2 |\n| c | d |\n| --- | --- |\n| 3 | 4 |';
    const out = optimizeMarkdownStyle(two, 1);
    expect(out).toBe(two);
  });

  it('F-3: a large table at end-of-message stays unchanged and is processed quickly (no O(n^2))', () => {
    const rows = Array.from({ length: 2000 }, (_, i) => `| ${i} | v${i} |`).join('\n');
    const big = `| h1 | h2 |\n| --- | --- |\n${rows}`;
    const start = performance.now();
    const out = optimizeMarkdownStyle(big, 1);
    const elapsed = performance.now() - start;
    expect(out).toBe(big);
    expect(elapsed).toBeLessThan(200);
  });
});
