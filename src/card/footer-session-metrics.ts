/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Read footer metrics through OpenClaw's public session-store SDK when the
 * host stores session entries in per-agent SQLite databases.
 */
import { createRequire } from 'node:module';
import type { FooterSessionMetrics } from './reply-dispatcher-types';

const requireSdk = createRequire(typeof __filename !== 'undefined' ? __filename : import.meta.url);

interface SessionEntry {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  totalTokens?: unknown;
  totalTokensFresh?: unknown;
  contextTokens?: unknown;
  model?: unknown;
}

interface SessionStoreRuntime {
  resolveStorePath?: (store?: string, options?: { agentId?: string }) => string;
  getSessionEntry?: (params: {
    storePath: string;
    sessionKey: string;
    agentId: string;
    readConsistency: 'latest';
  }) => SessionEntry | undefined;
}

export interface FooterSessionCandidate {
  sessionKey: string;
  agentId: string;
}

export type FooterSessionLookup =
  | { supported: false }
  | {
      supported: true;
      metrics?: FooterSessionMetrics;
      matchedSessionKey?: string;
      storePath?: string;
    };

export function readFooterSessionMetricsFromSdk(params: {
  store?: string;
  candidates: FooterSessionCandidate[];
}): FooterSessionLookup {
  let sdk: SessionStoreRuntime;
  try {
    sdk = requireSdk('openclaw/plugin-sdk/session-store-runtime') as SessionStoreRuntime;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' || code === 'MODULE_NOT_FOUND') {
      return { supported: false };
    }
    throw error;
  }

  if (!sdk.resolveStorePath || !sdk.getSessionEntry) return { supported: false };

  for (const candidate of params.candidates) {
    const storePath = sdk.resolveStorePath(params.store, { agentId: candidate.agentId });
    const entry = sdk.getSessionEntry({
      storePath,
      sessionKey: candidate.sessionKey,
      agentId: candidate.agentId,
      readConsistency: 'latest',
    });
    if (!entry) continue;

    return {
      supported: true,
      matchedSessionKey: candidate.sessionKey,
      storePath,
      metrics: {
        inputTokens: typeof entry.inputTokens === 'number' ? entry.inputTokens : undefined,
        outputTokens: typeof entry.outputTokens === 'number' ? entry.outputTokens : undefined,
        cacheRead: typeof entry.cacheRead === 'number' ? entry.cacheRead : undefined,
        cacheWrite: typeof entry.cacheWrite === 'number' ? entry.cacheWrite : undefined,
        totalTokens: typeof entry.totalTokens === 'number' ? entry.totalTokens : undefined,
        totalTokensFresh: typeof entry.totalTokensFresh === 'boolean' ? entry.totalTokensFresh : undefined,
        contextTokens: typeof entry.contextTokens === 'number' ? entry.contextTokens : undefined,
        model: typeof entry.model === 'string' ? entry.model : undefined,
      },
    };
  }

  return { supported: true };
}
