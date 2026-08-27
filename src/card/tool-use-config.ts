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

import type { ClawdbotConfig } from '../types/plugin-sdk-types';
import { resolveDefaultAgentId } from 'openclaw/plugin-sdk/agent-runtime';
import { loadSessionStore, resolveSessionStoreEntry, resolveStorePath } from 'openclaw/plugin-sdk/config-runtime';
import type { FeishuConfig } from '../core/types';

export type ToolUseMode = 'off' | 'on' | 'full';

export interface ToolUseDisplayConfig {
  mode: ToolUseMode;
  showToolUse: boolean;
  showToolResultDetails: boolean;
  showFullPaths: boolean;
}

export function resolveToolUseDisplayConfig(params: {
  cfg: ClawdbotConfig;
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
  cfg: ClawdbotConfig;
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

function resolveSessionVerboseMode(cfg: ClawdbotConfig, sessionKey: string, agentId: string): ToolUseMode | undefined {
  try {
    const cfgWithSession = cfg as { session?: { store?: string }; sessions?: { store?: string } };
    const sessionStorePath = cfgWithSession.session?.store ?? cfgWithSession.sessions?.store;
    const storePath = resolveStorePath(sessionStorePath, { agentId });
    const store = loadSessionStore(storePath);
    const candidateKeys = resolveCandidateSessionKeys(cfg, sessionKey);

    for (const candidateKey of candidateKeys) {
      const resolved = resolveSessionStoreEntry({ store, sessionKey: candidateKey });
      const mode = normalizeToolUseMode(resolved.existing?.verboseLevel);
      if (mode) return mode;
      if (resolved.existing) return undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function resolveCandidateSessionKeys(cfg: ClawdbotConfig, sessionKey: string): string[] {
  const key = sessionKey.trim().toLowerCase();
  const defaultAgentId = resolveDefaultAgentId(cfg as Record<string, unknown>);
  const fallbackKey = key.replace(/^(agent):[^:]+:/, `$1:${defaultAgentId}:`);
  return fallbackKey !== key ? [key, fallbackKey] : [key];
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
