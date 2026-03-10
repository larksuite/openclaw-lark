/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Onboarding configuration mutation helpers.
 *
 * Pure functions that apply Feishu channel configuration changes
 * to a ClawdbotConfig. Extracted from onboarding.ts for reuse
 * in CLI commands and other configuration flows.
 */

import type { ClawdbotConfig, DmPolicy } from 'openclaw/plugin-sdk';
import { addWildcardAllowFrom } from 'openclaw/plugin-sdk';

// ---------------------------------------------------------------------------
// Config mutation helpers
// ---------------------------------------------------------------------------

export function setFeishuDmPolicy(cfg: ClawdbotConfig, dmPolicy: DmPolicy): ClawdbotConfig {
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

export function setFeishuAllowFrom(cfg: ClawdbotConfig, allowFrom: string[]): ClawdbotConfig {
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
  cfg: ClawdbotConfig,
  groupPolicy: 'open' | 'allowlist' | 'disabled',
): ClawdbotConfig {
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

export function setFeishuGroupAllowFrom(cfg: ClawdbotConfig, groupAllowFrom: string[]): ClawdbotConfig {
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

export function setFeishuGroups(cfg: ClawdbotConfig, groups: Record<string, object>): ClawdbotConfig {
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
