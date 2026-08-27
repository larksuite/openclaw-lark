/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Feishu channel secret-contract registration. Declares which fields are
 * SecretRef-shaped so OpenClaw's runtime resolves them at startup.
 */

import {
  collectConditionalChannelFieldAssignments,
  collectSimpleChannelFieldAssignments,
  getChannelSurface,
  hasOwnProperty,
  normalizeSecretStringValue,
} from 'openclaw/plugin-sdk/channel-secret-basic-runtime';
import type {
  ResolverContext,
  SecretDefaults,
  SecretTargetRegistryEntry,
} from 'openclaw/plugin-sdk/channel-secret-basic-runtime';
import type { OpenClawConfig } from './src/types/plugin-sdk-types';

const SECRET_FIELDS = ['appSecret', 'encryptKey', 'verificationToken'] as const;

/** Fields the Lark SDK only consumes when an account is in webhook mode. */
const WEBHOOK_ONLY_FIELDS = ['encryptKey', 'verificationToken'] as const;

export const secretTargetRegistryEntries: readonly SecretTargetRegistryEntry[] = SECRET_FIELDS.flatMap(
  (field) => {
    const acctPath = `channels.feishu.accounts.*.${field}`;
    const topPath = `channels.feishu.${field}`;
    return [
      {
        id: acctPath,
        targetType: acctPath,
        configFile: 'openclaw.json',
        pathPattern: acctPath,
        secretShape: 'secret_input',
        expectedResolvedValue: 'string',
        includeInPlan: true,
        includeInConfigure: true,
        includeInAudit: true,
      },
      {
        id: topPath,
        targetType: topPath,
        configFile: 'openclaw.json',
        pathPattern: topPath,
        secretShape: 'secret_input',
        expectedResolvedValue: 'string',
        includeInPlan: true,
        includeInConfigure: true,
        includeInAudit: true,
      },
    ];
  },
);

export function collectRuntimeConfigAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, 'feishu');
  if (!resolved) return;

  const { channel, surface } = resolved;

  collectSimpleChannelFieldAssignments({
    channelKey: 'feishu',
    field: 'appSecret',
    channel,
    surface,
    defaults: params.defaults,
    context: params.context,
    topInactiveReason: 'no enabled Feishu account inherits this top-level appSecret.',
    accountInactiveReason: 'Feishu account is disabled.',
  });

  const baseConnectionMode =
    normalizeSecretStringValue(channel.connectionMode) === 'webhook' ? 'webhook' : 'websocket';
  const resolveAccountMode = (account: Record<string, unknown>): string | undefined =>
    hasOwnProperty(account, 'connectionMode')
      ? normalizeSecretStringValue(account.connectionMode)
      : baseConnectionMode;

  for (const field of WEBHOOK_ONLY_FIELDS) {
    collectConditionalChannelFieldAssignments({
      channelKey: 'feishu',
      field,
      channel,
      surface,
      defaults: params.defaults,
      context: params.context,
      topLevelActiveWithoutAccounts: baseConnectionMode === 'webhook',
      topLevelInheritedAccountActive: ({ account, enabled }) =>
        enabled && !hasOwnProperty(account, field) && resolveAccountMode(account) === 'webhook',
      accountActive: ({ account, enabled }) => enabled && resolveAccountMode(account) === 'webhook',
      topInactiveReason: `no enabled Feishu webhook-mode surface inherits this top-level ${field}.`,
      accountInactiveReason: 'Feishu account is disabled or not running in webhook mode.',
    });
  }
}
