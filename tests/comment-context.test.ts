import { describe, expect, it } from 'vitest';
import { inferIsWholeComment } from '../src/messaging/inbound/comment-context';

describe('inferIsWholeComment', () => {
  it('prefers explicit whole flag when present', () => {
    expect(
      inferIsWholeComment({
        explicitIsWhole: true,
        quotedText: 'anchored text',
      }),
    ).toBe(true);

    expect(
      inferIsWholeComment({
        explicitIsWhole: false,
      }),
    ).toBe(false);
  });

  it('treats threads without quoted anchor as whole comments', () => {
    expect(
      inferIsWholeComment({
        quotedText: undefined,
      }),
    ).toBe(true);

    expect(
      inferIsWholeComment({
        quotedText: '   ',
      }),
    ).toBe(true);
  });

  it('treats threads with quoted anchor as anchored comments', () => {
    expect(
      inferIsWholeComment({
        quotedText: '李白，字太白',
      }),
    ).toBe(false);
  });
});
