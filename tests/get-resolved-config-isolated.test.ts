/**
 * Tests for getResolvedConfig behaviour in isolated session contexts.
 *
 * Regression test for: [Bug] Cron jobs in isolated session fail with
 * "appId and appSecret are required"
 *
 * Root cause: LarkClient.runtime.config.loadConfig() returns an empty config
 * (no channels.feishu) in isolated sessions.  getResolvedConfig must fall
 * back to LarkClient.globalConfig so tools can still resolve credentials.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LarkClient, getResolvedConfig } from '../src/core/lark-client';
import type { ClawdbotConfig } from 'openclaw/plugin-sdk';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(appId: string): ClawdbotConfig {
  return {
    channels: {
      feishu: { appId, appSecret: 'secret-' + appId },
    },
  } as unknown as ClawdbotConfig;
}

const EMPTY_CONFIG = {} as ClawdbotConfig;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getResolvedConfig — isolated session fallback', () => {
  afterEach(() => {
    // Reset globalConfig after each test.
    LarkClient.setGlobalConfig(null as unknown as ClawdbotConfig);
    vi.restoreAllMocks();
  });

  it('returns live config when channels.feishu is present', () => {
    const liveConfig = makeConfig('app-live');
    const fallback = makeConfig('app-fallback');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(LarkClient, 'runtime', 'get').mockReturnValue({
      config: { loadConfig: () => liveConfig },
    } as unknown as any);

    expect(getResolvedConfig(fallback)).toBe(liveConfig);
  });

  it('falls back to globalConfig when loadConfig returns empty (isolated session)', () => {
    const globalConfig = makeConfig('app-global');
    const fallback = makeConfig('app-fallback');

    LarkClient.setGlobalConfig(globalConfig);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(LarkClient, 'runtime', 'get').mockReturnValue({
      config: { loadConfig: () => EMPTY_CONFIG },
    } as unknown as any);

    expect(getResolvedConfig(fallback)).toBe(globalConfig);
  });

  it('falls back to fallback param when both loadConfig and globalConfig are empty', () => {
    const fallback = makeConfig('app-fallback');

    LarkClient.setGlobalConfig(null as unknown as ClawdbotConfig);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(LarkClient, 'runtime', 'get').mockReturnValue({
      config: { loadConfig: () => EMPTY_CONFIG },
    } as unknown as any);

    expect(getResolvedConfig(fallback)).toBe(fallback);
  });

  it('falls back to fallback param when runtime throws (pre-init)', () => {
    const fallback = makeConfig('app-fallback');

    vi.spyOn(LarkClient, 'runtime', 'get').mockImplementation((): any => {
      throw new Error('runtime not initialised');
    });

    expect(getResolvedConfig(fallback)).toBe(fallback);
  });
});
