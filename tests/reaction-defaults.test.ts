import { describe, expect, it } from 'vitest';
import { readReactionParams } from '../src/core/sdk-compat';
import { readReactionMessageId } from '../src/messaging/outbound/actions';

describe('readReactionParams', () => {
  it.each([
    ['👍', 'THUMBSUP'],
    ['+1', 'THUMBSUP'],
    ['thumbs_up', 'THUMBSUP'],
    ['👎', 'THUMBSDOWN'],
    ['👏', 'APPLAUSE'],
    ['heart', 'LOVE'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(readReactionParams({ emoji: input }).emoji).toBe(expected);
  });

  it('passes through Feishu reaction type names', () => {
    expect(readReactionParams({ emoji: 'MUSCLE' }).emoji).toBe('MUSCLE');
  });
});

describe('readReactionMessageId', () => {
  it('accepts message_id as an alias for messageId', () => {
    expect(readReactionMessageId({ message_id: 'om_1' })).toBe('om_1');
  });

  it('falls back to the current inbound message id from tool context', () => {
    expect(readReactionMessageId({}, { currentMessageId: 'om_current' } as never)).toBe('om_current');
  });

  it('prefers explicit messageId over the current inbound message id', () => {
    expect(readReactionMessageId({ messageId: 'om_explicit' }, { currentMessageId: 'om_current' } as never)).toBe(
      'om_explicit',
    );
  });
});
