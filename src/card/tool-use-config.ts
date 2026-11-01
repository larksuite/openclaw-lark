/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Resolution logic for Feishu tool-use display.
 *
 * The source of truth is OpenClaw's effective verbose state:
 * inline `/verbose` override > session store override > config default.
 * Feishu channel config only retains UI-level detail (`showFullPaths`).
 */

import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { resolveDefaultAgentId } from 'openclaw/plugin-sdk/agent-runtime';
import { getSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';
import type { FeishuConfig } from '../core/types';

export type ToolUseMode = 'off' | 'on' | 'full';

export interface ToolUseDisplayConfig {
  mode: ToolUseMode;
  showToolUse: boolean;
  showToolResultDetails: boolean;
  showFullPaths: boolean;
}

export function resolveToolUseDisplayConfig(params: {
  cfg: OpenClawConfig;
  feishuCfg: FeishuConfig | undefined;
  agentId: string;
  sessionKey: string;
  body?: string;
}): ToolUseDisplayConfig {
  const mode = resolveEffectiveVerboseMode(params);
  return {
    mode,
    showToolUse: mode !== 'off',
    showToolResultDetails: mode === 'full',
    showFullPaths: params.feishuCfg?.toolUseDisplay?.showFullPaths === true,
  };
}

function resolveEffectiveVerboseMode(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  body?: string;
}): ToolUseMode {
  return (
    extractInlineVerboseMode(params.body) ??
    resolveSessionVerboseMode(params.cfg, params.sessionKey, params.agentId) ??
    normalizeToolUseMode(params.cfg.agents?.defaults?.verboseDefault) ??
    'off'
  );
}

function resolveSessionVerboseMode(cfg: OpenClawConfig, sessionKey: string, agentId: string): ToolUseMode | undefined {
  try {
    for (const candidate of resolveCandidateSessions(cfg, sessionKey, agentId)) {
      const existing = getSessionEntry(candidate);
      const mode = normalizeToolUseMode(existing?.verboseLevel);
      if (mode) return mode;
      if (existing) return undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function resolveCandidateSessions(
  cfg: OpenClawConfig,
  sessionKey: string,
  agentId: string,
): Array<{ agentId: string; sessionKey: string }> {
  const key = sessionKey.trim().toLowerCase();
  const defaultAgentId = resolveDefaultAgentId(cfg as Record<string, unknown>);
  const fallbackKey = key.replace(/^(agent):[^:]+:/, `$1:${defaultAgentId}:`);
  return fallbackKey !== key
    ? [
        { agentId, sessionKey: key },
        { agentId: defaultAgentId, sessionKey: fallbackKey },
      ]
    : [{ agentId, sessionKey: key }];
}

function extractInlineVerboseMode(body?: string): ToolUseMode | undefined {
  if (!body) return undefined;
  const matches = body.matchAll(/(?:^|\s)\/(?:verbose|v)(?::|\s+)(on|off|full)\b/gi);
  let last: ToolUseMode | undefined;
  for (const match of matches) {
    last = normalizeToolUseMode(match[1]);
  }
  return last;
}

function normalizeToolUseMode(value: unknown): ToolUseMode | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'off' || normalized === 'on' || normalized === 'full') {
    return normalized;
  }
  return undefined;
}
