/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Regression test: startWS must enable the SDK liveness watchdog by passing
 * `wsConfig.pingTimeout` to the WSClient constructor. Without it the watchdog
 * defaults to 0 (disabled) and a silently half-open long connection (dropped
 * by NAT / TUN / middlebox without RST) is never detected — events stop
 * arriving until the whole gateway process is restarted.
 */

import { describe, expect, it, vi } from 'vitest';

const wsClientCtorParams: Record<string, unknown>[] = [];

vi.mock('@larksuiteoapi/node-sdk', () => {
  class MockWSClient {
    static instances: MockWSClient[] = [];
    handleEventData = vi.fn();
    start = vi.fn().mockResolvedValue(undefined);
    close = vi.fn();
    constructor(params: Record<string, unknown>) {
      wsClientCtorParams.push(params);
      MockWSClient.instances.push(this);
    }
  }
  class MockEventDispatcher {
    register = vi.fn().mockReturnThis();
  }
  return {
    WSClient: MockWSClient,
    EventDispatcher: MockEventDispatcher,
    LoggerLevel: { info: 1 },
    Domain: { Feishu: 'https://open.feishu.cn', Lark: 'https://open.larksuite.com' },
    defaultHttpInstance: {
      defaults: {},
      interceptors: {
        request: { handlers: [], use: vi.fn() },
        response: { handlers: [], use: vi.fn() },
      },
    },
  };
});

vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../src/core/version', () => ({ getUserAgent: () => 'openclaw-lark/test' }));
vi.mock('../src/core/accounts', () => ({ getLarkAccount: vi.fn() }));
vi.mock('../src/core/chat-info-cache', () => ({
  clearChatInfoCache: vi.fn(),
  injectLarkClient: vi.fn(),
}));
vi.mock('../src/core/runtime-store', () => ({
  getLarkRuntime: vi.fn(),
  setLarkRuntime: vi.fn(),
}));
vi.mock('../src/messaging/inbound/user-name-cache-store', () => ({ clearUserNameCache: vi.fn() }));

import { LarkClient } from '../src/core/lark-client';
import type { LarkAccount } from '../src/core/types';

function makeAccount(): LarkAccount {
  return {
    accountId: 'test-account',
    enabled: true,
    appId: 'cli_test',
    appSecret: 'secret',
    brand: 'feishu',
    configured: true,
    config: {},
  } as unknown as LarkAccount;
}

describe('LarkClient.startWS liveness watchdog', () => {
  it('passes wsConfig.pingTimeout to the WSClient constructor', async () => {
    wsClientCtorParams.length = 0;
    const client = LarkClient.fromAccount(makeAccount());

    const controller = new AbortController();
    controller.abort(); // resolve waitForAbort immediately after construction
    await client.startWS({ handlers: {}, abortSignal: controller.signal, autoProbe: false });

    expect(wsClientCtorParams).toHaveLength(1);
    const params = wsClientCtorParams[0];
    expect(params.wsConfig).toBeDefined();
    const pingTimeout = (params.wsConfig as { pingTimeout?: number }).pingTimeout;
    expect(typeof pingTimeout).toBe('number');
    // Server-pushed ping cadence is 120s; the watchdog must exceed it.
    expect(pingTimeout!).toBeGreaterThan(120);
    // …but stay tight enough to self-heal within a few minutes.
    expect(pingTimeout!).toBeLessThanOrEqual(300);
  });
});
