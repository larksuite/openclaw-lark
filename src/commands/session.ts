/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Helpers for explicit and natural-language Codex ACP session spawning.
 */

export interface CodexThreadSpawnRequest {
  task: string;
  trigger: 'command' | 'intent';
  source: string;
}

const DEFAULT_SPAWN_TASK =
  'Start a persistent ACP Codex session bound to the current Feishu thread and wait for follow-up instructions from this thread.';

const EXPLICIT_COMMAND_PATTERNS = [
  /^\/codex[_ -]?thread(?:\s+(?<task>[\s\S]+))?$/i,
  /^\/acp[_ -]?session(?:\s+(?<task>[\s\S]+))?$/i,
  /^\/feishu[_ ]session(?:\s+codex)?(?:\s+(?<task>[\s\S]+))?$/i,
];

const START_PATTERN = /(开启|启动|创建|发起|开一个|开个|拉起|spawn|start|open|create)/i;
const SESSION_PATTERN = /(acp|codex|persistent|persist|持久|session|会话)/i;
const THREAD_PATTERN = /(thread|话题|线程|当前话题|当前线程|绑定到当前|绑定当前|在这个会话里|在当前会话里)/i;
const EXECUTION_PATTERN = /(实际调用|实际创建|真的创建|立即创建|must call|actually call|call sessions_spawn|使用\s*codex\s*开|用\s*codex\s*开)/i;

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function truncateTask(input: string, maxLength = 900): string {
  const normalized = normalizeWhitespace(input);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

export function parseCodexThreadSpawnRequest(text: string): CodexThreadSpawnRequest | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  for (const pattern of EXPLICIT_COMMAND_PATTERNS) {
    const match = trimmed.match(pattern);
    if (!match) continue;
    const rawTask = typeof match.groups?.task === 'string' ? match.groups.task : '';
    const task = truncateTask(rawTask || DEFAULT_SPAWN_TASK);
    return {
      task,
      trigger: 'command',
      source: trimmed,
    };
  }

  if (
    START_PATTERN.test(trimmed) &&
    SESSION_PATTERN.test(trimmed) &&
    THREAD_PATTERN.test(trimmed) &&
    (EXECUTION_PATTERN.test(trimmed) || /sessions_spawn/i.test(trimmed))
  ) {
    return {
      task: truncateTask(trimmed),
      trigger: 'intent',
      source: trimmed,
    };
  }

  return null;
}

export function buildCodexThreadSpawnPrompt(task: string): string {
  const normalizedTask = truncateTask(task || DEFAULT_SPAWN_TASK);
  return [
    'Do not infer the result from prior conversation. Actually call sessions_spawn now.',
    'Required arguments:',
    'runtime=acp',
    'agentId=codex',
    'thread=true',
    'mode=session',
    `task=${JSON.stringify(normalizedTask)}`,
    'If the tool call succeeds, reply only with the spawned session id.',
    'If the tool call fails, reply only with the real error message.',
  ].join('\n');
}
