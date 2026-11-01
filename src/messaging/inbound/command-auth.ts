/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { resolveDmGroupAccessWithLists } from 'openclaw/plugin-sdk/channel-policy';

interface CommandAuthorizer {
  configured: boolean;
  allowed: boolean;
}

export interface SenderCommandAuthorizationParams {
  rawBody: string;
  cfg: OpenClawConfig;
  isGroup: boolean;
  dmPolicy: string;
  configuredAllowFrom: string[];
  configuredGroupAllowFrom?: string[];
  senderId: string;
  isSenderAllowed: (senderId: string, allowFrom: string[]) => boolean;
  readAllowFromStore: () => Promise<string[]>;
  shouldComputeCommandAuthorized: (rawBody: string, cfg: OpenClawConfig) => boolean;
  resolveCommandAuthorizedFromAuthorizers: (params: {
    useAccessGroups: boolean;
    authorizers: CommandAuthorizer[];
  }) => boolean;
}

export async function resolveSenderCommandAuthorization(
  params: SenderCommandAuthorizationParams,
): Promise<{ commandAuthorized: boolean | undefined }> {
  const shouldComputeAuth = params.shouldComputeCommandAuthorized(params.rawBody, params.cfg);
  const readsStore =
    !params.isGroup && params.dmPolicy !== 'allowlist' && (params.dmPolicy !== 'open' || shouldComputeAuth);
  const storeAllowFrom = readsStore ? await params.readAllowFromStore().catch(() => []) : [];

  const { effectiveAllowFrom, effectiveGroupAllowFrom } = resolveDmGroupAccessWithLists({
    isGroup: params.isGroup,
    dmPolicy: params.dmPolicy,
    groupPolicy: 'allowlist',
    allowFrom: params.configuredAllowFrom,
    groupAllowFrom: params.configuredGroupAllowFrom ?? [],
    storeAllowFrom,
    isSenderAllowed: (allowFrom) => params.isSenderAllowed(params.senderId, allowFrom),
  });

  if (!shouldComputeAuth) return { commandAuthorized: undefined };
  return {
    commandAuthorized: params.resolveCommandAuthorizedFromAuthorizers({
      useAccessGroups: true,
      authorizers: [
        {
          configured: effectiveAllowFrom.length > 0,
          allowed: params.isSenderAllowed(params.senderId, effectiveAllowFrom),
        },
        {
          configured: effectiveGroupAllowFrom.length > 0,
          allowed: params.isSenderAllowed(params.senderId, effectiveGroupAllowFrom),
        },
      ],
    }),
  };
}
