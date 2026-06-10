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
