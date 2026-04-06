import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeishuAccountConfig } from '../../src/core/types';

const mockAccount: {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  appId: string;
  appSecret: string;
  brand: string;
  config: FeishuAccountConfig;
} = {
  accountId: 'default',
  enabled: true,
  configured: true,
  appId: 'cli_xxx',
  appSecret: 'secret_xxx',
  brand: 'feishu',
  config: {
    allowFrom: undefined,
    connectionMode: 'websocket',
    dedup: {
      ttlMs: 5000,
      maxEntries: 100,
    },
    groupAllowFrom: undefined,
  },
};

let currentConfig: Record<string, unknown> = {};

const mockDisconnect = vi.fn();
const mockStartWS = vi.fn();
const mockDrainShutdownHooks = vi.fn().mockResolvedValue(undefined);
const mockSetGlobalConfig = vi.fn();

vi.mock('../../src/core/accounts', () => ({
  getEnabledLarkAccounts: vi.fn(() => [mockAccount]),
  getLarkAccount: vi.fn(() => mockAccount),
}));

vi.mock('../../src/core/lark-client', () => ({
  LarkClient: {
    runtime: {
      config: {
        loadConfig: () => currentConfig,
      },
    },
    setGlobalConfig: (...args: unknown[]) => mockSetGlobalConfig(...args),
    fromAccount: () => ({
      messageDedup: null,
      botOpenId: 'ou_bot',
      disconnect: (...args: unknown[]) => mockDisconnect(...args),
      startWS: (...args: unknown[]) => mockStartWS(...args),
    }),
  },
}));

vi.mock('../../src/messaging/inbound/dedup', () => ({
  MessageDedup: class {
    ttlMs = mockAccount.config.dedup?.ttlMs ?? 5000;
    maxEntries = mockAccount.config.dedup?.maxEntries ?? 100;
    size = 0;

    tryRecord() {
      return true;
    }

    dispose() {}
  },
}));

vi.mock('../../src/core/lark-logger', () => ({
  larkLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../src/core/shutdown-hooks', () => ({
  drainShutdownHooks: (...args: unknown[]) => mockDrainShutdownHooks(...args),
}));

vi.mock('../../src/channel/event-handlers', () => ({
  handleBotMembershipEvent: vi.fn(),
  handleCardActionEvent: vi.fn(),
  handleMessageEvent: vi.fn(),
  handleReactionEvent: vi.fn(),
}));

import { monitorFeishuProvider } from '../../src/channel/monitor';

describe('monitorFeishuProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    currentConfig = {};
    mockAccount.config = {
      allowFrom: undefined,
      connectionMode: 'websocket',
      dedup: { ttlMs: 5000, maxEntries: 100 },
      groupAllowFrom: undefined,
    } as FeishuAccountConfig;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the account disconnected until the socket reports ready', async () => {
    const patches: Array<Record<string, unknown>> = [];
    const abortController = new AbortController();

    mockStartWS.mockImplementationOnce(async (opts: { abortSignal?: AbortSignal; lifecycle?: Record<string, () => void> }) => {
      opts.lifecycle?.onConnectAttempt?.();
      opts.lifecycle?.onReady?.();

      await new Promise<void>((resolve) => {
        opts.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    const monitorPromise = monitorFeishuProvider({
      config: currentConfig as never,
      accountId: 'default',
      abortSignal: abortController.signal,
      setStatus: (patch) => {
        patches.push(patch);
      },
    });

    await vi.waitFor(() => {
      expect(patches.some((patch) => patch.state === 'ready' && patch.connected === true)).toBe(true);
    });

    abortController.abort();
    await monitorPromise;

    expect(patches[0]).toMatchObject({
      connected: false,
      state: 'starting',
    });
    expect(patches.some((patch) => patch.state === 'connecting' && patch.connected === false)).toBe(true);
    expect(patches.some((patch) => patch.state === 'ready' && patch.connected === true)).toBe(true);
  });

  it('marks startup timeouts as failed and schedules a restart', async () => {
    vi.useFakeTimers();
    const patches: Array<Record<string, unknown>> = [];
    const abortController = new AbortController();

    mockAccount.config = {
      allowFrom: undefined,
      connectionMode: 'websocket',
      dedup: { ttlMs: 5000, maxEntries: 100 },
      groupAllowFrom: undefined,
      healthMonitor: {
        startupTimeoutMs: 50,
        initialRestartBackoffMs: 1000,
        maxRestartBackoffMs: 2000,
      },
    } as FeishuAccountConfig;

    mockStartWS.mockImplementation(async (opts: { abortSignal?: AbortSignal; lifecycle?: Record<string, () => void> }) => {
      opts.lifecycle?.onConnectAttempt?.();

      await new Promise<void>((resolve) => {
        opts.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    const monitorPromise = monitorFeishuProvider({
      config: currentConfig as never,
      accountId: 'default',
      abortSignal: abortController.signal,
      setStatus: (patch) => {
        patches.push(patch);
      },
    });

    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => {
      expect(
        patches.some((patch) => patch.state === 'failed' && patch.lastErrorReason === 'startup_timeout'),
      ).toBe(true);
    });
    await vi.waitFor(() => {
      expect(
        patches.some((patch) => patch.state === 'restarting' && patch.lastRestartReason === 'startup_timeout'),
      ).toBe(true);
    });

    abortController.abort();
    await monitorPromise;

    expect(mockDisconnect).toHaveBeenCalled();
  });
});
