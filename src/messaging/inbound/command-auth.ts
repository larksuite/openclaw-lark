/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Preserve the sender authorization contract previously provided by
 * openclaw/plugin-sdk/command-auth, removed in OpenClaw 2026.10.
 * Keep command detection and authorizer policy delegated to the host runtime.
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import { resolveDmGroupAccessWithLists } from 'openclaw/plugin-sdk/channel-policy';

interface SenderCommandAuthorizationParams {
  cfg: ClawdbotConfig;
  rawBody: string;
  isGroup: boolean;
  dmPolicy: string;
  configuredAllowFrom: string[];
  configuredGroupAllowFrom?: string[];
  senderId: string;
  isSenderAllowed: (senderId: string, allowFrom: string[]) => boolean;
  readAllowFromStore: () => Promise<string[]>;
  shouldComputeCommandAuthorized: (rawBody: string, cfg: ClawdbotConfig) => boolean;
  resolveCommandAuthorizedFromAuthorizers: (params: {
    useAccessGroups: boolean;
    authorizers: Array<{ configured: boolean; allowed: boolean }>;
  }) => boolean;
}

export async function resolveSenderCommandAuthorization(params: SenderCommandAuthorizationParams): Promise<{
  shouldComputeAuth: boolean;
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
  senderAllowedForCommands: boolean;
  commandAuthorized: boolean | undefined;
}> {
  const shouldComputeAuth = params.shouldComputeCommandAuthorized(params.rawBody, params.cfg);
  // Pairing approvals are account-scoped by the caller and must remain DM-only.
  // Explicit allowlist/open policies do not consume pairing-store approvals.
  const storeAllowFrom =
    !params.isGroup && params.dmPolicy !== 'allowlist' && params.dmPolicy !== 'open'
      ? await params.readAllowFromStore().catch(() => [])
      : [];
  const { effectiveAllowFrom, effectiveGroupAllowFrom } = resolveDmGroupAccessWithLists({
    isGroup: params.isGroup,
    dmPolicy: params.dmPolicy,
    groupPolicy: 'allowlist',
    allowFrom: params.configuredAllowFrom,
    groupAllowFrom: params.configuredGroupAllowFrom ?? [],
    storeAllowFrom,
    isSenderAllowed: (allowFrom) => params.isSenderAllowed(params.senderId, allowFrom),
  });
  const senderAllowedForCommands = params.isSenderAllowed(
    params.senderId,
    params.isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom,
  );
  const ownerAllowedForCommands = params.isSenderAllowed(params.senderId, effectiveAllowFrom);
  const groupAllowedForCommands = params.isSenderAllowed(params.senderId, effectiveGroupAllowFrom);
  const commandAuthorized = shouldComputeAuth
    ? params.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups: params.cfg.commands?.useAccessGroups !== false,
        authorizers: [
          { configured: effectiveAllowFrom.length > 0, allowed: ownerAllowedForCommands },
          { configured: effectiveGroupAllowFrom.length > 0, allowed: groupAllowedForCommands },
        ],
      })
    : undefined;

  return {
    shouldComputeAuth,
    effectiveAllowFrom,
    effectiveGroupAllowFrom,
    senderAllowedForCommands,
    commandAuthorized,
  };
}
