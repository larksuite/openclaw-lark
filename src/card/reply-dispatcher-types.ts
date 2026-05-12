/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Type definitions for the Feishu reply dispatcher subsystem.
 *
 * Consolidates all interfaces, state shapes, and constants used across
 * reply-dispatcher.ts, streaming-card-controller.ts, flush-controller.ts,
 * and unavailable-guard.ts.
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import type { ReplyDispatcher } from 'openclaw/plugin-sdk/reply-runtime';
import type { FeishuFooterConfig } from '../core/types';
import type { ToolUseDisplayConfig } from './tool-use-config';

// ---------------------------------------------------------------------------
// CardPhase — explicit state machine replacing boolean flags
// ---------------------------------------------------------------------------

export const CARD_PHASES = {
  idle: 'idle',
  creating: 'creating',
  streaming: 'streaming',
  completed: 'completed',
  aborted: 'aborted',
  terminated: 'terminated',
  creation_failed: 'creation_failed',
} as const;

export type CardPhase = (typeof CARD_PHASES)[keyof typeof CARD_PHASES];

export const TERMINAL_PHASES: ReadonlySet<CardPhase> = new Set([
  'completed',
  'aborted',
  'terminated',
  'creation_failed',
]);

/**
 * Why a terminal phase was entered.
 *
 * - `normal`          — streaming completed successfully (onIdle).
 * - `error`           — an error occurred during reply generation (onError).
 * - `abort`           — explicitly cancelled by the caller (abortCard).
 * - `unavailable`     — source message was deleted/recalled (UnavailableGuard).
 * - `creation_failed` — card creation failed, falling back to static delivery.
 */
export type TerminalReason = 'normal' | 'error' | 'abort' | 'unavailable' | 'creation_failed';

export const PHASE_TRANSITIONS: Record<CardPhase, ReadonlySet<CardPhase>> = {
  idle: new Set(['creating', 'aborted', 'terminated']),
  creating: new Set(['streaming', 'creation_failed', 'aborted', 'terminated']),
  streaming: new Set(['completed', 'aborted', 'terminated']),
  completed: new Set(),
  aborted: new Set(),
  terminated: new Set(),
  creation_failed: new Set(),
};

// ---------------------------------------------------------------------------
// Structured state aggregates
// ---------------------------------------------------------------------------

export interface ReasoningState {
  accumulatedReasoningText: string;
  reasoningStartTime: number | null;
  reasoningElapsedMs: number;
  isReasoningPhase: boolean;
}

export interface ToolUseState {
  startedAt: number | null;
  elapsedMs: number;
  isActive: boolean;
}

export interface StreamingTextState {
  accumulatedText: string;
  completedText: string;
  streamingPrefix: string;
  lastPartialText: string;
  lastFlushedText: string;
}

export interface CardKitState {
  cardKitCardId: string | null;
  originalCardKitCardId: string | null;
  cardKitSequence: number;
  cardMessageId: string | null;
}

// ---------------------------------------------------------------------------
// Throttle constants
// ---------------------------------------------------------------------------

/**
 * Throttle intervals for card updates.
 *
 * - `CARDKIT_MS`: CardKit `cardElement.content()` — designed for streaming,
 *   low throttle is fine.
 * - `PATCH_MS`: `im.message.patch` — strict rate limits (code 230020).
 * - `LONG_GAP_THRESHOLD_MS`: After a long idle gap (tool call / LLM thinking),
 *   defer the first flush briefly.
 * - `BATCH_AFTER_GAP_MS`: Batching window after a long gap.
 */
export const THROTTLE_CONSTANTS = {
  CARDKIT_MS: 100,
  PATCH_MS: 1500,
  LONG_GAP_THRESHOLD_MS: 2000,
  BATCH_AFTER_GAP_MS: 300,
  REASONING_STATUS_MS: 1500,
} as const;

export const EMPTY_REPLY_FALLBACK_TEXT = 'Done.';

// ---------------------------------------------------------------------------
// Factory params and result
// ---------------------------------------------------------------------------

export interface CreateFeishuReplyDispatcherParams {
  cfg: ClawdbotConfig;
  agentId: string;
  sessionKey: string;
  chatId: string;
  replyToMessageId?: string;
  /** Account ID for multi-account support. */
  accountId?: string;
  /** Chat type for scene-aware reply mode selection. */
  chatType?: 'p2p' | 'group';
  /** When true, typing indicators are suppressed entirely. */
  skipTyping?: boolean;
  /** When true, replies are sent into the thread instead of main chat. */
  replyInThread?: boolean;
  toolUseDisplay: ToolUseDisplayConfig;
}

/**
 * The structured return type of createFeishuReplyDispatcher.
 *
 * `replyOptions` is typed as `Record<string, unknown>` because the consumer
 * (`dispatchReplyFromConfig`) accepts the SDK-internal `GetReplyOptions`
 * which is not re-exported from `openclaw/plugin-sdk`. The record type
 * is compatible with spread-assignment into `dispatchReplyFromConfig`.
 */
export interface FeishuReplyDispatcherResult {
  dispatcher: ReplyDispatcher;
  replyOptions: Record<string, unknown>;
  markDispatchIdle: () => void;
  markFullyComplete: () => void;
  abortCard: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// StreamingCardController dependencies (injected via constructor)
// ---------------------------------------------------------------------------

export interface FooterSessionMetrics {
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  contextTokens?: number;
  model?: string;
}

export interface StreamingCardDeps {
  cfg: ClawdbotConfig;
  agentId: string;
  sessionKey: string;
  accountId: string | undefined;
  chatId: string;
  replyToMessageId: string | undefined;
  replyInThread: boolean | undefined;
  toolUseDisplay: ToolUseDisplayConfig;
  resolvedFooter: Required<FeishuFooterConfig>;
}
