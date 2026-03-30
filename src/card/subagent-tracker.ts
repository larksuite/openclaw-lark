/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Tracks active subagent runs per conversation so the streaming card can show
 * "处理中..." instead of "已完成" while subagents are still running.
 */

import { larkLogger } from '../core/lark-logger';
import { buildConversationKey, removeCompletedCard } from './card-registry';

const log = larkLogger('card/subagent-tracker');

/** Active subagent runs keyed by runId → full conversation context. */
const activeRuns = new Map<string, { to: string; accountId?: string; threadId?: string }>();

/** Per-conversation active subagent count. Key: buildConversationKey result. */
const chatCounts = new Map<string, number>();

/**
 * Record a subagent spawn for a conversation.
 */
export function trackSubagentSpawned(params: {
  runId: string;
  to: string;
  accountId?: string;
  threadId?: string;
}): void {
  const { runId, to, accountId, threadId } = params;
  const key = buildConversationKey({ to, accountId, threadId });

  activeRuns.set(runId, { to, accountId, threadId });

  const prev = chatCounts.get(key) ?? 0;
  chatCounts.set(key, prev + 1);

  log.info('subagent spawned', { runId, to, count: prev + 1 });
}

/**
 * Record a subagent end.
 */
export function trackSubagentEnded(runId: string): void {
  const entry = activeRuns.get(runId);
  if (!entry) return;

  activeRuns.delete(runId);

  const key = buildConversationKey({ to: entry.to, accountId: entry.accountId, threadId: entry.threadId });
  const prev = chatCounts.get(key) ?? 1;
  if (prev <= 1) {
    chatCounts.delete(key);
    // All subagents done — clean up any stale card registry entry
    // left by the last sendText merge (which couldn't know it was last
    // because subagent_ended fires after sendText).
    removeCompletedCard(key);
  } else {
    chatCounts.set(key, prev - 1);
  }

  log.info('subagent ended', { runId, to: entry.to, remaining: Math.max(0, prev - 1) });
}

/**
 * Check whether a conversation has any active subagent runs.
 */
export function hasActiveSubagents(to: string, accountId?: string, threadId?: string): boolean {
  const key = buildConversationKey({ to, accountId, threadId });
  return (chatCounts.get(key) ?? 0) > 0;
}
