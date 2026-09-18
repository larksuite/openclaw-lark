/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Channel type definitions for the Lark/Feishu channel plugin.
 */

import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import type { RuntimeEnv } from 'openclaw/plugin-sdk/runtime-env';
import type { HistoryEntry } from 'openclaw/plugin-sdk/reply-history';
import type { LarkClient } from '../core/lark-client';
import type { MessageDedup } from '../messaging/inbound/dedup';

// Re-export from core for backward compatibility
export type { FeishuProbeResult } from '../core/types';

// ---------------------------------------------------------------------------
// Monitor types
// ---------------------------------------------------------------------------

export interface MonitorFeishuOpts {
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string;
}

// ---------------------------------------------------------------------------
// Directory types
// ---------------------------------------------------------------------------

export interface FeishuDirectoryPeer {
  kind: 'user';
  id: string;
  name?: string;
}

export interface FeishuDirectoryGroup {
  kind: 'group';
  id: string;
  name?: string;
}

// ---------------------------------------------------------------------------
// Monitor context (used by event-handlers)
// ---------------------------------------------------------------------------

export interface MonitorContext {
  cfg: OpenClawConfig;
  lark: LarkClient;
  accountId: string;
  chatHistories: Map<string, HistoryEntry[]>;
  messageDedup: MessageDedup;
  runtime?: RuntimeEnv;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}
