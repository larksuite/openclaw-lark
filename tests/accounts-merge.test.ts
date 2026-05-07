/**
 * Tests for multi-account config merging, particularly footer inheritance.
 */

import { describe, expect, it } from 'vitest';
import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import { getLarkAccount, getLarkAccountIds } from '../src/core/accounts';

function makeCfg(feishu: Record<string, unknown>): ClawdbotConfig {
  return { channels: { feishu } } as unknown as ClawdbotConfig;
}

describe('getLarkAccount – footer inheritance', () => {
  const baseFooter = {
    status: true,
    elapsed: true,
    tokens: true,
    cache: true,
    context: true,
    model: true,
  };

  it('named accounts inherit top-level footer when they define no footer', () => {
    const cfg = makeCfg({
      appId: 'default',
      appSecret: 'secret',
      footer: baseFooter,
      accounts: {
        'bot-b': { appId: 'b', appSecret: 'sb' },
      },
    });

    const account = getLarkAccount(cfg, 'bot-b');
    expect(account.config.footer).toEqual(baseFooter);
  });

  it('named account partial footer is deep-merged with top-level footer', () => {
    const cfg = makeCfg({
      appId: 'default',
      appSecret: 'secret',
      footer: baseFooter,
      accounts: {
        'bot-b': { appId: 'b', appSecret: 'sb', footer: { model: false } },
      },
    });

    const account = getLarkAccount(cfg, 'bot-b');
    expect(account.config.footer).toEqual({
      status: true,
      elapsed: true,
      tokens: true,
      cache: true,
      context: true,
      model: false,
    });
  });

  it('default account preserves top-level footer when accounts map exists', () => {
    const cfg = makeCfg({
      appId: 'default',
      appSecret: 'secret',
      footer: baseFooter,
      accounts: {
        'bot-b': { appId: 'b', appSecret: 'sb' },
      },
    });

    const account = getLarkAccount(cfg, undefined);
    expect(account.config.footer).toEqual(baseFooter);
  });

  it('all enabled accounts get the footer when defined at top level only', () => {
    const cfg = makeCfg({
      footer: baseFooter,
      accounts: {
        'bot-a': { appId: 'a', appSecret: 'sa' },
        'bot-b': { appId: 'b', appSecret: 'sb' },
        'bot-c': { appId: 'c', appSecret: 'sc' },
      },
    });

    for (const id of ['bot-a', 'bot-b', 'bot-c']) {
      const account = getLarkAccount(cfg, id);
      expect(account.config.footer).toEqual(baseFooter);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests matching the user's real multi-account config structure
// ---------------------------------------------------------------------------

describe('getLarkAccount – real multi-account config (default + 8 named accounts)', () => {
  const baseFooter = {
    status: true,
    elapsed: true,
    tokens: true,
    cache: true,
    context: true,
    model: true,
  };

  /** Config matching the actual production layout: top-level credentials +
   *  `"default": {}` placeholder + multiple named accounts with only
   *  appId / appSecret / dmPolicy / allowFrom overrides. */
  const cfg = makeCfg({
    appId: 'cli_top_level',
    appSecret: 'top_secret',
    footer: baseFooter,
    streaming: true,
    replyMode: 'streaming',
    accounts: {
      default: {},
      hr: { appId: 'cli_hr', appSecret: 's_hr', dmPolicy: 'open', allowFrom: ['*'] },
      codex: { appId: 'cli_codex', appSecret: 's_codex', dmPolicy: 'open', allowFrom: ['*'] },
      writer: { appId: 'cli_writer', appSecret: 's_writer', dmPolicy: 'open', allowFrom: ['*'] },
      pmo: { appId: 'cli_pmo', appSecret: 's_pmo', dmPolicy: 'open', allowFrom: ['*'] },
      'ai-researcher': { appId: 'cli_air', appSecret: 's_air', dmPolicy: 'open', allowFrom: ['*'] },
      'biz-ops': { appId: 'cli_biz', appSecret: 's_biz', dmPolicy: 'open', allowFrom: ['*'] },
      sre: { appId: 'cli_sre', appSecret: 's_sre', dmPolicy: 'open', allowFrom: ['*'] },
      qa: { appId: 'cli_qa', appSecret: 's_qa', dmPolicy: 'open', allowFrom: ['*'] },
    },
  });

  const namedAccountIds = ['hr', 'codex', 'writer', 'pmo', 'ai-researcher', 'biz-ops', 'sre', 'qa'];

  it('getLarkAccountIds returns all accounts including default', () => {
    const ids = getLarkAccountIds(cfg);
    expect(ids).toContain('default');
    for (const id of namedAccountIds) {
      expect(ids).toContain(id);
    }
  });

  it('default account (with empty override) inherits footer from top level', () => {
    const account = getLarkAccount(cfg, 'default');
    expect(account.config.footer).toEqual(baseFooter);
    // default account should use top-level credentials
    expect(account.config.appId).toBe('cli_top_level');
  });

  it('every named account inherits footer from top level', () => {
    for (const id of namedAccountIds) {
      const account = getLarkAccount(cfg, id);
      expect(account.config.footer).toEqual(baseFooter);
    }
  });

  it('named accounts use their own appId, not the top-level one', () => {
    const hr = getLarkAccount(cfg, 'hr');
    expect(hr.config.appId).toBe('cli_hr');

    const codex = getLarkAccount(cfg, 'codex');
    expect(codex.config.appId).toBe('cli_codex');
  });

  it('named accounts inherit streaming/replyMode from top level', () => {
    for (const id of namedAccountIds) {
      const account = getLarkAccount(cfg, id);
      expect(account.config.streaming).toBe(true);
      expect(account.config.replyMode).toBe('streaming');
    }
  });
});

// ---------------------------------------------------------------------------
// Deep merge for nested config objects
// ---------------------------------------------------------------------------

describe('mergeAccountConfig – deep merge for nested objects', () => {
  it('account partial tools override merges with top-level tools', () => {
    const cfg = makeCfg({
      appId: 'base',
      appSecret: 'secret',
      tools: { doc: true, wiki: true, drive: true },
      accounts: {
        a: { appId: 'a', appSecret: 'sa', tools: { wiki: false } },
      },
    });

    const account = getLarkAccount(cfg, 'a');
    expect(account.config.tools).toEqual({ doc: true, wiki: false, drive: true });
  });

  it('account array fields (allowFrom) replace rather than merge', () => {
    const cfg = makeCfg({
      appId: 'base',
      appSecret: 'secret',
      allowFrom: ['user-a', 'user-b'],
      accounts: {
        a: { appId: 'a', appSecret: 'sa', allowFrom: ['*'] },
      },
    });

    const account = getLarkAccount(cfg, 'a');
    // Arrays should be replaced, not merged
    expect(account.config.allowFrom).toEqual(['*']);
  });

  it('nested uat.allowedUsers arrays replace rather than merge', () => {
    const cfg = makeCfg({
      appId: 'base',
      appSecret: 'secret',
      uat: { ownerOnly: false, allowedUsers: ['ou_base_a', 'ou_base_b'] },
      accounts: {
        a: {
          appId: 'a',
          appSecret: 'sa',
          uat: { allowedUsers: ['ou_account_only'] },
        },
      },
    });

    const account = getLarkAccount(cfg, 'a');
    expect(account.config.uat).toEqual({
      ownerOnly: false,
      allowedUsers: ['ou_account_only'],
    });
  });

  it('scalar fields override correctly', () => {
    const cfg = makeCfg({
      appId: 'base',
      appSecret: 'secret',
      dmPolicy: 'pairing',
      historyLimit: 10,
      accounts: {
        a: { appId: 'a', appSecret: 'sa', dmPolicy: 'open', allowFrom: ['*'] },
      },
    });

    const account = getLarkAccount(cfg, 'a');
    expect(account.config.dmPolicy).toBe('open');
    expect(account.config.historyLimit).toBe(10); // inherited
  });
});
