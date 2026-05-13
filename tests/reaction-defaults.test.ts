import { describe, expect, it } from 'vitest';
import { readReactionMessageId } from '../src/messaging/outbound/actions';

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
