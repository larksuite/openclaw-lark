/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Channel type definitions for the Lark/Feishu channel plugin.
 */

import type { ClawdbotConfig, RuntimeEnv } from 'openclaw/plugin-sdk';
import type { ChannelAccountSnapshot } from 'openclaw/plugin-sdk/channel-runtime';
import type { HistoryEntry } from 'openclaw/plugin-sdk/reply-history';
import type { LarkClient } from '../core/lark-client';
import type { MessageDedup } from '../messaging/inbound/dedup';

// Re-export from core for backward compatibility
export type { FeishuProbeResult } from '../core/types';

// ---------------------------------------------------------------------------
// Monitor types
// ---------------------------------------------------------------------------

export type FeishuRuntimeState = 'starting' | 'connecting' | 'ready' | 'degraded' | 'restarting' | 'failed' | 'stopped';

export interface FeishuAccountRuntimeSnapshot extends ChannelAccountSnapshot {
  state?: FeishuRuntimeState;
  lastErrorAt?: number | null;
  lastErrorReason?: string | null;
  lastConnectStartAt?: number | null;
  lastReadyAt?: number | null;
  lastRestartReason?: string | null;
  consecutiveFailures?: number;
  attemptId?: number | null;
}

export type FeishuStatusPatch = Omit<FeishuAccountRuntimeSnapshot, 'accountId'>;

export interface MonitorFeishuOpts {
  config?: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string;
  setStatus?: (patch: FeishuStatusPatch) => void;
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
  cfg: ClawdbotConfig;
  lark: LarkClient;
  accountId: string;
  chatHistories: Map<string, HistoryEntry[]>;
  messageDedup: MessageDedup;
  runtime?: RuntimeEnv;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}
