import { describe, expect, it } from 'vitest';
import type { OpenClawConfig } from 'openclaw/plugin-sdk';

import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from '../secret-contract-api.ts';

function secretRef(id: string) {
  return { source: 'file', provider: 'lark-secrets', id };
}

function makeResolverContext(sourceConfig: OpenClawConfig) {
  return {
    sourceConfig,
    env: {},
    cache: {},
    warnings: [],
    warningKeys: new Set<string>(),
    assignments: [],
  };
}

describe('Feishu secret contract API', () => {
  it('registers top-level and account-scoped Feishu secret targets', () => {
    expect(secretTargetRegistryEntries.map((entry) => entry.id)).toEqual([
      'channels.feishu.accounts.*.appSecret',
      'channels.feishu.appSecret',
      'channels.feishu.accounts.*.encryptKey',
      'channels.feishu.encryptKey',
      'channels.feishu.accounts.*.verificationToken',
      'channels.feishu.verificationToken',
    ]);
  });

  it('collects active SecretRef assignments for Feishu account credentials', () => {
    const cfg = {
      channels: {
        feishu: {
          enabled: true,
          appId: 'cli_default',
          appSecret: secretRef('/lark/defaultSecret'),
          accounts: {
            default: {
              enabled: true,
            },
            mediaops: {
              enabled: true,
              appId: 'cli_mediaops',
              appSecret: secretRef('/lark/mediaopsSecret'),
            },
            disabled: {
              enabled: false,
              appId: 'cli_disabled',
              appSecret: secretRef('/lark/disabledSecret'),
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const context = makeResolverContext(cfg);

    collectRuntimeConfigAssignments({
      config: cfg,
      defaults: undefined,
      context,
    });

    expect(context.assignments.map((assignment: { path: string }) => assignment.path)).toEqual([
      'channels.feishu.appSecret',
      'channels.feishu.accounts.mediaops.appSecret',
    ]);
    expect(context.warnings).toHaveLength(1);

    const [topLevel, account] = context.assignments as Array<{ apply(value: string): void }>;
    topLevel.apply('resolved-default');
    account.apply('resolved-mediaops');

    const feishu = cfg.channels?.feishu as {
      appSecret: unknown;
      accounts: Record<string, { appSecret: unknown }>;
    };
    expect(feishu.appSecret).toBe('resolved-default');
    expect(feishu.accounts.mediaops.appSecret).toBe('resolved-mediaops');
    expect(feishu.accounts.disabled.appSecret).toEqual(secretRef('/lark/disabledSecret'));
  });
});
