/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Onboarding configuration mutation helpers.
 *
 * Pure functions that apply Feishu channel configuration changes
 * to a OpenClawConfig. Extracted from onboarding.ts for reuse
 * in CLI commands and other configuration flows.
 */

import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import type { DmPolicy } from 'openclaw/plugin-sdk/setup';
import { addWildcardAllowFrom } from 'openclaw/plugin-sdk/setup';

// ---------------------------------------------------------------------------
// Config mutation helpers
// ---------------------------------------------------------------------------

export function setFeishuDmPolicy(cfg: OpenClawConfig, dmPolicy: DmPolicy): OpenClawConfig {
  const allowFrom =
    dmPolicy === 'open'
      ? addWildcardAllowFrom(cfg.channels?.feishu?.allowFrom)?.map((entry) => String(entry))
      : undefined;

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      feishu: {
        ...cfg.channels?.feishu,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

export function setFeishuAllowFrom(cfg: OpenClawConfig, allowFrom: string[]): OpenClawConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      feishu: {
        ...cfg.channels?.feishu,
        allowFrom,
      },
    },
  };
}

export function setFeishuGroupPolicy(
  cfg: OpenClawConfig,
  groupPolicy: 'open' | 'allowlist' | 'disabled',
): OpenClawConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      feishu: {
        ...cfg.channels?.feishu,
        enabled: true,
        groupPolicy,
      },
    },
  };
}

export function setFeishuGroupAllowFrom(cfg: OpenClawConfig, groupAllowFrom: string[]): OpenClawConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      feishu: {
        ...cfg.channels?.feishu,
        groupAllowFrom,
      },
    },
  };
}

export function setFeishuGroups(cfg: OpenClawConfig, groups: Record<string, object>): OpenClawConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      feishu: {
        ...cfg.channels?.feishu,
        groups,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

export function parseAllowFromInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}
