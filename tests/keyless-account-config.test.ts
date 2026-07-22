import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import { probeFeishu } from '../src/channel/probe';
import { getLarkAccount, isConfigured } from '../src/core/accounts';
import { LarkClient } from '../src/core/lark-client';

function makeCfg(feishu: Record<string, unknown>): ClawdbotConfig {
  return { channels: { feishu } } as unknown as ClawdbotConfig;
}

// ---------------------------------------------------------------------------
// "configured" gate: keyless accounts count as configured; a bare appId does not
// ---------------------------------------------------------------------------

describe('getLarkAccount – keyless "configured" gate', () => {
  it('treats appId + authMethod=private_key_jwt + keyRef (no secret) as configured', () => {
    const cfg = makeCfg({
      accounts: {
        kl: { appId: 'cli_keyless', authMethod: 'private_key_jwt', keyRef: 'openclaw-lark' },
      },
    });

    const account = getLarkAccount(cfg, 'kl');
    expect(account.configured).toBe(true);
    expect(account.enabled).toBe(true);
    expect(account.appId).toBe('cli_keyless');
    // Keyless accounts carry a keyRef and no appSecret.
    if (isConfigured(account)) {
      expect(account.authMethod).toBe('private_key_jwt');
      expect(account.keyRef).toBe('openclaw-lark');
      expect(account.appSecret).toBeUndefined();
    }
  });

  it('does NOT treat a bare appId (no secret, not keyless) as configured', () => {
    const cfg = makeCfg({ accounts: { bare: { appId: 'cli_bare' } } });
    const account = getLarkAccount(cfg, 'bare');
    expect(account.configured).toBe(false);
  });

  it('does NOT treat private_key_jwt without a keyRef as configured', () => {
    const cfg = makeCfg({ accounts: { nokr: { appId: 'cli_x', authMethod: 'private_key_jwt' } } });
    const account = getLarkAccount(cfg, 'nokr');
    expect(account.configured).toBe(false);
  });

  it('keeps the app-secret account configured and unchanged (appSecret present, keyRef absent)', () => {
    const cfg = makeCfg({ accounts: { s: { appId: 'cli_s', appSecret: 'sec' } } });
    const account = getLarkAccount(cfg, 's');
    expect(account.configured).toBe(true);
    if (isConfigured(account)) {
      expect(account.appSecret).toBe('sec');
      expect(account.keyRef).toBeUndefined();
    }
  });

  it('prefers the app-secret variant when both appSecret and keyRef are present', () => {
    const cfg = makeCfg({
      accounts: {
        both: { appId: 'cli_b', appSecret: 'sec', authMethod: 'private_key_jwt', keyRef: 'openclaw-lark' },
      },
    });
    const account = getLarkAccount(cfg, 'both');
    expect(account.configured).toBe(true);
    if (isConfigured(account)) {
      expect(account.appSecret).toBe('sec');
    }
  });
});

// ---------------------------------------------------------------------------
// Runtime: keyless injects a provider into both HTTP and WebSocket clients
// ---------------------------------------------------------------------------

describe('LarkClient – keyless runtime seam', () => {
  afterEach(async () => {
    await LarkClient.clearCache();
  });

  it('constructs and caches an HTTP SDK client without an appSecret', () => {
    const cfg = makeCfg({
      accounts: { kl: { appId: 'cli_keyless', authMethod: 'private_key_jwt', keyRef: 'openclaw-lark' } },
    });
    const client = LarkClient.fromCfg(cfg, 'kl');

    const sdk = client.sdk;
    expect(sdk).toBeTruthy();
    expect(client.sdk).toBe(sdk);
  });

  it('probe reaches the SDK request path for a keyless account', async () => {
    const cfg = makeCfg({
      accounts: { kl2: { appId: 'cli_keyless2', authMethod: 'private_key_jwt', keyRef: 'openclaw-lark' } },
    });
    const client = LarkClient.fromCfg(cfg, 'kl2');
    const request = vi.spyOn(client.sdk, 'request').mockResolvedValue({
      code: 0,
      data: { pingBotInfo: { botID: 'ou_keyless', botName: 'Keyless Bot' } },
    });
    const res = await client.probe();
    expect(request).toHaveBeenCalledOnce();
    expect(res.ok).toBe(true);
    expect(res.appId).toBe('cli_keyless2');
    expect(res.botOpenId).toBe('ou_keyless');
  });

  it('constructs a WebSocket client without an appSecret', async () => {
    const cfg = makeCfg({
      accounts: { kl3: { appId: 'cli_keyless3', authMethod: 'private_key_jwt', keyRef: 'openclaw-lark' } },
    });
    const client = LarkClient.fromCfg(cfg, 'kl3');
    const controller = new AbortController();
    controller.abort();

    await client.startWS({ handlers: {}, autoProbe: false, abortSignal: controller.signal });
    expect(client.wsConnected).toBe(false);
  });

  it('secret account still constructs the SDK client unchanged', () => {
    const cfg = makeCfg({ accounts: { s: { appId: 'cli_s', appSecret: 'sec' } } });
    const client = LarkClient.fromCfg(cfg, 's');
    const sdk = client.sdk;
    expect(sdk).toBeTruthy();
    // A second access returns the same lazily-cached instance.
    expect(client.sdk).toBe(sdk);
  });
});

describe('probeFeishu – keyless credentials', () => {
  it('accepts keyless credentials without requiring an appSecret', async () => {
    const probe = vi.fn().mockResolvedValue({ ok: true, appId: 'cli_keyless' });
    const factory = vi.spyOn(LarkClient, 'fromCredentials').mockReturnValue({ probe } as unknown as LarkClient);

    try {
      await expect(
        probeFeishu({
          appId: 'cli_keyless',
          authMethod: 'private_key_jwt',
          keyRef: 'openclaw-lark',
        }),
      ).resolves.toMatchObject({ ok: true, appId: 'cli_keyless' });
      expect(factory).toHaveBeenCalledOnce();
      expect(probe).toHaveBeenCalledOnce();
    } finally {
      factory.mockRestore();
    }
  });
});
