/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Read session display metadata through the public SDK for either storage API.
 */
import { createRequire } from 'node:module';

const requireSdk = createRequire(typeof __filename !== 'undefined' ? __filename : import.meta.url);

interface DisplaySessionEntry {
  verboseLevel?: unknown;
}
interface SessionSdk {
  resolveStorePath: (store: string | undefined, options: { agentId: string }) => string;
  getSessionEntry?: (params: {
    storePath: string;
    sessionKey: string;
    agentId: string;
  }) => DisplaySessionEntry | undefined;
  loadSessionStore?: (storePath: string) => Record<string, unknown>;
  resolveSessionStoreEntry?: (params: { store: Record<string, unknown>; sessionKey: string }) => {
    existing?: DisplaySessionEntry;
  };
}

function resolveSessionSdk(): SessionSdk {
  try {
    const sdk = requireSdk('openclaw/plugin-sdk/session-store-runtime') as SessionSdk;
    if (sdk.getSessionEntry) return sdk;
  } catch (error) {
    // Older hosts expose the JSON store helpers through config-runtime instead.
    if (
      (error as NodeJS.ErrnoException).code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED' &&
      (error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND'
    )
      throw error;
  }
  return requireSdk('openclaw/plugin-sdk/config-runtime') as SessionSdk;
}

export function readDisplaySessionEntry(params: {
  store?: string;
  sessionKey: string;
  agentId: string;
}): DisplaySessionEntry | undefined {
  const sdk = resolveSessionSdk();
  const storePath = sdk.resolveStorePath(params.store, { agentId: params.agentId });
  if (sdk.getSessionEntry) {
    // This SDK accessor is read-only; never open or migrate a database ourselves.
    return sdk.getSessionEntry({ storePath, sessionKey: params.sessionKey, agentId: params.agentId });
  }
  if (!sdk.loadSessionStore || !sdk.resolveSessionStoreEntry) throw new Error('Unsupported session SDK');
  return sdk.resolveSessionStoreEntry({ store: sdk.loadSessionStore(storePath), sessionKey: params.sessionKey })
    .existing;
}
