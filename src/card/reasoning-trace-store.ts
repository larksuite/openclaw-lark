/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Runtime trace store for structured tool execution steps.
 *
 * The Feishu card renderer reads from this store by session key so it can
 * render observable, replayable execution steps without relying purely on
 * lossy reply callbacks.
 */

import { normalizeToolName, truncateText } from './reasoning-utils';

export interface ReasoningTraceStep {
  id: string;
  seq: number;
  toolName: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
  status: 'running' | 'success' | 'error';
  startedAt: number;
  finishedAt?: number;
}

interface SessionTraceState {
  nextSeq: number;
  updatedAt: number;
  steps: ReasoningTraceStep[];
}

const TRACE_TTL_MS = 30 * 60 * 1000;
const MAX_SESSION_TRACES = 128;
const MAX_STEPS_PER_SESSION = 256;
const STEP_RUNNING_TIMEOUT_MS = 5 * 60 * 1000;
const sessionTraces = new Map<string, SessionTraceState>();

export function startReasoningTraceRun(sessionKey: string): void {
  if (!sessionKey) return;
  pruneTraceStore();
  sessionTraces.set(sessionKey, {
    nextSeq: 1,
    updatedAt: Date.now(),
    steps: [],
  });
}

export function recordReasoningToolStart(params: {
  sessionKey?: string;
  toolName: string;
  toolParams?: Record<string, unknown>;
}): void {
  const { sessionKey, toolName, toolParams } = params;
  if (!sessionKey || !toolName) return;

  const state = ensureSessionTraceState(sessionKey);
  const now = Date.now();
  if (state.steps.length >= MAX_STEPS_PER_SESSION) {
    state.steps.splice(0, state.steps.length - MAX_STEPS_PER_SESSION + 1);
  }
  state.steps.push({
    id: `${state.nextSeq}`,
    seq: state.nextSeq,
    toolName,
    params: sanitizeTraceValue(toolParams) as Record<string, unknown> | undefined,
    status: 'running',
    startedAt: now,
  });
  state.nextSeq += 1;
  state.updatedAt = now;
}

export function recordReasoningToolEnd(params: {
  sessionKey?: string;
  toolName: string;
  toolParams?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
}): void {
  const { sessionKey, toolName, toolParams, result, error, durationMs } = params;
  if (!sessionKey || !toolName) return;

  const state = ensureSessionTraceState(sessionKey);
  const now = Date.now();
  const sanitizedParams = sanitizeTraceValue(toolParams) as Record<string, unknown> | undefined;
  const pendingIndex = findPendingStepIndex(state.steps, toolName, sanitizedParams);

  if (pendingIndex >= 0) {
    const step = state.steps[pendingIndex];
    if (!step) return;
    step.status = error ? 'error' : 'success';
    step.result = sanitizeTraceValue(result);
    step.error = error ? truncateText(error, 160) : undefined;
    step.durationMs = durationMs;
    step.finishedAt = now;
    if (!step.params && sanitizedParams) {
      step.params = sanitizedParams;
    }
    state.updatedAt = now;
    return;
  }

  state.steps.push({
    id: `${state.nextSeq}`,
    seq: state.nextSeq,
    toolName,
    params: sanitizedParams,
    result: sanitizeTraceValue(result),
    error: error ? truncateText(error, 160) : undefined,
    durationMs,
    status: error ? 'error' : 'success',
    startedAt: now,
    finishedAt: now,
  });
  state.nextSeq += 1;
  state.updatedAt = now;
}

export function getReasoningTraceSteps(sessionKey?: string): ReasoningTraceStep[] {
  if (!sessionKey) return [];
  const state = sessionTraces.get(sessionKey);
  if (!state) return [];
  if (Date.now() - state.updatedAt > TRACE_TTL_MS) {
    sessionTraces.delete(sessionKey);
    return [];
  }
  const now = Date.now();
  return state.steps.map((step) => {
    // Mark stale running steps as timed out
    if (step.status === 'running' && now - step.startedAt > STEP_RUNNING_TIMEOUT_MS) {
      return { ...step, status: 'error' as const, error: 'timed out', finishedAt: now };
    }
    return { ...step };
  });
}

function ensureSessionTraceState(sessionKey: string): SessionTraceState {
  const existing = sessionTraces.get(sessionKey);
  if (existing) return existing;

  const state: SessionTraceState = {
    nextSeq: 1,
    updatedAt: Date.now(),
    steps: [],
  };
  sessionTraces.set(sessionKey, state);
  pruneTraceStore();
  return state;
}

function findPendingStepIndex(steps: ReasoningTraceStep[], toolName: string, params?: Record<string, unknown>): number {
  const normalizedToolName = normalizeToolName(toolName);
  const paramsKey = fingerprintTraceValue(params);

  // Exact match: toolName + params fingerprint
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (!step || step.status !== 'running') continue;
    if (normalizeToolName(step.toolName) !== normalizedToolName) continue;
    if (fingerprintTraceValue(step.params) !== paramsKey) continue;
    return index;
  }

  // Fallback: toolName-only match (handles cases where params differ between start/end)
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (!step || step.status !== 'running') continue;
    if (normalizeToolName(step.toolName) !== normalizedToolName) continue;
    return index;
  }

  return -1;
}

function pruneTraceStore(): void {
  const now = Date.now();
  for (const [sessionKey, state] of sessionTraces) {
    if (now - state.updatedAt > TRACE_TTL_MS) {
      sessionTraces.delete(sessionKey);
    }
  }

  if (sessionTraces.size <= MAX_SESSION_TRACES) return;

  const overflow = sessionTraces.size - MAX_SESSION_TRACES;
  const entries = [...sessionTraces.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  for (const [sessionKey] of entries.slice(0, overflow)) {
    sessionTraces.delete(sessionKey);
  }
}

function sanitizeTraceValue(value: unknown, depth = 0): unknown {
  if (value == null) return undefined;
  if (typeof value === 'string') return truncateText(value, 180);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 2) return '[truncated]';

  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => sanitizeTraceValue(item, depth + 1));
  }

  if (typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};

    for (const [key, entryValue] of Object.entries(input).slice(0, 12)) {
      output[key] = isSensitiveKey(key) ? '[redacted]' : sanitizeTraceValue(entryValue, depth + 1);
    }

    return output;
  }

  return truncateText(String(value), 180);
}

function isSensitiveKey(key: string): boolean {
  return /(secret|token|password|authorization|cookie|api[-_]?key)/i.test(key);
}

function fingerprintTraceValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);
  return JSON.stringify(sortTraceValue(value));
}

function sortTraceValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortTraceValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, sortTraceValue(entryValue)]),
    );
  }
  return value;
}

