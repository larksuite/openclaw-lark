/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadConfigMock = vi.fn<() => ClawdbotConfig>();
const writeConfigFileMock = vi.fn<(cfg: ClawdbotConfig) => Promise<void>>();
const clearCacheMock = vi.fn<(accountId?: string) => Promise<void>>();
const toDataURLMock = vi.fn<(text: string) => Promise<string>>();
const toStringMock = vi.fn<(text: string, options?: unknown) => Promise<string>>();
const feishuFetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>();

vi.mock('openclaw/plugin-sdk/config-runtime', () => ({
  loadConfig: loadConfigMock,
  writeConfigFile: writeConfigFileMock,
}));

vi.mock('qrcode', () => ({
  default: {
    toDataURL: toDataURLMock,
    toString: toStringMock,
  },
}));

vi.mock('../src/core/feishu-fetch', () => ({
  feishuFetch: feishuFetchMock,
}));

vi.mock('../src/core/lark-client', () => ({
  LarkClient: {
    clearCache: clearCacheMock,
  },
}));

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Feishu QR login', () => {
  beforeEach(() => {
    vi.resetModules();
    loadConfigMock.mockReset();
    writeConfigFileMock.mockReset();
    clearCacheMock.mockReset();
    toDataURLMock.mockReset();
    toStringMock.mockReset();
    feishuFetchMock.mockReset();

    loadConfigMock.mockReturnValue({ channels: { feishu: {} } });
    writeConfigFileMock.mockResolvedValue();
    clearCacheMock.mockResolvedValue();
    toDataURLMock.mockResolvedValue('data:image/png;base64,qr');
    toStringMock.mockResolvedValue('qr');
  });

  it('applies onboarding credentials to the default account config', async () => {
    const { applyFeishuOnboardingConfig } = await import('../src/channel/qr-login');

    const next = applyFeishuOnboardingConfig(
      { channels: { feishu: { enabled: false } } },
      'default',
      {
        appId: 'cli_test',
        appSecret: 'secret_test',
        brand: 'lark',
        userOpenId: 'ou_owner',
        hasUserInfo: true,
      },
    );

    expect(next.channels?.feishu).toMatchObject({
      enabled: true,
      appId: 'cli_test',
      appSecret: 'secret_test',
      domain: 'lark',
      dmPolicy: 'allowlist',
      groupPolicy: 'allowlist',
      allowFrom: ['ou_owner'],
      groupAllowFrom: ['ou_owner'],
      groups: { '*': { enabled: true } },
    });
  });

  it('starts a QR session, waits for success, and persists the bot credentials', async () => {
    feishuFetchMock
      .mockResolvedValueOnce(jsonResponse({ supported_auth_methods: ['client_secret'] }))
      .mockResolvedValueOnce(
        jsonResponse({
          device_code: 'dev_123',
          verification_uri_complete: 'https://accounts.feishu.cn/device?ticket=123',
          interval: 0,
          expire_in: 600,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          client_id: 'cli_generated',
          client_secret: 'secret_generated',
          user_info: { open_id: 'ou_owner' },
        }),
      );

    const qrLogin = await import('../src/channel/qr-login');
    const started = await qrLogin.startFeishuQrLogin({ accountId: 'default' });
    const waited = await qrLogin.waitForFeishuQrLogin({ accountId: 'default', timeoutMs: 5 });

    expect(started.qrDataUrl).toBe('data:image/png;base64,qr');
    expect(started.message).toContain('https://accounts.feishu.cn/device?ticket=123&from=onboard');
    expect(waited).toEqual({
      connected: true,
      message: expect.stringContaining('cli_generated'),
    });
    expect(writeConfigFileMock).toHaveBeenCalledTimes(1);
    expect(writeConfigFileMock.mock.calls[0]?.[0]).toMatchObject({
      channels: {
        feishu: {
          appId: 'cli_generated',
          appSecret: 'secret_generated',
          dmPolicy: 'allowlist',
          allowFrom: ['ou_owner'],
        },
      },
    });
    expect(clearCacheMock).toHaveBeenCalledWith('default');
  });

  it('switches polling to the Lark accounts domain when tenant_brand indicates lark', async () => {
    feishuFetchMock
      .mockResolvedValueOnce(jsonResponse({ supported_auth_methods: ['client_secret'] }))
      .mockResolvedValueOnce(
        jsonResponse({
          device_code: 'dev_lark',
          verification_uri_complete: 'https://accounts.feishu.cn/device?ticket=lark',
          interval: 0,
          expire_in: 600,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          error: 'authorization_pending',
          user_info: { tenant_brand: 'lark' },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          client_id: 'cli_lark',
          client_secret: 'secret_lark',
          user_info: { open_id: 'ou_lark_owner', tenant_brand: 'lark' },
        }),
      );

    const qrLogin = await import('../src/channel/qr-login');
    await qrLogin.startFeishuQrLogin({ accountId: 'default' });
    const waited = await qrLogin.waitForFeishuQrLogin({ accountId: 'default', timeoutMs: 10 });

    expect(waited.connected).toBe(true);
    expect(String(feishuFetchMock.mock.calls[2]?.[0])).toContain('https://accounts.feishu.cn');
    expect(String(feishuFetchMock.mock.calls[3]?.[0])).toContain('https://accounts.larksuite.com');
    expect(writeConfigFileMock.mock.calls[0]?.[0]).toMatchObject({
      channels: {
        feishu: {
          domain: 'lark',
          appId: 'cli_lark',
        },
      },
    });
  });

  it('wires the current OpenClaw web login contract through the channel plugin', async () => {
    const qrLogin = await import('../src/channel/qr-login');
    const runCliSpy = vi.spyOn(qrLogin, 'runFeishuQrLoginCli').mockResolvedValue(undefined);
    const startSpy = vi.spyOn(qrLogin, 'startFeishuQrLogin').mockResolvedValue({
      qrDataUrl: 'data:image/png;base64,plugin-qr',
      message: 'plugin start',
    });
    const waitSpy = vi.spyOn(qrLogin, 'waitForFeishuQrLogin').mockResolvedValue({
      connected: true,
      message: 'plugin wait',
    });

    const { feishuPlugin } = await import('../src/channel/plugin');
    const runtime = { log: vi.fn() };

    expect(feishuPlugin.meta.aliases).toContain('openclaw-lark');
    expect(feishuPlugin.gatewayMethods).toEqual(['web.login.start', 'web.login.wait']);

    await feishuPlugin.auth?.login?.({
      cfg: { channels: { feishu: {} } } as unknown as ClawdbotConfig,
      accountId: 'default',
      runtime: runtime as never,
      channelInput: 'feishu',
    });
    expect(runCliSpy).toHaveBeenCalledWith({
      accountId: 'default',
      runtime,
    });

    const started = await feishuPlugin.gateway?.loginWithQrStart?.({
      accountId: 'default',
      force: true,
    });
    expect(started).toEqual({
      qrDataUrl: 'data:image/png;base64,plugin-qr',
      message: 'plugin start',
    });
    expect(startSpy).toHaveBeenCalledWith({
      accountId: 'default',
      force: true,
    });

    const waited = await feishuPlugin.gateway?.loginWithQrWait?.({
      accountId: 'default',
      timeoutMs: 1234,
    });
    expect(waited).toEqual({
      connected: true,
      message: 'plugin wait',
    });
    expect(waitSpy).toHaveBeenCalledWith({
      accountId: 'default',
      timeoutMs: 1234,
    });
  });
});
