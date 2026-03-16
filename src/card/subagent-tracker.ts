/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Tracks active subagent runs per chat so the streaming card can show
 * "处理中..." instead of "已完成" while subagents are still running.
 */

import { larkLogger } from '../core/lark-logger';
import { removeCompletedCard } from './card-registry';

const log = larkLogger('card/subagent-tracker');

/** Active subagent runs keyed by runId → chat target info. */
const activeRuns = new Map<string, { chatId: string; accountId?: string }>();

/** Per-chat active subagent count. Key: `${accountId}:${chatId}` or `${chatId}`. */
const chatCounts = new Map<string, number>();

function buildChatKey(chatId: string, accountId?: string): string {
  return accountId ? `${accountId}:${chatId}` : chatId;
}

/**
 * Record a subagent spawn for a chat.
 */
export function trackSubagentSpawned(params: {
  runId: string;
  chatId: string;
  accountId?: string;
}): void {
  const { runId, chatId, accountId } = params;
  const key = buildChatKey(chatId, accountId);

  activeRuns.set(runId, { chatId, accountId });

  const prev = chatCounts.get(key) ?? 0;
  chatCounts.set(key, prev + 1);

  log.info('subagent spawned', { runId, chatId, count: prev + 1 });
}

/**
 * Record a subagent end.
 */
export function trackSubagentEnded(runId: string): void {
  const entry = activeRuns.get(runId);
  if (!entry) return;

  activeRuns.delete(runId);

  const key = buildChatKey(entry.chatId, entry.accountId);
  const prev = chatCounts.get(key) ?? 1;
  const remaining = Math.max(0, prev - 1);
  if (prev <= 1) {
    chatCounts.delete(key);
    // All subagents done — clean up any stale card registry entry
    // left by the last sendText merge (which couldn't know it was last
    // because subagent_ended fires after sendText).
    removeCompletedCard(entry.chatId, entry.accountId);
  } else {
    chatCounts.set(key, prev - 1);
  }

  log.info('subagent ended', { runId, chatId: entry.chatId, remaining });
}

/**
 * Check whether a chat has any active subagent runs.
 */
export function hasActiveSubagents(chatId: string, accountId?: string): boolean {
  const key = buildChatKey(chatId, accountId);
  return (chatCounts.get(key) ?? 0) > 0;
}
