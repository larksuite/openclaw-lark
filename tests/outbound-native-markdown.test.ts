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
