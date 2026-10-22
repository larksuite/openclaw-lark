import { describe, expect, it } from 'vitest';
import { assertLarkOk, formatLarkError } from '../src/core/api-error';

describe('Lark access-control errors', () => {
  const responseMessage = 'Access denied by access control policy. Contact the administrator for assistance.';

  it('distinguishes code 21001 from invalid app credentials', () => {
    const message = formatLarkError({ code: 21001, msg: responseMessage });

    expect(message).toContain(responseMessage);
    expect(message).toContain('access-control policy');
    expect(message).toContain('does not establish that the app ID or secret is invalid');
    expect(formatLarkError({ code: '21001', msg: responseMessage })).toContain('access-control policy');
  });

  it('uses the same diagnostic for response-level errors', () => {
    expect(() => assertLarkOk({ code: 21001, msg: responseMessage })).toThrow(
      'does not establish that the app ID or secret is invalid',
    );
  });

  it('includes available HTTP status and x-tt-logid metadata', () => {
    const message = formatLarkError({
      response: {
        status: 200,
        headers: { 'x-tt-logid': 'log-id-123' },
        data: { code: 21001, msg: responseMessage },
      },
    });

    expect(message).toContain('HTTP 200');
    expect(message).toContain('x-tt-logid=log-id-123');
  });
});
