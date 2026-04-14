/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Structured tool-use display for Lark/Feishu cards.
 */

import type { ToolUseTraceStep } from './tool-use-trace-store';
import { normalizeToolName, redactInlineSecrets } from './reasoning-utils';

export type ToolUseStepStatus = ToolUseTraceStep['status'];

export interface ToolUseDisplayBlock {
  language: 'json' | 'text';
  content: string;
}

export interface ToolUseDisplayStep {
  title: string;
  detail?: string;
  iconToken: string;
  status: ToolUseStepStatus;
  resultBlock?: ToolUseDisplayBlock;
  errorBlock?: ToolUseDisplayBlock;
}

export interface ToolUseDisplayResult {
  content: string;
  stepCount: number;
  steps: ToolUseDisplayStep[];
}

export const EMPTY_TOOL_USE_PLACEHOLDER = 'No tool steps available';

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
  status?: ToolUseStepStatus;
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

export function normalizeToolUseDisplay(params: {
  traceSteps?: ToolUseTraceStep[];
  showFullPaths?: boolean;
  showResultDetails?: boolean;
}): ToolUseDisplayResult {
  const traceSteps = params.traceSteps ?? [];
  const showFullPaths = params.showFullPaths === true;
  const showResultDetails = params.showResultDetails === true;
  const sources = traceSteps.map(toTraceSource);
  const steps = sources
    .map((source) => formatToolStep(source, { showFullPaths, showResultDetails }))
    .filter((step): step is ToolUseDisplayStep => !!step);

  return {
    content: steps.map((step) => (step.detail ? `- ${step.title}: ${step.detail}` : `- ${step.title}`)).join('\n'),
    stepCount: steps.length,
    steps,
  };
}

export function buildToolUseTitleSuffix(params: { stepCount: number }): { zh: string; en: string } {
  const { stepCount } = params;
  return {
    zh: `查看 ${stepCount} 个步骤`,
    en: `Show ${stepCount} step${stepCount === 1 ? '' : 's'}`,
  };
}

function toTraceSource(step: ToolUseTraceStep): ToolStepSource {
  return {
    toolName: step.toolName,
    params: step.params,
    result: step.result,
    error: step.error,
    durationMs: step.durationMs,
    status: step.status,
  };
}

function formatToolStep(
  source: ToolStepSource,
  options: { showFullPaths: boolean; showResultDetails: boolean },
): ToolUseDisplayStep | undefined {
  const descriptor = resolveToolDescriptor(source.toolName);
  const rawDetail =
    (descriptor ? extractDetailFromParams(source.params, descriptor) : undefined) ??
    (descriptor ? extractDetailFromSummary(source.summaryText, descriptor) : cleanupLine(source.summaryText ?? '')) ??
    undefined;
  const detail = rawDetail ? sanitizeToolDetail(descriptor?.sanitizer ?? 'generic', rawDetail, options) : undefined;
  const title = buildToolTitle(source, descriptor, rawDetail);
  const status = resolveStepStatus(source);
  const errorBlock = source.error ? buildErrorBlock(source.error, descriptor) : undefined;
  const resultBlock = !errorBlock && options.showResultDetails ? buildResultBlock(source, descriptor) : undefined;

  return {
    title,
    detail,
    iconToken: descriptor?.iconToken ?? 'setting-inter_outlined',
    status,
    resultBlock,
    errorBlock,
  };
}

function buildToolTitle(source: ToolStepSource, descriptor: ToolDescriptor | undefined, rawDetail?: string): string {
  const baseTitle =
    descriptor?.title === 'Read' && rawDetail && isSkillPathValue(rawDetail)
      ? 'Skill Read'
      : (descriptor?.title ?? humanizeToolName(source.toolName ?? 'tool'));
  const durationLabel = source.durationMs != null ? formatDurationLabel(source.durationMs) : undefined;
  return durationLabel ? `${baseTitle} (${durationLabel})` : baseTitle;
}

function resolveToolDescriptor(toolName?: string): ToolDescriptor | undefined {
  const normalizedName = normalizeToolName(toolName);
  return TOOL_DESCRIPTORS.find((descriptor) =>
    descriptor.aliases.some(
      (alias) =>
        normalizedName === alias || normalizedName.startsWith(`${alias}_`) || normalizedName.startsWith(`${alias}-`),
    ),
  );
}

function extractDetailFromParams(
  params: Record<string, unknown> | undefined,
  descriptor: ToolDescriptor,
): string | undefined {
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

function buildResultBlock(
  source: ToolStepSource,
  descriptor: ToolDescriptor | undefined,
): ToolUseDisplayBlock | undefined {
  if (source.result == null) return undefined;
  if (descriptor && ['Read', 'Edit', 'Fetch web page', 'Browser'].includes(descriptor.title)) {
    return undefined;
  }
  return buildDisplayBlock(sanitizeDisplayBlockValue(source.result, descriptor));
}

function buildErrorBlock(error: string, descriptor: ToolDescriptor | undefined): ToolUseDisplayBlock | undefined {
  return buildDisplayBlock(sanitizeDisplayBlockValue(error, descriptor), 'text');
}

function sanitizeDisplayBlockValue(value: unknown, descriptor: ToolDescriptor | undefined): unknown {
  if (descriptor?.sanitizer === 'command' && typeof value === 'string') {
    return redactInlineSecrets(value);
  }
  return value;
}

function buildPatternDetail(params: Record<string, unknown>, options: { includeTarget: boolean }): string | undefined {
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
  if (kind === 'command') {
    const cleaned = normalizeInlineDisplayText(value);
    if (!cleaned) return undefined;
    return sanitizeCommandLike(cleaned, options);
  }

  const cleaned = sanitizeGenericText(value);
  if (!cleaned) return undefined;

  switch (kind) {
    case 'skill':
      return (
        cleaned
          .replace(/^skill\s+/i, '')
          .replace(/[-_]+/g, ' ')
          .trim() || 'skill'
      );
    case 'path':
      return sanitizePathLike(cleaned, options);
    case 'search':
      return stripQuotes(cleaned);
    case 'url':
      return stripQuotes(cleaned).replace(/^from\s+/i, '');
    case 'generic':
    default:
      return cleaned;
  }
}

function normalizeInlineDisplayText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function sanitizePathLike(value: string, options: { showFullPaths: boolean }): string {
  const cleaned = sanitizeGenericText(value)
    .replace(/^(?:from|file|path)\s+/i, '')
    .trim();
  if (options.showFullPaths) return cleaned;

  const skillMatch = cleaned.match(/(?:^|\/)skills\/([^/]+)\//i);
  if (skillMatch?.[1]) {
    return skillMatch[1].replace(/[-_]+/g, ' ').trim() || cleaned;
  }

  const segments = cleaned.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? cleaned;
}

function sanitizeCommandLike(value: string, options: { showFullPaths: boolean }): string {
  const cleaned = stripQuotes(value)
    .replace(/^(?:command|script|description)\s+/i, '')
    .replace(/^.*?\s+->\s+/i, '')
    .trim();
  if (!cleaned) return 'command';
  const redacted = redactInlineSecrets(cleaned);
  return options.showFullPaths ? redacted : redactCommandPaths(redacted);
}

function resolveStepStatus(source: ToolStepSource): ToolUseStepStatus {
  if (source.error) return 'error';
  if (source.status) return source.status;
  return 'success';
}

function buildDisplayBlock(
  value: unknown,
  fallbackLanguage: 'json' | 'text' = 'json',
): ToolUseDisplayBlock | undefined {
  if (value == null) return undefined;

  if (typeof value === 'string') {
    const normalized = value.replace(/\r\n/g, '\n').trim();
    if (!normalized) return undefined;
    const parsed = tryParseJson(normalized);
    if (parsed && typeof parsed === 'object') {
      const prettyJson = stringifyJson(parsed);
      if (prettyJson) {
        return { language: 'json', content: prettyJson };
      }
    }
    return { language: fallbackLanguage === 'json' ? 'text' : fallbackLanguage, content: normalized };
  }

  if (typeof value === 'object') {
    const prettyJson = stringifyJson(value);
    if (prettyJson) {
      return { language: 'json', content: prettyJson };
    }
  }

  const normalized = String(value).trim();
  return normalized ? { language: 'text', content: normalized } : undefined;
}

function stringifyJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

function tryParseJson(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (!trimmed || !/^(?:\{|\[)/.test(trimmed)) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
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
  if (/^https?:\/\//i.test(value)) return sanitizeUrlForDisplay(value);
  if (!looksLikePathToken(value)) return value;
  return basenameFromPath(value);
}

function sanitizeUrlForDisplay(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/(secret|token|password|key|credential|bearer|auth)/i.test(key)) {
        parsed.searchParams.set(key, '[redacted]');
      }
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function looksLikePathToken(value: string): boolean {
  return (
    value.startsWith('~/') ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('/') ||
    value.includes('/')
  );
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
