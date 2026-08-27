/**
 * Tests for the Feishu channel secret-contract registration: structural
 * shape of `secretTargetRegistryEntries` and assignment collection across
 * top-level, account-scoped, plaintext, and connection-mode variants.
 */

import { describe, expect, it } from 'vitest';
import type { OpenClawConfig } from '../src/types/plugin-sdk-types';
import type { ResolverContext } from 'openclaw/plugin-sdk/channel-secret-basic-runtime';

import {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
} from '../secret-contract-api.ts';

function secretRef(id: string) {
  return { source: 'file' as const, provider: 'lark-secrets', id };
}

function makeResolverContext(sourceConfig: OpenClawConfig): ResolverContext {
  return {
    sourceConfig,
    env: {} as NodeJS.ProcessEnv,
    cache: {},
    warnings: [],
    warningKeys: new Set<string>(),
    assignments: [],
  };
}

/** Run `collectRuntimeConfigAssignments` over a synthetic Feishu section. */
function runCollect(feishu: Record<string, unknown>) {
  const cfg = { channels: { feishu } } as unknown as OpenClawConfig;
  const context = makeResolverContext(cfg);
  collectRuntimeConfigAssignments({ config: cfg, defaults: undefined, context });
  return { cfg, context };
}

describe('Feishu secret contract API — structure', () => {
  it('registers six targets covering top-level and account scope', () => {
    expect(new Set(secretTargetRegistryEntries.map((entry) => entry.id))).toEqual(
      new Set([
        'channels.feishu.appSecret',
        'channels.feishu.encryptKey',
        'channels.feishu.verificationToken',
        'channels.feishu.accounts.*.appSecret',
        'channels.feishu.accounts.*.encryptKey',
        'channels.feishu.accounts.*.verificationToken',
      ]),
    );
    expect(secretTargetRegistryEntries).toHaveLength(6);
  });

  it('every target declares string-shaped secret_input with all lifecycle phases enabled', () => {
    for (const entry of secretTargetRegistryEntries) {
      expect(entry.secretShape).toBe('secret_input');
      expect(entry.expectedResolvedValue).toBe('string');
      expect(entry.configFile).toBe('openclaw.json');
      expect(entry.includeInPlan).toBe(true);
      expect(entry.includeInConfigure).toBe(true);
      expect(entry.includeInAudit).toBe(true);
      expect(entry.targetType).toBe(entry.id);
      expect(entry.pathPattern).toBe(entry.id);
    }
  });
});

describe('Feishu secret contract API — appSecret (always required)', () => {
  it('collects SecretRef assignment for top-level channels.feishu.appSecret', () => {
    const { cfg, context } = runCollect({
      enabled: true,
      appId: 'cli_default',
      appSecret: secretRef('/lark/top-appSecret'),
      accounts: { default: { enabled: true } },
    });

    const topAssignment = context.assignments.find(
      (a) => a.path === 'channels.feishu.appSecret',
    );
    expect(topAssignment).toBeDefined();
    topAssignment!.apply('resolved-top-appSecret');
    const feishu = cfg.channels?.feishu as Record<string, unknown>;
    expect(feishu.appSecret).toBe('resolved-top-appSecret');
  });

  it('collects SecretRef assignment for account channels.feishu.accounts.*.appSecret', () => {
    const { cfg, context } = runCollect({
      enabled: true,
      appId: 'cli_default',
      accounts: {
        mediaops: {
          enabled: true,
          appId: 'cli_mediaops',
          appSecret: secretRef('/lark/acct-appSecret'),
        },
      },
    });

    const acctAssignment = context.assignments.find(
      (a) => a.path === 'channels.feishu.accounts.mediaops.appSecret',
    );
    expect(acctAssignment).toBeDefined();
    acctAssignment!.apply('resolved-acct-appSecret');
    const account = (cfg.channels?.feishu as { accounts: Record<string, Record<string, unknown>> })
      .accounts.mediaops;
    expect(account.appSecret).toBe('resolved-acct-appSecret');
  });

  it('leaves plaintext channels.feishu.appSecret untouched', () => {
    const { cfg, context } = runCollect({
      enabled: true,
      appId: 'cli_default',
      appSecret: 'plaintext-appSecret',
      accounts: { default: { enabled: true } },
    });

    const paths = context.assignments.map((a) => a.path);
    expect(paths).not.toContain('channels.feishu.appSecret');
    const feishu = cfg.channels?.feishu as Record<string, unknown>;
    expect(feishu.appSecret).toBe('plaintext-appSecret');
  });
});

describe.each(['encryptKey', 'verificationToken'] as const)(
  'Feishu secret contract API — %s (webhook-conditional)',
  (field) => {
    it(`collects top-level ${field} SecretRef when connectionMode is webhook`, () => {
      const { cfg, context } = runCollect({
        enabled: true,
        connectionMode: 'webhook',
        appId: 'cli_default',
        [field]: secretRef(`/lark/top-${field}`),
        accounts: { default: { enabled: true } },
      });

      const topAssignment = context.assignments.find(
        (a) => a.path === `channels.feishu.${field}`,
      );
      expect(topAssignment).toBeDefined();
      topAssignment!.apply(`resolved-top-${field}`);
      const feishu = cfg.channels?.feishu as Record<string, unknown>;
      expect(feishu[field]).toBe(`resolved-top-${field}`);
    });

    it(`collects account ${field} SecretRef when account connectionMode is webhook`, () => {
      const { cfg, context } = runCollect({
        enabled: true,
        appId: 'cli_default',
        accounts: {
          webhookbot: {
            enabled: true,
            connectionMode: 'webhook',
            appId: 'cli_webhookbot',
            [field]: secretRef(`/lark/acct-${field}`),
          },
        },
      });

      const acctPath = `channels.feishu.accounts.webhookbot.${field}`;
      const acctAssignment = context.assignments.find((a) => a.path === acctPath);
      expect(acctAssignment).toBeDefined();
      acctAssignment!.apply(`resolved-acct-${field}`);
      const account = (cfg.channels?.feishu as { accounts: Record<string, Record<string, unknown>> })
        .accounts.webhookbot;
      expect(account[field]).toBe(`resolved-acct-${field}`);
    });

    it(`skips top-level ${field} SecretRef and warns when default mode is websocket`, () => {
      const { context } = runCollect({
        enabled: true,
        // connectionMode unset → defaults to websocket
        appId: 'cli_default',
        [field]: secretRef(`/lark/top-${field}`),
        accounts: { default: { enabled: true } },
      });

      const paths = context.assignments.map((a) => a.path);
      expect(paths).not.toContain(`channels.feishu.${field}`);
      expect(context.warnings.length).toBeGreaterThan(0);
      const warning = context.warnings.find((w) => w.path === `channels.feishu.${field}`);
      expect(warning).toBeDefined();
      expect(warning!.code).toBe('SECRETS_REF_IGNORED_INACTIVE_SURFACE');
    });

    it(`skips account ${field} SecretRef when account connectionMode is websocket`, () => {
      const { context } = runCollect({
        enabled: true,
        connectionMode: 'webhook',
        appId: 'cli_default',
        accounts: {
          wsbot: {
            enabled: true,
            connectionMode: 'websocket',
            appId: 'cli_wsbot',
            [field]: secretRef(`/lark/acct-${field}`),
          },
        },
      });

      const paths = context.assignments.map((a) => a.path);
      expect(paths).not.toContain(`channels.feishu.accounts.wsbot.${field}`);
    });

    it(`leaves plaintext ${field} untouched in webhook mode`, () => {
      const { cfg, context } = runCollect({
        enabled: true,
        connectionMode: 'webhook',
        appId: 'cli_default',
        [field]: `plaintext-${field}`,
        accounts: { default: { enabled: true } },
      });

      const paths = context.assignments.map((a) => a.path);
      expect(paths).not.toContain(`channels.feishu.${field}`);
      const feishu = cfg.channels?.feishu as Record<string, unknown>;
      expect(feishu[field]).toBe(`plaintext-${field}`);
    });
  },
);
