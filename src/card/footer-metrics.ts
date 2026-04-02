/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Shared utility for reading footer session metrics (token counts, model info,
 * cache stats).  Extracted from StreamingCardController so that
 * finalizeCardAfterSubagents can also access the same data.
 */

import { readFile } from 'node:fs/promises';
import { resolveDefaultAgentId } from 'openclaw/plugin-sdk/agent-runtime';
import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import { LarkClient } from '../core/lark-client';
import { larkLogger } from '../core/lark-logger';
import type { FooterSessionMetrics } from './reply-dispatcher-types';

const log = larkLogger('card/footer-metrics');

/**
 * Resolve footer session metrics for a given session key and config.
 * Returns token counts, model name, cache stats, etc.
 */
export async function resolveFooterSessionMetrics(params: {
  cfg: ClawdbotConfig;
  sessionKey: string;
}): Promise<FooterSessionMetrics | undefined> {
  const { cfg, sessionKey } = params;

  try {
    const runtime = LarkClient.runtime as {
      agent?: {
        session?: {
          resolveStorePath?: (storePath?: string) => string;
          loadSessionStore?: (storePath: string) => Record<string, Record<string, unknown>>;
        };
      };
      channel?: {
        session?: {
          resolveStorePath?: (storePath?: string) => string;
        };
      };
    } | null;
    if (!runtime) return undefined;

    const cfgWithSession = cfg as { sessions?: { store?: string }; session?: { store?: string } };
    const sessionStorePath = cfgWithSession.sessions?.store ?? cfgWithSession.session?.store;
    const key = sessionKey.trim().toLowerCase();

    const defaultAgentId = resolveDefaultAgentId(cfg as Record<string, unknown>);
    const fallbackKey = key.replace(/^(agent):[^:]+:/, `$1:${defaultAgentId}:`);
    const candidateKeys = fallbackKey !== key ? [key, fallbackKey] : [key];

    // Try runtime agent session API first
    const sessionApi = runtime.agent?.session;
    if (sessionApi?.resolveStorePath && sessionApi?.loadSessionStore) {
      const storePath = sessionApi.resolveStorePath(sessionStorePath);
      const store = sessionApi.loadSessionStore(storePath);

      const entry = findSessionEntry(store, candidateKeys);
      if (entry) {
        return extractMetrics(entry);
      }
      return undefined;
    }

    // Fallback: channel session file
    const channelSession = runtime.channel?.session;
    if (!channelSession?.resolveStorePath) return undefined;

    const storePath = channelSession.resolveStorePath(sessionStorePath);
    const raw = await readFile(storePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const store =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, Record<string, unknown>>)
        : {};

    const entry = findSessionEntry(store, candidateKeys);
    return entry ? extractMetrics(entry) : undefined;
  } catch (err) {
    log.debug('resolveFooterSessionMetrics: failed', { error: String(err) });
    return undefined;
  }
}

function findSessionEntry(
  store: Record<string, Record<string, unknown>>,
  candidateKeys: string[],
): Record<string, unknown> | undefined {
  for (const key of candidateKeys) {
    const val = store[key];
    if (val && typeof val === 'object') return val as Record<string, unknown>;
  }
  return undefined;
}

function extractMetrics(entry: Record<string, unknown>): FooterSessionMetrics {
  return {
    inputTokens: typeof entry.inputTokens === 'number' ? entry.inputTokens : undefined,
    outputTokens: typeof entry.outputTokens === 'number' ? entry.outputTokens : undefined,
    cacheRead: typeof entry.cacheRead === 'number' ? entry.cacheRead : undefined,
    cacheWrite: typeof entry.cacheWrite === 'number' ? entry.cacheWrite : undefined,
    totalTokens: typeof entry.totalTokens === 'number' ? entry.totalTokens : undefined,
    totalTokensFresh: typeof entry.totalTokensFresh === 'boolean' ? entry.totalTokensFresh : undefined,
    contextTokens: typeof entry.contextTokens === 'number' ? entry.contextTokens : undefined,
    model: typeof entry.model === 'string' ? entry.model : undefined,
  };
}
