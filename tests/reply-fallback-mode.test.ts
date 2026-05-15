/**
 * Tests for replyFallbackOnWithdrawn account-scoped config resolution.
 */

import { describe, expect, it } from 'vitest';
import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import { getLarkAccount } from '../src/core/accounts';
import { getReplyFallbackMode } from '../src/messaging/outbound/send';

function makeCfg(feishu: Record<string, unknown>): ClawdbotConfig {
  return { channels: { feishu } } as unknown as ClawdbotConfig;
}

describe('getReplyFallbackMode – account-scoped resolution', () => {
  it('defaults to silent when no config is set', () => {
    const cfg = makeCfg({
      appId: 'a',
      appSecret: 'sa',
    });
    expect(getReplyFallbackMode(cfg)).toBe('silent');
    expect(getReplyFallbackMode(cfg, 'main')).toBe('silent');
  });

  it('reads top-level replyFallbackOnWithdrawn', () => {
    const cfg = makeCfg({
      appId: 'a',
      appSecret: 'sa',
      replyFallbackOnWithdrawn: 'top-level',
    });
    expect(getReplyFallbackMode(cfg)).toBe('top-level');
  });

  it('account override takes precedence over top-level', () => {
    const cfg = makeCfg({
      appId: 'a',
      appSecret: 'sa',
      replyFallbackOnWithdrawn: 'silent',
      accounts: {
        'bot-b': { appId: 'b', appSecret: 'sb', replyFallbackOnWithdrawn: 'top-level' },
      },
    });
    // Top-level is 'silent'
    expect(getReplyFallbackMode(cfg)).toBe('silent');
    // Account 'bot-b' overrides to 'top-level'
    expect(getReplyFallbackMode(cfg, 'bot-b')).toBe('top-level');
  });

  it('account inherits top-level value when no override is set', () => {
    const cfg = makeCfg({
      appId: 'a',
      appSecret: 'sa',
      replyFallbackOnWithdrawn: 'top-level',
      accounts: {
        'bot-b': { appId: 'b', appSecret: 'sb' },
      },
    });
    expect(getReplyFallbackMode(cfg, 'bot-b')).toBe('top-level');
  });

  it('defaults to silent when account exists but has no override and no top-level value', () => {
    const cfg = makeCfg({
      appId: 'a',
      appSecret: 'sa',
      accounts: {
        'bot-b': { appId: 'b', appSecret: 'sb' },
      },
    });
    expect(getReplyFallbackMode(cfg, 'bot-b')).toBe('silent');
  });
});
