import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientAssertionProvider } from '../src/core/client-assertion-provider';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  getStoredToken: vi.fn(),
  removeStoredToken: vi.fn(),
  setStoredToken: vi.fn(),
  tokenStatus: vi.fn(),
}));

vi.mock('../src/core/feishu-fetch', () => ({ feishuFetch: mocks.fetch }));
vi.mock('../src/core/token-store', () => ({
  getStoredToken: mocks.getStoredToken,
  maskToken: () => '***',
  removeStoredToken: mocks.removeStoredToken,
  setStoredToken: mocks.setStoredToken,
  tokenStatus: mocks.tokenStatus,
}));

import { getValidAccessToken } from '../src/core/uat-client';

describe('keyless UAT refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStoredToken.mockResolvedValue({
      userOpenId: 'ou_user',
      appId: 'cli_keyless',
      accessToken: 'expired-access',
      refreshToken: 'refresh-redacted',
      expiresAt: Date.now() - 1,
      refreshExpiresAt: Date.now() + 60_000,
      scope: 'docs:document',
      grantedAt: Date.now() - 10_000,
    });
    mocks.tokenStatus.mockReturnValue('needs_refresh');
    mocks.fetch.mockResolvedValue({
      json: async () => ({
        code: 0,
        access_token: 'new-access-redacted',
        refresh_token: 'new-refresh-redacted',
        expires_in: 7200,
        refresh_token_expires_in: 604800,
        scope: 'docs:document',
      }),
    });
  });

  it('authenticates refresh with private_key_jwt and never sends client_secret', async () => {
    const retrieveToken = vi.fn(async (aud: string) => ({ value: `jwt:${aud}` }));
    const clientAssertionProvider: ClientAssertionProvider = { retrieveToken };

    await expect(
      getValidAccessToken({
        userOpenId: 'ou_user',
        appId: 'cli_keyless',
        clientAssertionProvider,
        domain: 'feishu',
      }),
    ).resolves.toBe('new-access-redacted');

    expect(retrieveToken).toHaveBeenCalledWith('open.feishu.cn');
    const [, init] = mocks.fetch.mock.calls[0]! as [string, RequestInit];
    const body = new URLSearchParams(String(init.body));
    expect(body.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    expect(body.get('client_assertion')).toBe('jwt:open.feishu.cn');
    expect(body.has('client_secret')).toBe(false);
    expect(mocks.setStoredToken).toHaveBeenCalledOnce();
  });

  it('keeps client_secret refresh authentication for secret accounts', async () => {
    await expect(
      getValidAccessToken({
        userOpenId: 'ou_user',
        appId: 'cli_secret',
        appSecret: 'secret-redacted',
        domain: 'feishu',
      }),
    ).resolves.toBe('new-access-redacted');

    const [, init] = mocks.fetch.mock.calls[0]! as [string, RequestInit];
    const body = new URLSearchParams(String(init.body));
    expect(body.get('client_secret')).toBe('secret-redacted');
    expect(body.has('client_assertion')).toBe(false);
  });
});
