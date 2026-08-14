/**
 * WSClient liveness watchdog (issue #543).
 *
 * Regression test: the WSClient must be created with `wsConfig.pingTimeout`
 * so the SDK's liveness watchdog is enabled — without it, a half-open
 * connection after machine sleep/wake is never detected and the Feishu
 * channel stays disconnected until restart.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

let wsConstructorOpts: any = null;

vi.mock('@larksuiteoapi/node-sdk', () => ({
  WSClient: class MockWSClient {
    constructor(opts: any) {
      wsConstructorOpts = opts;
    }
    handleEventData() {}
    close() {}
    start() {
      return Promise.resolve();
    }
  },
  EventDispatcher: class MockDispatcher {
    register() {}
  },
  LoggerLevel: { info: 3 },
  Domain: { Feishu: 'feishu', Lark: 'lark' },
  defaultHttpInstance: {
    defaults: {},
    interceptors: { request: { handlers: [], use: () => {} } },
  },
}));

import { LarkClient } from '../../src/core/lark-client';

afterEach(() => {
  wsConstructorOpts = null;
  vi.clearAllMocks();
});

describe('WSClient pingTimeout (#543)', () => {
  it('passes wsConfig.pingTimeout to the SDK WSClient', async () => {
    const client = LarkClient.fromCredentials({
      appId: 'cli_0000000000000001',
      appSecret: 'secret',
      brand: 'feishu',
    });
    const ac = new AbortController();
    ac.abort();

    await client.startWS({ handlers: {}, abortSignal: ac.signal, autoProbe: false });

    expect(wsConstructorOpts).toBeTruthy();
    expect(wsConstructorOpts.wsConfig).toEqual({ pingTimeout: 60 });
  });
});
