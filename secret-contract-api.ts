import type { OpenClawConfig } from 'openclaw/plugin-sdk';
import {
  collectSimpleChannelFieldAssignments,
  getChannelSurface,
} from 'openclaw/plugin-sdk/channel-secret-basic-runtime';

type SimpleChannelFieldAssignmentParams = Parameters<typeof collectSimpleChannelFieldAssignments>[0];

interface RuntimeConfigAssignmentParams {
  config: OpenClawConfig;
  defaults: SimpleChannelFieldAssignmentParams['defaults'];
  context: SimpleChannelFieldAssignmentParams['context'];
}

interface SecretTargetRegistryEntry {
  id: string;
  targetType: string;
  configFile: 'openclaw.json';
  pathPattern: string;
  secretShape: 'secret_input';
  expectedResolvedValue: 'string';
  includeInPlan: boolean;
  includeInConfigure: boolean;
  includeInAudit: boolean;
}

const SECRET_FIELDS = ['appSecret', 'encryptKey', 'verificationToken'] as const;

export const secretTargetRegistryEntries: readonly SecretTargetRegistryEntry[] = SECRET_FIELDS.flatMap((field) => [
  {
    id: `channels.feishu.accounts.*.${field}`,
    targetType: `channels.feishu.accounts.*.${field}`,
    configFile: 'openclaw.json',
    pathPattern: `channels.feishu.accounts.*.${field}`,
    secretShape: 'secret_input',
    expectedResolvedValue: 'string',
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: `channels.feishu.${field}`,
    targetType: `channels.feishu.${field}`,
    configFile: 'openclaw.json',
    pathPattern: `channels.feishu.${field}`,
    secretShape: 'secret_input',
    expectedResolvedValue: 'string',
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
]);

export function collectRuntimeConfigAssignments(params: RuntimeConfigAssignmentParams): void {
  const resolved = getChannelSurface(params.config, 'feishu');
  if (!resolved) return;

  const { channel, surface } = resolved;
  for (const field of SECRET_FIELDS) {
    collectSimpleChannelFieldAssignments({
      channelKey: 'feishu',
      field,
      channel,
      surface,
      defaults: params.defaults,
      context: params.context,
      topInactiveReason: `no enabled Feishu account inherits this top-level ${field}.`,
      accountInactiveReason: 'Feishu account is disabled.',
    });
  }
}
