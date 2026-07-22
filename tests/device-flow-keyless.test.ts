import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientAssertionProvider } from '../src/core/client-assertion-provider';
import { pollDeviceToken, requestDeviceAuthorization } from '../src/core/device-flow';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('OAuth device flow client authentication', () => {
  it('uses a keyless client assertion for device authorization', async () => {
    const retrieveToken = vi.fn(async (aud: string) => ({ value: `jwt:${aud}` }));
    const provider: ClientAssertionProvider = { retrieveToken };
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            device_code: 'device-1',
            user_code: 'user-1',
            verification_uri: 'https://example.test/verify',
            expires_in: 240,
            interval: 5,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await requestDeviceAuthorization({
      appId: 'cli_keyless',
      clientAssertionProvider: provider,
      brand: 'feishu',
      scope: 'docs:document',
    });

    expect(retrieveToken).toHaveBeenCalledWith('open.feishu.cn');
    const [, init] = fetchMock.mock.calls[0]!;
    const body = new URLSearchParams(String(init?.body));
    expect(body.get('client_id')).toBe('cli_keyless');
    expect(body.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    expect(body.get('client_assertion')).toBe('jwt:open.feishu.cn');
    expect(body.has('client_secret')).toBe(false);
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
  });

  it('does not log live device or user authorization codes', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              device_code: 'device-code-must-not-be-logged',
              user_code: 'user-code-must-not-be-logged',
              verification_uri: 'https://example.test/verify',
              verification_uri_complete: 'https://example.test/verify?user_code=must-not-be-logged',
              expires_in: 240,
              interval: 5,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );

    await requestDeviceAuthorization({
      appId: 'cli_keyless',
      clientAssertionProvider: { retrieveToken: async () => ({ value: 'assertion-must-not-be-logged' }) },
      brand: 'feishu',
    });

    const logs = consoleLog.mock.calls.flat().map(String).join('\n');
    expect(logs).not.toContain('device-code-must-not-be-logged');
    expect(logs).not.toContain('user-code-must-not-be-logged');
    expect(logs).not.toContain('assertion-must-not-be-logged');
  });

  it('mints a fresh keyless assertion for the token endpoint while polling', async () => {
    const retrieveToken = vi.fn(async (aud: string) => ({ value: `jwt:${aud}` }));
    const provider: ClientAssertionProvider = { retrieveToken };
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            access_token: 'uat-redacted',
            refresh_token: 'refresh-redacted',
            expires_in: 7200,
            refresh_token_expires_in: 604800,
            scope: 'docs:document',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await pollDeviceToken({
      appId: 'cli_keyless',
      clientAssertionProvider: provider,
      brand: 'feishu',
      deviceCode: 'device-1',
      interval: 0,
      expiresIn: 10,
    });

    expect(result.ok).toBe(true);
    expect(retrieveToken).toHaveBeenCalledWith('open.feishu.cn');
    const [, init] = fetchMock.mock.calls[0]!;
    const body = new URLSearchParams(String(init?.body));
    expect(body.get('client_assertion')).toBe('jwt:open.feishu.cn');
    expect(body.has('client_secret')).toBe(false);
  });

  it('keeps HTTP Basic authentication for app-secret accounts', async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            device_code: 'device-1',
            user_code: 'user-1',
            verification_uri: 'https://example.test/verify',
            expires_in: 240,
            interval: 5,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await requestDeviceAuthorization({
      appId: 'cli_secret',
      appSecret: 'secret-redacted',
      brand: 'feishu',
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(new Headers(init?.headers).get('Authorization')).toMatch(/^Basic /);
    const body = new URLSearchParams(String(init?.body));
    expect(body.has('client_assertion')).toBe(false);
  });
});
