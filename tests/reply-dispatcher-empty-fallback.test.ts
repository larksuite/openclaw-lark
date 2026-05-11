import { describe, expect, it } from 'vitest';
import { EMPTY_REPLY_FALLBACK_TEXT } from '../src/card/reply-dispatcher-types';

describe('EMPTY_REPLY_FALLBACK_TEXT', () => {
  it('does not imply that an empty run completed successfully', () => {
    expect(EMPTY_REPLY_FALLBACK_TEXT).toBe('The run finished without a displayable final reply.');
    expect(EMPTY_REPLY_FALLBACK_TEXT).not.toBe('Done.');
  });
});
