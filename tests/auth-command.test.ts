import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getTicketMock, getLarkAccountMock, getAppInfoMock, assertOwnerAccessStrictMock } = vi.hoisted(() => ({
  getTicketMock: vi.fn(),
  getLarkAccountMock: vi.fn(),
  getAppInfoMock: vi.fn(),
  assertOwnerAccessStrictMock: vi.fn(),
}));

vi.mock('../src/tools/onboarding-auth', () => ({
  triggerOnboarding: vi.fn(),
}));

vi.mock('../src/core/lark-ticket', () => ({
  getTicket: getTicketMock,
}));

vi.mock('../src/core/accounts', () => ({
  getLarkAccount: getLarkAccountMock,
}));

vi.mock('../src/core/lark-client', () => ({
  LarkClient: {
    fromAccount: vi.fn(() => ({ sdk: {} })),
  },
}));

vi.mock('../src/core/app-scope-checker', () => ({
  getAppGrantedScopes: vi.fn(),
  getAppInfo: getAppInfoMock,
}));

vi.mock('../src/core/token-store', () => ({
  getStoredToken: vi.fn(),
  tokenStatus: vi.fn(),
}));

vi.mock('../src/core/tool-scopes', () => ({
  filterSensitiveScopes: vi.fn((scopes: string[]) => scopes),
}));

vi.mock('../src/core/domains', () => ({
  openPlatformDomain: vi.fn(() => 'https://open.feishu.cn'),
}));

vi.mock('../src/core/owner-policy', () => {
  class MockOwnerAccessDeniedError extends Error {
    readonly userOpenId: string;
    readonly appOwnerId: string;
    readonly reason: 'strict' | 'not_in_allowlist';

    constructor(userOpenId: string, appOwnerId: string, reason: 'strict' | 'not_in_allowlist') {
      super('mock owner denied');
      this.name = 'OwnerAccessDeniedError';
      this.userOpenId = userOpenId;
      this.appOwnerId = appOwnerId;
      this.reason = reason;
    }
  }

  return {
    OwnerAccessDeniedError: MockOwnerAccessDeniedError,
    assertOwnerAccessStrict: assertOwnerAccessStrictMock,
  };
});

import { runFeishuAuthI18n } from '../src/commands/auth';
import { OwnerAccessDeniedError } from '../src/core/owner-policy';

describe('runFeishuAuthI18n owner denial messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    getTicketMock.mockReturnValue({
      senderOpenId: 'ou_user',
      accountId: 'default',
    });

    getLarkAccountMock.mockReturnValue({
      accountId: 'default',
      enabled: true,
      configured: true,
      appId: 'cli_app',
      appSecret: 'secret',
      brand: 'feishu',
      config: {},
    });

    getAppInfoMock.mockResolvedValue({ ok: true });
  });

  it('returns owner-only copy when strict mode denies access', async () => {
    assertOwnerAccessStrictMock.mockRejectedValue(new OwnerAccessDeniedError('ou_user', 'ou_owner', 'strict'));

    const result = await runFeishuAuthI18n({} as never);

    expect(result.zh_cn).toContain('仅限应用 owner 执行');
    expect(result.en_us).toContain('restricted to the app owner');
  });

  it('returns allowlist copy when user is not in uat.allowedUsers', async () => {
    assertOwnerAccessStrictMock.mockRejectedValue(
      new OwnerAccessDeniedError('ou_user', 'ou_owner', 'not_in_allowlist'),
    );

    const result = await runFeishuAuthI18n({} as never);

    expect(result.zh_cn).toContain('授权用户列表');
    expect(result.zh_cn).toContain('uat.allowedUsers');
    expect(result.en_us).toContain('authorized user list');
    expect(result.en_us).toContain('uat.allowedUsers');
  });
});
