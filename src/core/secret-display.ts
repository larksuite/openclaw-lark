/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

/**
 * Render an appSecret for diagnostics without revealing it. Outside the
 * gateway (for example `openclaw feishu-diagnose`) the config still holds the
 * unresolved SecretRef object, so describe the reference instead.
 */
export function formatSecretForDisplay(secret: unknown, notSetLabel: string): string {
  if (typeof secret === 'string') {
    if (!secret) return notSetLabel;
    return secret.length <= 4 ? '****' : `${secret.slice(0, 4)}****`;
  }
  if (secret && typeof secret === 'object') {
    const { source, provider, id } = secret as { source?: unknown; provider?: unknown; id?: unknown };
    return `SecretRef(${[source, provider, id].filter((part) => typeof part === 'string').join(':')})`;
  }
  return notSetLabel;
}
