import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Lark from '@larksuiteoapi/node-sdk';

const { infoMock, warnMock } = vi.hoisted(() => ({
  infoMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ debug: vi.fn(), info: infoMock, warn: warnMock, error: vi.fn() }),
}));

import { getAppGrantedScopes, invalidateAppScopeCache } from '../src/core/app-scope-checker';
import { AppScopeCheckFailedError } from '../src/core/auth-errors';

const appId = 'cli_test_access_control_denied';
const denialMessage = 'Access denied by access control policy. Contact the administrator for assistance.';

function sdkWithRequest(request: ReturnType<typeof vi.fn>): Lark.Client {
  return { request } as unknown as Lark.Client;
}

describe('getAppGrantedScopes access-control failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateAppScopeCache(appId);
  });

  afterEach(() => {
    invalidateAppScopeCache(appId);
  });

  it('caches code 21001 as an empty scope result and warns once per cache window', async () => {
    const request = vi.fn().mockResolvedValue({ code: 21001, msg: denialMessage });
    const sdk = sdkWithRequest(request);

    await expect(getAppGrantedScopes(sdk, appId)).resolves.toEqual([]);
    await expect(getAppGrantedScopes(sdk, appId)).resolves.toEqual([]);

    expect(request).toHaveBeenCalledTimes(1);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0][0]).toContain('access-control policy');
  });

  it('recognizes SDK-thrown code 21001 and allows immediate recheck after invalidation', async () => {
    const denial = Object.assign(new Error(denialMessage), { code: 21001, msg: denialMessage });
    const request = vi
      .fn()
      .mockRejectedValueOnce(denial)
      .mockResolvedValueOnce({ code: 0, data: { app: { scopes: [{ scope: 'im:message' }] } } });
    const sdk = sdkWithRequest(request);

    await expect(getAppGrantedScopes(sdk, appId)).resolves.toEqual([]);
    await expect(getAppGrantedScopes(sdk, appId)).resolves.toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);

    invalidateAppScopeCache(appId);
    await expect(getAppGrantedScopes(sdk, appId)).resolves.toEqual(['im:message']);
    expect(request).toHaveBeenCalledTimes(2);
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it('keeps existing application-scope guidance for other non-zero response codes', async () => {
    const sdk = sdkWithRequest(vi.fn().mockResolvedValue({ code: 99991672, msg: 'scope missing' }));

    await expect(getAppGrantedScopes(sdk, appId)).rejects.toBeInstanceOf(AppScopeCheckFailedError);
    expect(warnMock).not.toHaveBeenCalled();
  });
});
