import { describe, expect, it } from 'vitest';
import { optimizeMarkdownStyle } from '../src/card/markdown-style';

describe('optimizeMarkdownStyle', () => {
  it('preserves fenced code blocks that use longer backtick fences', () => {
    const input = ['**Result**', '````text', 'before', '```', '# inside heading', '````', 'tail'].join('\n');

    expect(optimizeMarkdownStyle(input, 1)).toBe(input);
  });
});
