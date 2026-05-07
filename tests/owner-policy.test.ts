import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfiguredLarkAccount } from '../src/core/types';

const { getAppOwnerFallbackMock, warnMock } = vi.hoisted(() => ({
  getAppOwnerFallbackMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock('../src/core/app-owner-fallback', () => ({
  getAppOwnerFallback: getAppOwnerFallbackMock,
}));

vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({
    info: vi.fn(),
    warn: warnMock,
    error: vi.fn(),
  }),
}));

import { OwnerAccessDeniedError, assertOwnerAccessStrict } from '../src/core/owner-policy';

function makeAccount(uat?: { ownerOnly?: boolean; allowedUsers?: string[] }): ConfiguredLarkAccount {
  return {
    accountId: 'default',
    enabled: true,
    configured: true,
    appId: 'cli_app',
    appSecret: 'secret',
    brand: 'feishu',
    config: {
      appId: 'cli_app',
      appSecret: 'secret',
      uat,
    } as ConfiguredLarkAccount['config'],
  };
}

describe('assertOwnerAccessStrict', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects non-owner by default with strict reason', async () => {
    getAppOwnerFallbackMock.mockResolvedValue('ou_owner');

    await expect(assertOwnerAccessStrict(makeAccount(), {} as never, 'ou_user')).rejects.toMatchObject({
      name: 'OwnerAccessDeniedError',
      reason: 'strict',
      userOpenId: 'ou_user',
      appOwnerId: 'ou_owner',
    } satisfies Partial<OwnerAccessDeniedError>);
  });

  it('short-circuits when ownerOnly is false and no allowlist is configured', async () => {
    await expect(
      assertOwnerAccessStrict(makeAccount({ ownerOnly: false }), {} as never, 'ou_any_user'),
    ).resolves.toBeUndefined();

    expect(getAppOwnerFallbackMock).not.toHaveBeenCalled();
  });

  it('allows allowlisted non-owner users when ownerOnly is false', async () => {
    getAppOwnerFallbackMock.mockResolvedValue('ou_owner');

    await expect(
      assertOwnerAccessStrict(
        makeAccount({ ownerOnly: false, allowedUsers: ['ou_allowed'] }),
        {} as never,
        'ou_allowed',
      ),
    ).resolves.toBeUndefined();

    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it('rejects users outside uat.allowedUsers with not_in_allowlist reason', async () => {
    getAppOwnerFallbackMock.mockResolvedValue('ou_owner');

    await expect(
      assertOwnerAccessStrict(
        makeAccount({ ownerOnly: false, allowedUsers: ['ou_allowed'] }),
        {} as never,
        'ou_denied',
      ),
    ).rejects.toMatchObject({
      name: 'OwnerAccessDeniedError',
      reason: 'not_in_allowlist',
      userOpenId: 'ou_denied',
      appOwnerId: 'ou_owner',
    } satisfies Partial<OwnerAccessDeniedError>);
  });

  it('falls back to pure allowlist when owner lookup fails in allowlist mode', async () => {
    getAppOwnerFallbackMock.mockResolvedValue(undefined);

    await expect(
      assertOwnerAccessStrict(
        makeAccount({ ownerOnly: false, allowedUsers: ['ou_allowed'] }),
        {} as never,
        'ou_allowed',
      ),
    ).resolves.toBeUndefined();

    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed when owner lookup fails in strict mode', async () => {
    getAppOwnerFallbackMock.mockResolvedValue(undefined);

    await expect(assertOwnerAccessStrict(makeAccount(), {} as never, 'ou_user')).rejects.toMatchObject({
      name: 'OwnerAccessDeniedError',
      reason: 'strict',
      userOpenId: 'ou_user',
      appOwnerId: 'unknown',
    } satisfies Partial<OwnerAccessDeniedError>);
  });
});
