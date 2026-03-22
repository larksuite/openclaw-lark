/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Structured reasoning step display for Lark/Feishu cards.
 *
 * This module is intentionally trace-first: it prefers structured tool traces
 * from plugin hooks and only falls back to the reply callback summaries when
 * richer data is unavailable.
 */

import type { ReasoningTraceStep } from './reasoning-trace-store';
import { normalizeToolName, truncateText } from './reasoning-utils';

export interface ReasoningDisplayStep {
  title: string;
  detail?: string;
  iconToken: string;
}

export interface ReasoningDisplayResult {
  content: string;
  stepCount: number;
  steps: ReasoningDisplayStep[];
}

export const EMPTY_REASONING_PLACEHOLDER = 'No reasoning text available';

export interface ReasoningToolEvent {
  kind: 'start' | 'summary';
  name?: string;
  phase?: string;
  text?: string;
}

type SanitizerKind = 'skill' | 'path' | 'search' | 'url' | 'command' | 'generic';
type SummarySource = 'matched' | 'code' | 'quoted' | 'url' | 'line';

interface ToolDescriptor {
  aliases: string[];
  iconToken: string;
  title: string;
  sanitizer: SanitizerKind;
  paramKeys?: string[];
  summaryPatterns?: RegExp[];
  summaryPreference?: SummarySource[];
  detailFromParams?: (params: Record<string, unknown>) => string | undefined;
}

interface ToolStepSource {
  toolName?: string;
  params?: Record<string, unknown>;
  summaryText?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

interface SummarySignals {
  line: string;
  matched?: string;
  code?: string;
  quoted?: string;
  url?: string;
}

const DEFAULT_SUMMARY_PREFERENCE: SummarySource[] = ['matched', 'code', 'quoted', 'url', 'line'];

const TOOL_DESCRIPTORS: ToolDescriptor[] = [
  {
    aliases: ['skill'],
    iconToken: 'app-default_outlined',
    title: 'Load skill',
    sanitizer: 'skill',
    paramKeys: ['skill', 'name'],
    summaryPatterns: [/^(?:load|use)\s+skill\s+(.+)$/i],
  },
  {
    aliases: ['read', 'open'],
    iconToken: 'file-link-text_outlined',
    title: 'Read',
    sanitizer: 'path',
    paramKeys: ['file_path', 'path', 'file'],
    summaryPatterns: [/^(?:read|open)\s+(?:file\s+)?(.+)$/i],
    summaryPreference: ['code', 'quoted', 'matched', 'line'],
  },
  {
    aliases: ['write', 'edit'],
    iconToken: 'edit_outlined',
    title: 'Edit',
    sanitizer: 'path',
    paramKeys: ['file_path', 'path', 'file'],
    summaryPatterns: [/^(?:edit|write)\s+(?:file\s+)?(.+)$/i],
    summaryPreference: ['code', 'quoted', 'matched', 'line'],
  },
  {
    aliases: ['web_search', 'web-search', 'search'],
    iconToken: 'search_outlined',
    title: 'Search web',
    sanitizer: 'search',
    paramKeys: ['query', 'q'],
    summaryPatterns: [/^(?:search\s+(?:web\s+)?(?:for|about)|query)\s+(.+)$/i],
    summaryPreference: ['quoted', 'matched', 'line'],
  },
  {
    aliases: ['web_fetch', 'web-fetch', 'fetch'],
    iconToken: 'language_outlined',
    title: 'Fetch web page',
    sanitizer: 'url',
    paramKeys: ['url'],
    summaryPatterns: [/^(?:fetch|open)\s+(?:web\s+page\s+)?(?:from\s+)?(.+)$/i],
    summaryPreference: ['url', 'matched', 'quoted', 'line'],
  },
  {
    aliases: ['grep'],
    iconToken: 'doc-search_outlined',
    title: 'Search text',
    sanitizer: 'generic',
    detailFromParams: (params) => buildPatternDetail(params, { includeTarget: true }),
    summaryPatterns: [/^(?:search\s+text(?:\s+by\s+pattern)?|grep)\s+(.+)$/i],
  },
  {
    aliases: ['glob'],
    iconToken: 'folder_outlined',
    title: 'Search files',
    sanitizer: 'generic',
    paramKeys: ['pattern'],
    summaryPatterns: [/^(?:search\s+files(?:\s+by\s+pattern)?|glob)\s+(.+)$/i],
  },
  {
    aliases: ['exec', 'bash', 'command', 'run'],
    iconToken: 'setting_outlined',
    title: 'Run command',
    sanitizer: 'command',
    paramKeys: ['description', 'command', 'script'],
    summaryPatterns: [/^(?:run|execute)\s+(?:command|script)?\s*(.+)$/i],
    summaryPreference: ['code', 'quoted', 'matched', 'line'],
  },
  {
    aliases: ['browser', 'playwright', 'navigate'],
    iconToken: 'browser-mac_outlined',
    title: 'Browser',
    sanitizer: 'url',
    paramKeys: ['url'],
    summaryPatterns: [/^(?:open|browse|visit|navigate\s+to)\s+(.+)$/i],
    summaryPreference: ['url', 'quoted', 'matched', 'line'],
  },
  {
    aliases: ['agent', 'task', 'spawn'],
    iconToken: 'robot_outlined',
    title: 'Run sub-agent',
    sanitizer: 'generic',
    paramKeys: ['task', 'description', 'prompt'],
    summaryPatterns: [/^(?:run\s+sub-?agent|spawn\s+agent)\s+(.+)$/i],
  },
  {
    aliases: ['check', 'determine', 'verify'],
    iconToken: 'list-check_outlined',
    title: 'Check',
    sanitizer: 'generic',
    paramKeys: ['target', 'subject', 'description'],
  },
  {
    aliases: ['summarize', 'analyze', 'prepare'],
    iconToken: 'report_outlined',
    title: 'Analyze',
    sanitizer: 'generic',
    paramKeys: ['target', 'subject', 'description'],
  },
];

export function normalizeReasoningDisplay(params: {
  traceSteps?: ReasoningTraceStep[];
  toolEvents?: ReasoningToolEvent[];
  showFullPaths?: boolean;
}): ReasoningDisplayResult {
  const traceSteps = params.traceSteps ?? [];
  const toolEvents = params.toolEvents ?? [];
  const showFullPaths = params.showFullPaths === true;
  const sources = traceSteps.length > 0 ? traceSteps.map(toTraceSource) : buildToolStepSources(toolEvents);
  const steps = sources
    .map((source) => formatToolStep(source, { showFullPaths }))
    .filter((step): step is ReasoningDisplayStep => !!step);

  return {
    content: steps
      .map((step) => (step.detail ? `- ${step.title}: ${step.detail}` : `- ${step.title}`))
      .join('\n'),
    stepCount: steps.length,
    steps,
  };
}

export function buildReasoningTitleSuffix(params: { stepCount: number }): { zh: string; en: string } {
  const { stepCount } = params;
  return {
    zh: `查看 ${stepCount} 个步骤`,
    en: `Show ${stepCount} step${stepCount === 1 ? '' : 's'}`,
  };
}

function toTraceSource(step: ReasoningTraceStep): ToolStepSource {
  return {
    toolName: step.toolName,
    params: step.params,
    result: step.result,
    error: step.error,
    durationMs: step.durationMs,
  };
}

function buildToolStepSources(toolEvents: ReasoningToolEvent[]): ToolStepSource[] {
  const steps: ToolStepSource[] = [];
  const pendingIndexes: number[] = [];

  for (const event of toolEvents) {
    if (event.kind === 'start') {
      if (event.phase && event.phase !== 'start') continue;
      const toolName = event.name?.trim();
      if (!toolName) continue;
      steps.push({ toolName });
      pendingIndexes.push(steps.length - 1);
      continue;
    }

    if (event.kind !== 'summary') continue;
    const summaryText = event.text?.trim();
    if (!summaryText) continue;

    // Try to match summary to a pending start by tool name (handles concurrent tools)
    const matchedPendingPos = event.name
      ? pendingIndexes.findIndex((idx) => {
          const step = steps[idx];
          return step && normalizeToolName(step.toolName) === normalizeToolName(event.name);
        })
      : -1;

    if (matchedPendingPos >= 0) {
      const pendingIndex = pendingIndexes[matchedPendingPos];
      pendingIndexes.splice(matchedPendingPos, 1);
      if (pendingIndex != null && steps[pendingIndex]) {
        steps[pendingIndex].summaryText = summaryText;
        continue;
      }
    }

    // Fallback: match first pending (FIFO) when no name available
    const pendingIndex = pendingIndexes.shift();
    if (pendingIndex != null && steps[pendingIndex]) {
      steps[pendingIndex].summaryText = summaryText;
      continue;
    }

    steps.push({ summaryText });
  }

  return steps;
}

function formatToolStep(source: ToolStepSource, options: { showFullPaths: boolean }): ReasoningDisplayStep | undefined {
  const descriptor = resolveToolDescriptor(source.toolName);
  const rawDetail =
    (descriptor ? extractDetailFromParams(source.params, descriptor) : undefined) ??
    (descriptor ? extractDetailFromSummary(source.summaryText, descriptor) : cleanupLine(source.summaryText ?? '')) ??
    (source.result != null ? cleanupLine(asDisplayText(source.result)) : undefined);
  const detail = rawDetail
    ? sanitizeToolDetail(descriptor?.sanitizer ?? 'generic', rawDetail, options)
    : undefined;
  const title = buildToolTitle(source, descriptor, rawDetail);
  const meta = buildStepMeta(source);

  return {
    title,
    detail: joinDetailParts(detail, meta),
    iconToken: descriptor?.iconToken ?? 'setting-inter_outlined',
  };
}

function buildToolTitle(
  source: ToolStepSource,
  descriptor: ToolDescriptor | undefined,
  rawDetail?: string,
): string {
  const baseTitle =
    descriptor?.title === 'Read' && rawDetail && isSkillPathValue(rawDetail)
      ? 'Skill Read'
      : descriptor?.title ?? humanizeToolName(source.toolName ?? 'tool');
  const durationLabel = source.durationMs != null ? formatDurationLabel(source.durationMs) : undefined;
  return durationLabel ? `${baseTitle} (${durationLabel})` : baseTitle;
}

function resolveToolDescriptor(toolName?: string): ToolDescriptor | undefined {
  const normalizedName = normalizeToolName(toolName);
  return TOOL_DESCRIPTORS.find((descriptor) =>
    descriptor.aliases.some(
      (alias) =>
        normalizedName === alias ||
        normalizedName.startsWith(`${alias}_`) ||
        normalizedName.startsWith(`${alias}-`),
    ),
  );
}

function extractDetailFromParams(params: Record<string, unknown> | undefined, descriptor: ToolDescriptor): string | undefined {
  if (!params) return undefined;
  if (descriptor.detailFromParams) return descriptor.detailFromParams(params);

  for (const key of descriptor.paramKeys ?? []) {
    const value = params[key];
    const text = extractScalarText(value);
    if (text) return text;
  }

  return undefined;
}

function extractDetailFromSummary(summaryText: string | undefined, descriptor: ToolDescriptor): string | undefined {
  if (!summaryText) return undefined;

  const lines = summaryText
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => cleanupLine(stripMarkdown(line)))
    .filter((line) => line && !isNoiseLine(line));

  for (const line of lines) {
    const signals = buildSummarySignals(line, descriptor.summaryPatterns ?? []);
    const detail = pickSummaryDetail(signals, descriptor.summaryPreference ?? DEFAULT_SUMMARY_PREFERENCE);
    if (detail) return detail;
  }

  return undefined;
}

function buildSummarySignals(line: string, patterns: RegExp[]): SummarySignals {
  const matched = patterns
    .map((pattern) => line.match(pattern)?.[1]?.trim())
    .find((value): value is string => Boolean(value));

  return {
    line,
    matched,
    code: extractFirstCodeSpan(line),
    quoted: extractFirstQuotedText(line),
    url: extractFirstUrl(line),
  };
}

function pickSummaryDetail(signals: SummarySignals, preference: SummarySource[]): string | undefined {
  for (const key of preference) {
    const value = signals[key];
    if (value) return value;
  }
  return undefined;
}

function buildStepMeta(source: ToolStepSource): string | undefined {
  const parts: string[] = [];
  if (source.error) {
    parts.push(`Failed: ${truncateText(source.error, 96)}`);
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function joinDetailParts(detail?: string, meta?: string): string | undefined {
  if (detail && meta) return `${detail} · ${meta}`;
  return detail ?? meta;
}

function buildPatternDetail(
  params: Record<string, unknown>,
  options: { includeTarget: boolean },
): string | undefined {
  const pattern = extractScalarText(params.pattern);
  const target = extractScalarText(params.glob ?? params.path ?? params.file_path);
  if (pattern && target && options.includeTarget) {
    return `${pattern} in ${target}`;
  }
  return pattern ?? target ?? undefined;
}

function extractScalarText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function sanitizeToolDetail(
  kind: SanitizerKind,
  value: string,
  options: { showFullPaths: boolean },
): string | undefined {
  const cleaned = sanitizeGenericText(value);
  if (!cleaned) return undefined;

  switch (kind) {
    case 'skill':
      return truncateText(cleaned.replace(/^skill\s+/i, '').replace(/[-_]+/g, ' ').trim() || 'skill', 40);
    case 'path':
      return sanitizePathLike(cleaned, options);
    case 'search':
      return truncateText(stripQuotes(cleaned), 72);
    case 'url':
      return truncateText(stripQuotes(cleaned).replace(/^from\s+/i, ''), 72);
    case 'command':
      return sanitizeCommandLike(cleaned, options);
    case 'generic':
    default:
      return truncateText(cleaned, 84);
  }
}

function sanitizePathLike(value: string, options: { showFullPaths: boolean }): string {
  const cleaned = sanitizeGenericText(value).replace(/^(?:from|file|path)\s+/i, '').trim();
  if (options.showFullPaths) return truncateText(cleaned, 160);

  const skillMatch = cleaned.match(/(?:^|\/)skills\/([^/]+)\//i);
  if (skillMatch?.[1]) {
    return truncateText(skillMatch[1].replace(/[-_]+/g, ' ').trim(), 40);
  }

  const segments = cleaned.split(/[\\/]/).filter(Boolean);
  return truncateText(segments.at(-1) ?? cleaned, 48);
}

function sanitizeCommandLike(value: string, options: { showFullPaths: boolean }): string {
  const cleaned = stripQuotes(value)
    .replace(/^(?:command|script|description)\s+/i, '')
    .replace(/^.*?\s+->\s+/i, '')
    .trim();
  if (!cleaned) return 'command';
  const visible = options.showFullPaths ? cleaned : redactCommandPaths(cleaned);
  return truncateText(visible, options.showFullPaths ? 180 : 120);
}

function redactCommandPaths(command: string): string {
  return command
    .split(/(\s+)/)
    .map((segment) => {
      if (!segment || /^\s+$/.test(segment)) return segment;
      return redactCommandToken(segment);
    })
    .join('');
}

function redactCommandToken(token: string): string {
  const match = token.match(/^([("'`]*)(.*?)([)"'`,;:]*)$/);
  if (!match) return token;

  const [, prefix, rawCore, suffix] = match;
  const core = redactPathAssignment(rawCore);
  return `${prefix}${core}${suffix}`;
}

function redactPathAssignment(value: string): string {
  const equalsIndex = value.indexOf('=');
  if (equalsIndex > 0) {
    const left = value.slice(0, equalsIndex + 1);
    const right = value.slice(equalsIndex + 1);
    return `${left}${redactStandalonePath(right)}`;
  }
  return redactStandalonePath(value);
}

function redactStandalonePath(value: string): string {
  if (!looksLikePathToken(value) || /^https?:\/\//i.test(value)) return value;
  return basenameFromPath(value);
}

function looksLikePathToken(value: string): boolean {
  return value.startsWith('~/') || value.startsWith('./') || value.startsWith('../') || value.startsWith('/') || value.includes('/');
}

function basenameFromPath(value: string): string {
  const cleaned = value.replace(/\\/g, '/').replace(/\/+$/, '');
  const segments = cleaned.split('/').filter(Boolean);
  return segments.at(-1) ?? value;
}

function isSkillPathValue(value: string): boolean {
  return /(?:^|\/)skills\/[^/]+\//i.test(value);
}

function sanitizeGenericText(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanupLine(line: string): string {
  return line
    .replace(/^[-*•]\s*/, '')
    .replace(/^\d+[.)]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripMarkdown(line: string): string {
  return line
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^>\s*/, '')
    .trim();
}

function isNoiseLine(line: string): boolean {
  return /^(?:completed|complete|done|success|succeeded|running|started|finished|ok)$/i.test(line);
}

function humanizeToolName(name: string): string {
  const cleaned = name.replace(/[-_]+/g, ' ').trim();
  if (!cleaned) return 'Tool';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function formatDurationLabel(durationMs: number): string {
  return durationMs < 1000 ? `${durationMs} ms` : `${(durationMs / 1000).toFixed(1)} s`;
}

function asDisplayText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function stripQuotes(value: string): string {
  return value.replace(/^[`'"]+|[`'"]+$/g, '').trim();
}

function extractFirstCodeSpan(value: string): string | undefined {
  const match = value.match(/`([^`]+)`/);
  return match?.[1]?.trim() || undefined;
}

function extractFirstQuotedText(value: string): string | undefined {
  const match = value.match(/["']([^"']+)["']/);
  return match?.[1]?.trim() || undefined;
}

function extractFirstUrl(value: string): string | undefined {
  const match = value.match(/\bhttps?:\/\/[^\s"'`]+/i);
  return match?.[0]?.trim() || undefined;
}
