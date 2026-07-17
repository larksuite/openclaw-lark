import test from 'node:test';
import assert from 'node:assert/strict';

import { stripLeakedThinkingContent, sanitizeCardKitMarkdown } from '../src/card/markdown-style.ts';

// ---------------------------------------------------------------------------
// stripLeakedThinkingContent
// ---------------------------------------------------------------------------

test('stripLeakedThinkingContent: removes fully-closed <thinking> block', () => {
  const input = 'Hello <thinking>secret reasoning</thinking> world';
  assert.equal(stripLeakedThinkingContent(input), 'Hello  world');
});

test('stripLeakedThinkingContent: removes fully-closed <think> block', () => {
  const input = 'A <think>internal</think> B';
  assert.equal(stripLeakedThinkingContent(input), 'A  B');
});

test('stripLeakedThinkingContent: removes unclosed tag at end (streaming)', () => {
  const input = 'Answer text <thinking>still streaming...';
  assert.equal(stripLeakedThinkingContent(input), 'Answer text ');
});

test('stripLeakedThinkingContent: removes orphaned closing tag', () => {
  const input = '</thinking> leftover answer';
  assert.equal(stripLeakedThinkingContent(input), ' leftover answer');
});

test('stripLeakedThinkingContent: handles <antthinking> variant', () => {
  const input = '<antthinking>plan</antthinking>result';
  assert.equal(stripLeakedThinkingContent(input), 'result');
});

test('stripLeakedThinkingContent: passes through clean text', () => {
  const input = 'No thinking tags here';
  assert.equal(stripLeakedThinkingContent(input), 'No thinking tags here');
});

test('stripLeakedThinkingContent: handles empty/null input', () => {
  assert.equal(stripLeakedThinkingContent(''), '');
});

// ---------------------------------------------------------------------------
// sanitizeCardKitMarkdown
// ---------------------------------------------------------------------------

test('sanitizeCardKitMarkdown: closes unclosed triple-backtick fence', () => {
  const input = 'Text\n```python\nprint("hello")';
  const result = sanitizeCardKitMarkdown(input);
  assert.ok(result.endsWith('\n```'), `Expected closing fence, got: ${result}`);
});

test('sanitizeCardKitMarkdown: leaves balanced fences untouched', () => {
  const input = 'Before\n```\ncode\n```\nAfter';
  assert.equal(sanitizeCardKitMarkdown(input), input);
});

test('sanitizeCardKitMarkdown: closes unclosed inline backtick', () => {
  const input = 'Use the `command to run';
  const result = sanitizeCardKitMarkdown(input);
  // Should have even number of backticks
  const count = (result.match(/`/g) || []).length;
  assert.equal(count % 2, 0, `Backtick count should be even, got ${count}`);
});

test('sanitizeCardKitMarkdown: escapes bare angle brackets outside code', () => {
  const input = 'Use <MyComponent> in your app';
  const result = sanitizeCardKitMarkdown(input);
  assert.ok(result.includes('&lt;'), `Expected escaped <, got: ${result}`);
});

test('sanitizeCardKitMarkdown: preserves <br> tags', () => {
  const input = 'Line one<br>Line two';
  const result = sanitizeCardKitMarkdown(input);
  assert.ok(result.includes('<br>'), `Expected <br> preserved, got: ${result}`);
});

test('sanitizeCardKitMarkdown: does NOT escape < inside inline code', () => {
  const input = 'Use `<div>` in your template';
  const result = sanitizeCardKitMarkdown(input);
  // The < inside backticks should remain unescaped
  assert.ok(result.includes('`<div>`'), `Expected < preserved in inline code, got: ${result}`);
});

test('sanitizeCardKitMarkdown: does NOT escape < inside fenced code block', () => {
  const input = '```html\n<div class="test">\n```';
  const result = sanitizeCardKitMarkdown(input);
  assert.ok(result.includes('<div'), `Expected < preserved in code block, got: ${result}`);
});

test('sanitizeCardKitMarkdown: handles empty input', () => {
  assert.equal(sanitizeCardKitMarkdown(''), '');
});

test('sanitizeCardKitMarkdown: does NOT escape < inside double-backtick inline code', () => {
  const input = 'Use ``x < 10`` in condition';
  const result = sanitizeCardKitMarkdown(input);
  assert.ok(result.includes('``x < 10``'), `Expected < preserved in double-backtick code, got: ${result}`);
});

test('sanitizeCardKitMarkdown: does NOT escape < inside fenced code block with language tag', () => {
  const input = '```typescript\nconst x: Array<number> = [1];\n```';
  const result = sanitizeCardKitMarkdown(input);
  assert.ok(!result.includes('&lt;'), `Expected no &lt; in fenced code block, got: ${result}`);
});

test('sanitizeCardKitMarkdown: escapes < in long lines (no char limit)', () => {
  const longComponent = '<' + 'A'.repeat(200) + '>';
  const input = `Use ${longComponent} in your app`;
  const result = sanitizeCardKitMarkdown(input);
  assert.ok(result.includes('&lt;'), `Expected < to be escaped even in long lines, got: ${result}`);
});

test('sanitizeCardKitMarkdown: handles mixed fenced and inline code with angle brackets', () => {
  const input = 'Use `<div>` before\n```html\n<span>hi</span>\n```\nand <p> after';
  const result = sanitizeCardKitMarkdown(input);
  // < in inline code preserved
  assert.ok(result.includes('`<div>`'), `Expected inline code preserved, got: ${result}`);
  // < in fenced code preserved
  assert.ok(result.includes('<span>'), `Expected fenced code preserved, got: ${result}`);
  // < outside code escaped
  assert.ok(result.includes('&lt;p>'), `Expected bare < escaped, got: ${result}`);
});

test('sanitizeCardKitMarkdown: unclosed fenced code block with < inside gets protected', () => {
  const input = 'text\n```js\nif (x < 10) {';
  const result = sanitizeCardKitMarkdown(input);
  assert.ok(!result.includes('&lt;'), `Expected < inside code block not escaped, got: ${result}`);
});

test('sanitizeCardKitMarkdown: multiple fenced code blocks preserve angle brackets', () => {
  const input = '```\nfoo < bar\n```\noutside <tag>\n```\nbaz < qux\n```';
  const result = sanitizeCardKitMarkdown(input);
  assert.ok(result.includes('foo < bar'), `Expected < preserved in first code block`);
  assert.ok(result.includes('baz < qux'), `Expected < preserved in second code block`);
  assert.ok(result.includes('&lt;tag>'), `Expected bare < escaped outside code blocks`);
});
