/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Diagnostic module for the Lark/Feishu plugin.
 *
 * Collects environment info, account configuration, API connectivity,
 * app permissions, tool registration state, and recent error logs into
 * a structured report that users can share with developers for
 * remote troubleshooting.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import type { OpenClawConfig } from 'openclaw/plugin-sdk';

interface DiagLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}
import type * as Lark from '@larksuiteoapi/node-sdk';

import { probeFeishu } from '../channel/probe';
import { getLarkAccountIds, getLarkAccount, getEnabledLarkAccounts } from '../core/accounts';
import { LarkClient } from '../core/lark-client';

/**
 * Resolve the global config for cross-account operations.
 * See doctor.ts for rationale.
 */
function resolveGlobalConfig(config: OpenClawConfig): OpenClawConfig {
  return LarkClient.globalConfig ?? config;
}
import { assertLarkOk, formatLarkError } from '../core/api-error';
import { resolveAnyEnabledToolsConfig } from '../core/tools-config';
import type { LarkAccount } from '../core/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

interface DiagCheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  details?: string;
}

interface AccountDiagResult {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  appId?: string;
  brand: string;
  checks: DiagCheckResult[];
}

interface DiagReport {
  timestamp: string;
  environment: {
    nodeVersion: string;
    platform: string;
    arch: string;
    pluginVersion: string;
  };
  accounts: AccountDiagResult[];
  toolsRegistered: string[];
  recentErrors: string[];
  overallStatus: 'healthy' | 'degraded' | 'unhealthy';
  checks: DiagCheckResult[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLUGIN_VERSION = '2026.2.10';
const LOG_READ_BYTES = 256 * 1024; // read last 256KB of log
const MAX_ERROR_LINES = 20;
/** Matches a timestamped log line: 2026-02-13T09:23:35.038Z [level]: ... */
const TIMESTAMPED_LINE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const ERROR_LEVEL_RE = /\[error\]|\[warn\]/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function maskSecret(secret?: string): string {
  if (!secret) return '(未设置)';
  if (secret.length <= 4) return '****';
  return secret.slice(0, 4) + '****';
}

async function extractRecentErrors(logPath: string): Promise<string[]> {
  try {
    await fs.access(logPath);
  } catch {
    return [];
  }

  try {
    const stat = await fs.stat(logPath);
    const readSize = Math.min(stat.size, LOG_READ_BYTES);
    const fd = await fs.open(logPath, 'r');
    try {
      const buffer = Buffer.alloc(readSize);
      await fd.read(buffer, 0, readSize, Math.max(0, stat.size - readSize));
      const content = buffer.toString('utf-8');
      const lines = content.split('\n').filter(Boolean);
      // Only pick timestamped log entries at error/warn level,
      // ignoring stack trace fragments and other noise.
      const errorLines = lines.filter((line) => TIMESTAMPED_LINE_RE.test(line) && ERROR_LEVEL_RE.test(line));
      return errorLines.slice(-MAX_ERROR_LINES);
    } finally {
      await fd.close();
    }
  } catch {
    return [];
  }
}

async function checkAppScopes(client: Lark.Client): Promise<{ granted: number; pending: number; summary: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await (client as any).application.scope.list({});
  assertLarkOk(res);

  const scopes = res.data?.scopes ?? [];
  const granted = scopes.filter((s: { grant_status?: number }) => s.grant_status === 1);
  const pending = scopes.filter((s: { grant_status?: number }) => s.grant_status !== 1);

  return {
    granted: granted.length,
    pending: pending.length,
    summary: `${granted.length} 已授权, ${pending.length} 待授权`,
  };
}

function detectRegisteredTools(config: OpenClawConfig): string[] {
  const accounts = getEnabledLarkAccounts(config);
  if (accounts.length === 0) return [];

  const toolsCfg = resolveAnyEnabledToolsConfig(accounts);

  const tools: string[] = [];
  if (toolsCfg.doc) tools.push('feishu_doc');
  if (toolsCfg.scopes) tools.push('feishu_app_scopes');
  if (toolsCfg.wiki) tools.push('feishu_wiki');
  if (toolsCfg.drive) tools.push('feishu_drive');
  if (toolsCfg.perm) tools.push('feishu_perm');
  tools.push(
    'feishu_bitable_get_meta',
    'feishu_bitable_list_fields',
    'feishu_bitable_list_records',
    'feishu_bitable_get_record',
    'feishu_bitable_create_record',
    'feishu_bitable_update_record',
  );
  tools.push('feishu_task');
  tools.push('feishu_calendar');

  return tools;
}

async function diagnoseAccount(account: LarkAccount): Promise<AccountDiagResult> {
  const checks: DiagCheckResult[] = [];
  const result: AccountDiagResult = {
    accountId: account.accountId,
    name: account.name,
    enabled: account.enabled,
    configured: account.configured,
    appId: account.appId ?? '(未设置)',
    brand: account.brand,
    checks,
  };

  // A1: Credentials
  checks.push({
    name: '凭证完整性',
    status: account.configured ? 'pass' : 'fail',
    message: account.configured
      ? `appId: ${account.appId}, appSecret: ${maskSecret(account.appSecret)}`
      : '缺少 appId 或 appSecret',
  });

  // A2: Enabled
  checks.push({
    name: '账户启用',
    status: account.enabled ? 'pass' : 'warn',
    message: account.enabled ? '已启用' : '已禁用',
  });

  if (!account.configured || !account.appId || !account.appSecret) {
    checks.push({
      name: 'API 连通性',
      status: 'skip',
      message: '凭证未配置，跳过',
    });
    return result;
  }

  // A3: API connectivity via probe
  try {
    const probeResult = await probeFeishu({
      accountId: account.accountId,
      appId: account.appId,
      appSecret: account.appSecret,
      brand: account.brand,
    });

    checks.push({
      name: 'API 连通性',
      status: probeResult.ok ? 'pass' : 'fail',
      message: probeResult.ok ? `连接成功` : `连接失败: ${probeResult.error}`,
    });

    // A4: Bot info
    if (probeResult.ok) {
      checks.push({
        name: 'Bot 信息',
        status: probeResult.botName ? 'pass' : 'warn',
        message: probeResult.botName ? `${probeResult.botName} (${probeResult.botOpenId})` : '未获取到 Bot 名称',
      });
    }
  } catch (err) {
    checks.push({
      name: 'API 连通性',
      status: 'fail',
      message: `探测异常: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // A5: App scopes
  try {
    const client = LarkClient.fromAccount(account).sdk;
    const scopesResult = await checkAppScopes(client);

    checks.push({
      name: '应用权限',
      status: scopesResult.pending > 0 ? 'warn' : 'pass',
      message: scopesResult.summary,
      details: scopesResult.pending > 0 ? '存在未授权的权限，可能影响部分功能' : undefined,
    });
  } catch (err) {
    checks.push({
      name: '应用权限',
      status: 'warn',
      message: `权限检查失败: ${formatLarkError(err)}`,
    });
  }

  // A6: Brand
  checks.push({
    name: '品牌配置',
    status: 'pass',
    message: `brand: ${account.brand}`,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export async function runDiagnosis(params: { config: OpenClawConfig; logger?: DiagLogger }): Promise<DiagReport> {
  const { config } = params;
  // Use the global config to enumerate all accounts — the passed-in
  // config may be account-scoped (accounts map stripped).
  const globalCfg = resolveGlobalConfig(config);
  const globalChecks: DiagCheckResult[] = [];

  // -- Environment --
  const nodeVer = parseInt(process.version.slice(1), 10);
  globalChecks.push({
    name: 'Node.js 版本',
    status: nodeVer >= 18 ? 'pass' : 'warn',
    message: process.version,
    details: nodeVer < 18 ? '建议升级到 Node.js 18+' : undefined,
  });

  // -- Account count --
  const accountIds = getLarkAccountIds(globalCfg);
  globalChecks.push({
    name: '飞书账户数量',
    status: accountIds.length > 0 ? 'pass' : 'fail',
    message: `${accountIds.length} 个账户`,
  });

  // -- Log file --
  const logPath = path.join(os.homedir(), '.openclaw', 'logs', 'gateway.log');
  let logExists = false;
  try {
    await fs.access(logPath);
    logExists = true;
  } catch {
    // noop
  }
  globalChecks.push({
    name: '日志文件',
    status: logExists ? 'pass' : 'warn',
    message: logExists ? logPath : `未找到: ${logPath}`,
  });

  // -- Per-account diagnosis (sequential to avoid rate limits) --
  const accountResults: AccountDiagResult[] = [];
  for (const id of accountIds) {
    const account = getLarkAccount(globalCfg, id);
    const result = await diagnoseAccount(account);
    accountResults.push(result);
  }

  // -- Tools --
  const tools = detectRegisteredTools(globalCfg);

  // -- Recent errors --
  const recentErrors = await extractRecentErrors(logPath);
  globalChecks.push({
    name: '最近错误日志',
    status: recentErrors.length > 0 ? 'warn' : 'pass',
    message: recentErrors.length > 0 ? `发现 ${recentErrors.length} 条错误` : '无最近错误',
  });

  // -- Overall status --
  const allChecks = [...globalChecks, ...accountResults.flatMap((a) => a.checks)];
  const hasFail = allChecks.some((c) => c.status === 'fail');
  const hasWarn = allChecks.some((c) => c.status === 'warn');

  return {
    timestamp: new Date().toISOString(),
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      pluginVersion: PLUGIN_VERSION,
    },
    accounts: accountResults,
    toolsRegistered: tools,
    recentErrors,
    overallStatus: hasFail ? 'unhealthy' : hasWarn ? 'degraded' : 'healthy',
    checks: globalChecks,
  };
}

// ---------------------------------------------------------------------------
// Formatting — plain text (chat command)
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<CheckStatus, string> = {
  pass: '[PASS]',
  warn: '[WARN]',
  fail: '[FAIL]',
  skip: '[SKIP]',
};

function formatCheck(c: DiagCheckResult): string {
  let line = `  ${STATUS_LABEL[c.status]} ${c.name}: ${c.message}`;
  if (c.details) {
    line += `\n         ${c.details}`;
  }
  return line;
}

export function formatDiagReportText(report: DiagReport): string {
  const lines: string[] = [];
  const sep = '====================================';

  lines.push(sep);
  lines.push('  飞书插件诊断报告');
  lines.push(`  ${report.timestamp}`);
  lines.push(sep);
  lines.push('');

  // Environment
  lines.push('【环境信息】');
  lines.push(`  Node.js:     ${report.environment.nodeVersion}`);
  lines.push(`  插件版本:    ${report.environment.pluginVersion}`);
  lines.push(`  系统:        ${report.environment.platform} ${report.environment.arch}`);
  lines.push('');

  // Global checks
  lines.push('【全局检查】');
  for (const c of report.checks) {
    lines.push(formatCheck(c));
  }
  lines.push('');

  // Per-account
  for (const acct of report.accounts) {
    lines.push(`【账户: ${acct.accountId}】`);
    if (acct.name) lines.push(`  名称:     ${acct.name}`);
    lines.push(`  App ID:   ${acct.appId}`);
    lines.push(`  品牌:     ${acct.brand}`);
    lines.push('');
    for (const c of acct.checks) {
      lines.push(formatCheck(c));
    }
    lines.push('');
  }

  // Tools
  lines.push('【工具注册】');
  if (report.toolsRegistered.length > 0) {
    lines.push(`  ${report.toolsRegistered.join(', ')}`);
    lines.push(`  共 ${report.toolsRegistered.length} 个`);
  } else {
    lines.push('  无工具注册（未找到已配置的账户）');
  }
  lines.push('');

  // Recent errors
  if (report.recentErrors.length > 0) {
    lines.push(`【最近错误】(${report.recentErrors.length} 条)`);
    for (let i = 0; i < report.recentErrors.length; i++) {
      lines.push(`  ${i + 1}. ${report.recentErrors[i]}`);
    }
    lines.push('');
  }

  // Overall
  const statusMap = {
    healthy: 'HEALTHY',
    degraded: 'DEGRADED (存在警告)',
    unhealthy: 'UNHEALTHY (存在失败项)',
  };
  lines.push(sep);
  lines.push(`  总体状态: ${statusMap[report.overallStatus]}`);
  lines.push(sep);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Formatting — ANSI colored (CLI)
// ---------------------------------------------------------------------------

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
};

const STATUS_LABEL_CLI: Record<CheckStatus, string> = {
  pass: `${ANSI.green}[PASS]${ANSI.reset}`,
  warn: `${ANSI.yellow}[WARN]${ANSI.reset}`,
  fail: `${ANSI.red}[FAIL]${ANSI.reset}`,
  skip: `${ANSI.gray}[SKIP]${ANSI.reset}`,
};

function formatCheckCli(c: DiagCheckResult): string {
  let line = `  ${STATUS_LABEL_CLI[c.status]} ${c.name}: ${c.message}`;
  if (c.details) {
    line += `\n         ${ANSI.gray}${c.details}${ANSI.reset}`;
  }
  return line;
}

// ---------------------------------------------------------------------------
// Trace by message_id
// ---------------------------------------------------------------------------

/**
 * Extract all log lines tagged with a specific message_id from gateway.log.
 *
 * Scans the last 1MB of the log file for lines containing `[msg:{messageId}]`.
 * Returns matching lines in chronological order.
 */
export async function traceByMessageId(messageId: string): Promise<string[]> {
  const logPath = path.join(os.homedir(), '.openclaw', 'logs', 'gateway.log');
  try {
    await fs.access(logPath);
  } catch {
    return [];
  }

  const TRACE_READ_BYTES = 1024 * 1024; // 1MB — more than extractRecentErrors
  try {
    const stat = await fs.stat(logPath);
    const readSize = Math.min(stat.size, TRACE_READ_BYTES);
    const fd = await fs.open(logPath, 'r');
    try {
      const buffer = Buffer.alloc(readSize);
      await fd.read(buffer, 0, readSize, Math.max(0, stat.size - readSize));
      const content = buffer.toString('utf-8');
      const needle = `[msg:${messageId}]`;
      return content.split('\n').filter((line) => line.includes(needle));
    } finally {
      await fd.close();
    }
  } catch {
    return [];
  }
}

/**
 * Format trace output for CLI display.
 */
export function formatTraceOutput(lines: string[], messageId: string): string {
  const sep = '────────────────────────────────';

  if (lines.length === 0) {
    return [
      sep,
      `  未找到 ${messageId} 的追踪日志`,
      '',
      '  可能原因:',
      '  1. 该消息尚未被处理',
      '  2. 日志已被轮转',
      '  3. 追踪功能未启用（需要更新插件版本）',
      sep,
    ].join('\n');
  }

  const header = `追踪 ${messageId} 的处理链路 (${lines.length} 条日志):`;
  const output: string[] = [header, sep];
  for (const line of lines) {
    output.push(line);
  }
  output.push(sep);
  return output.join('\n');
}

// ---------------------------------------------------------------------------
// Trace analysis
// ---------------------------------------------------------------------------

/** Parsed trace event extracted from a log line. */
interface TraceEvent {
  timestamp: Date;
  raw: string;
  /** The message body after the trace prefix. */
  body: string;
}

/** Classification of a trace event. */
type EventKind =
  | 'received'
  | 'sender_resolved'
  | 'rejected'
  | 'dispatching'
  | 'dispatch_complete'
  | 'card_created'
  | 'card_sent'
  | 'card_stream'
  | 'card_stream_fail'
  | 'card_settings'
  | 'card_update'
  | 'card_fallback'
  | 'reply_completed'
  | 'reply_error'
  | 'tool_call'
  | 'tool_done'
  | 'tool_fail'
  | 'other';

function classifyEvent(body: string): EventKind {
  if (body.startsWith('received from')) return 'received';
  if (body.startsWith('sender resolved')) return 'sender_resolved';
  if (body.startsWith('rejected:')) return 'rejected';
  if (body.startsWith('dispatching to agent')) return 'dispatching';
  if (body.startsWith('dispatch complete')) return 'dispatch_complete';
  if (body.startsWith('card entity created')) return 'card_created';
  if (body.startsWith('card message sent')) return 'card_sent';
  if (body.startsWith('cardkit cardElement.content:')) return 'card_stream';
  if (body.startsWith('card stream update failed')) return 'card_stream_fail';
  if (body.startsWith('cardkit card.settings:')) return 'card_settings';
  if (body.startsWith('cardkit card.update:')) return 'card_update';
  if (body.startsWith('card creation failed')) return 'card_fallback';
  if (body.startsWith('reply completed')) return 'reply_completed';
  if (body.startsWith('reply error')) return 'reply_error';
  if (body.startsWith('tool call:')) return 'tool_call';
  if (body.startsWith('tool done:')) return 'tool_done';
  if (body.startsWith('tool fail:')) return 'tool_fail';
  return 'other';
}

const EVENT_LABEL: Partial<Record<EventKind, string>> = {
  received: '消息接收',
  sender_resolved: 'Sender 解析',
  rejected: '消息拒绝',
  dispatching: '分发到 Agent',
  dispatch_complete: 'Agent 处理完成',
  card_created: '卡片创建',
  card_sent: '卡片消息发送',
  card_stream: '流式更新',
  card_stream_fail: '流式更新失败',
  card_settings: '卡片设置',
  card_update: '卡片最终更新',
  card_fallback: '卡片降级',
  reply_completed: '回复完成',
  reply_error: '回复错误',
  tool_call: '工具调用',
  tool_done: '工具完成',
  tool_fail: '工具失败',
};

/** Expected stages in a normal message processing flow. */
const EXPECTED_STAGES: { kind: EventKind; label: string }[] = [
  { kind: 'received', label: '消息接收 (received from)' },
  { kind: 'dispatching', label: '分发到 Agent (dispatching to agent)' },
  { kind: 'card_created', label: '卡片创建 (card entity created)' },
  { kind: 'card_sent', label: '卡片消息发送 (card message sent)' },
  { kind: 'card_stream', label: '流式输出 (cardElement.content)' },
  { kind: 'dispatch_complete', label: '处理完成 (dispatch complete)' },
  { kind: 'reply_completed', label: '回复收尾 (reply completed)' },
];

/** Time gap thresholds (ms) for performance warnings. */
const PERF_THRESHOLDS: { from: EventKind; to: EventKind; warnMs: number; label: string }[] = [
  { from: 'received', to: 'dispatching', warnMs: 500, label: '消息接收 → 分发' },
  { from: 'dispatching', to: 'card_created', warnMs: 5000, label: '分发 → 卡片创建' },
  { from: 'card_created', to: 'card_stream', warnMs: 30000, label: '卡片创建 → 首次流式输出' },
];

function parseTraceLines(lines: string[]): TraceEvent[] {
  const events: TraceEvent[] = [];
  // Match: 2026-02-13T12:42:04.682Z [feishu] feishu[...][msg:...]: <body>
  const re = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s.*?\]:\s(.+)$/;
  for (const line of lines) {
    const m = line.match(re);
    if (m) {
      events.push({ timestamp: new Date(m[1]), raw: line, body: m[2] });
    }
  }
  return events;
}

/**
 * Analyze trace log lines and produce a structured CLI report.
 */
export function analyzeTrace(lines: string[], _messageId: string): string {
  const events = parseTraceLines(lines);
  if (events.length === 0) {
    return `无法解析日志行，请确认日志格式正确。`;
  }

  const out: string[] = [];
  const sep = '────────────────────────────────';
  const startTime = events[0].timestamp.getTime();
  const totalMs = events[events.length - 1].timestamp.getTime() - startTime;

  // ── Section 1: Timeline ──
  out.push('');
  out.push(`${ANSI.bold}【时间线】${ANSI.reset} (${events.length} 条日志，跨度 ${(totalMs / 1000).toFixed(1)}s)`);
  out.push(sep);

  let prevMs = startTime;
  // Collapse consecutive card_stream events
  let streamCount = 0;
  let streamFirstSeq = '';
  let streamLastSeq = '';

  function flushStream() {
    if (streamCount > 0) {
      const label =
        streamCount === 1
          ? `  ${ANSI.gray}...${ANSI.reset} 流式更新 seq=${streamFirstSeq}`
          : `  ${ANSI.gray}...${ANSI.reset} 流式更新 x${streamCount} (seq=${streamFirstSeq}~${streamLastSeq})`;
      out.push(label);
      streamCount = 0;
    }
  }

  for (const ev of events) {
    const kind = classifyEvent(ev.body);
    const deltaMs = ev.timestamp.getTime() - prevMs;
    prevMs = ev.timestamp.getTime();
    const offsetMs = ev.timestamp.getTime() - startTime;
    const offsetStr = `+${offsetMs}ms`.padStart(10);

    // Collapse card_stream
    if (kind === 'card_stream') {
      const seqMatch = ev.body.match(/seq=(\d+)/);
      const seq = seqMatch ? seqMatch[1] : '?';
      if (streamCount === 0) streamFirstSeq = seq;
      streamLastSeq = seq;
      streamCount++;
      continue;
    }
    flushStream();

    const label = EVENT_LABEL[kind] ?? kind;
    const gapWarn = deltaMs > 5000 ? ` ${ANSI.yellow}⚠ ${(deltaMs / 1000).toFixed(1)}s${ANSI.reset}` : '';

    // Marker for errors
    let marker = '  ';
    if (
      kind === 'rejected' ||
      kind === 'reply_error' ||
      kind === 'tool_fail' ||
      kind === 'card_stream_fail' ||
      kind === 'card_fallback'
    ) {
      marker = `${ANSI.red}✘ ${ANSI.reset}`;
    } else if (kind === 'tool_call') {
      marker = '→ ';
    }

    // Extract key detail from body
    let detail = '';
    if (kind === 'received') {
      const m = ev.body.match(/from (\S+) in (\S+) \((\w+)\)/);
      if (m) detail = `sender=${m[1]}, chat=${m[2]} (${m[3]})`;
    } else if (kind === 'dispatching') {
      const m = ev.body.match(/session=(\S+)\)/);
      if (m) detail = `session=${m[1]}`;
    } else if (kind === 'dispatch_complete') {
      const m = ev.body.match(/replies=(\d+), elapsed=(\d+)ms/);
      if (m) detail = `replies=${m[1]}, elapsed=${m[2]}ms`;
    } else if (kind === 'tool_call') {
      const m = ev.body.match(/tool call: (\S+)/);
      if (m) detail = m[1];
    } else if (kind === 'tool_fail') {
      detail = ev.body.replace('tool fail: ', '');
    } else if (kind === 'card_created') {
      const m = ev.body.match(/card_id=(\S+)\)/);
      if (m) detail = `card_id=${m[1]}`;
    } else if (kind === 'reply_completed') {
      const m = ev.body.match(/elapsed=(\d+)ms/);
      if (m) detail = `elapsed=${m[1]}ms`;
    } else if (kind === 'rejected') {
      detail = ev.body.replace('rejected: ', '');
    }

    out.push(`${ANSI.gray}[${offsetStr}]${ANSI.reset} ${marker}${label}${detail ? ` — ${detail}` : ''}${gapWarn}`);
  }
  flushStream();
  out.push('');

  // ── Section 2: Anomaly detection ──
  const issues: string[] = [];
  const kindSet = new Set(events.map((e) => classifyEvent(e.body)));

  // 2.1 Missing stages
  for (const stage of EXPECTED_STAGES) {
    if (!kindSet.has(stage.kind)) {
      // dispatch_complete 和 reply_completed 缺失仅在有 dispatching 时才告警
      if ((stage.kind === 'dispatch_complete' || stage.kind === 'reply_completed') && !kindSet.has('dispatching'))
        continue;
      // card 相关阶段在有 rejected 时不告警
      if (
        (stage.kind === 'card_created' || stage.kind === 'card_sent' || stage.kind === 'card_stream') &&
        kindSet.has('rejected')
      )
        continue;
      issues.push(`缺失阶段: ${stage.label}`);
    }
  }

  // 2.2 Errors
  for (const ev of events) {
    const kind = classifyEvent(ev.body);
    if (kind === 'rejected') issues.push(`消息被拒绝: ${ev.body.replace('rejected: ', '')}`);
    if (kind === 'reply_error') issues.push(`回复错误: ${ev.body}`);
    if (kind === 'tool_fail') issues.push(`工具失败: ${ev.body}`);
    if (kind === 'card_stream_fail') issues.push(`流式更新失败: ${ev.body}`);
    if (kind === 'card_fallback') issues.push(`卡片降级: ${ev.body}`);

    // CardKit non-zero code
    if (kind === 'card_stream' || kind === 'card_update' || kind === 'card_settings' || kind === 'card_created') {
      const codeMatch = ev.body.match(/code=(\d+)/);
      if (codeMatch && codeMatch[1] !== '0') {
        issues.push(`API 返回错误码: code=${codeMatch[1]} — ${ev.body}`);
      }
    }
  }

  // 2.3 Performance thresholds
  const firstByKind = new Map<EventKind, TraceEvent>();
  for (const ev of events) {
    const kind = classifyEvent(ev.body);
    if (!firstByKind.has(kind)) firstByKind.set(kind, ev);
  }
  for (const rule of PERF_THRESHOLDS) {
    const from = firstByKind.get(rule.from);
    const to = firstByKind.get(rule.to);
    if (from && to) {
      const gap = to.timestamp.getTime() - from.timestamp.getTime();
      if (gap > rule.warnMs) {
        issues.push(
          `性能警告: ${rule.label} 耗时 ${(gap / 1000).toFixed(1)}s（阈值 ${(rule.warnMs / 1000).toFixed(0)}s）`,
        );
      }
    }
  }

  // 2.4 Duplicate delivery
  const receivedCount = events.filter((e) => classifyEvent(e.body) === 'received').length;
  if (receivedCount > 1) {
    issues.push(`重复投递: 同一消息被接收 ${receivedCount} 次（WebSocket 重投递）`);
  }

  // 2.5 Card stream continuity
  const streamSeqs: number[] = [];
  for (const ev of events) {
    if (classifyEvent(ev.body) === 'card_stream') {
      const m = ev.body.match(/seq=(\d+)/);
      if (m) streamSeqs.push(parseInt(m[1], 10));
    }
  }
  if (streamSeqs.length > 1) {
    for (let i = 1; i < streamSeqs.length; i++) {
      if (streamSeqs[i] !== streamSeqs[i - 1] + 1) {
        issues.push(
          `流式 seq 不连续: seq=${streamSeqs[i - 1]} → seq=${streamSeqs[i]}（跳过了 ${streamSeqs[i] - streamSeqs[i - 1] - 1} 个）`,
        );
        break;
      }
    }
  }

  out.push(`${ANSI.bold}【异常检测】${ANSI.reset}`);
  out.push(sep);
  if (issues.length === 0) {
    out.push(`  ${ANSI.green}未发现异常${ANSI.reset}`);
  } else {
    for (let i = 0; i < issues.length; i++) {
      const isError =
        issues[i].startsWith('工具失败') ||
        issues[i].startsWith('回复错误') ||
        issues[i].startsWith('API 返回错误码') ||
        issues[i].startsWith('流式更新失败');
      const color = isError ? ANSI.red : ANSI.yellow;
      out.push(`  ${color}${i + 1}. ${issues[i]}${ANSI.reset}`);
    }
  }
  out.push('');

  // ── Section 3: Diagnosis ──
  out.push(`${ANSI.bold}【诊断总结】${ANSI.reset}`);
  out.push(sep);

  const hasError = issues.some(
    (i) =>
      i.startsWith('工具失败') ||
      i.startsWith('回复错误') ||
      i.startsWith('API 返回错误码') ||
      i.startsWith('流式更新失败') ||
      i.startsWith('缺失阶段'),
  );
  const hasWarn = issues.length > 0;

  if (!hasWarn) {
    out.push(`  状态: ${ANSI.green}✓ 正常${ANSI.reset}`);
    out.push(`  消息处理链路完整，全程耗时 ${(totalMs / 1000).toFixed(1)}s。`);

    // Break down time
    const dispatchComplete = events.find(
      (e) =>
        classifyEvent(e.body) === 'dispatch_complete' && e.body.includes('replies=') && !e.body.includes('replies=0'),
    );
    if (dispatchComplete) {
      const m = dispatchComplete.body.match(/elapsed=(\d+)ms/);
      if (m) {
        out.push(`  其中 Agent 处理耗时 ${(parseInt(m[1], 10) / 1000).toFixed(1)}s（含 AI 推理 + 工具调用）。`);
      }
    }
  } else if (hasError) {
    out.push(`  状态: ${ANSI.red}✘ 异常${ANSI.reset}`);
    out.push(`  发现 ${issues.length} 个问题，需要排查。`);
  } else {
    out.push(`  状态: ${ANSI.yellow}⚠ 有警告${ANSI.reset}`);
    out.push(`  发现 ${issues.length} 个警告，功能可用但需关注。`);
  }
  out.push('');

  return out.join('\n');
}

export function formatDiagReportCli(report: DiagReport): string {
  const lines: string[] = [];
  const sep = '====================================';

  lines.push(sep);
  lines.push(`  ${ANSI.bold}飞书插件诊断报告${ANSI.reset}`);
  lines.push(`  ${report.timestamp}`);
  lines.push(sep);
  lines.push('');

  // Environment
  lines.push(`${ANSI.bold}【环境信息】${ANSI.reset}`);
  lines.push(`  Node.js:     ${report.environment.nodeVersion}`);
  lines.push(`  插件版本:    ${report.environment.pluginVersion}`);
  lines.push(`  系统:        ${report.environment.platform} ${report.environment.arch}`);
  lines.push('');

  // Global checks
  lines.push(`${ANSI.bold}【全局检查】${ANSI.reset}`);
  for (const c of report.checks) {
    lines.push(formatCheckCli(c));
  }
  lines.push('');

  // Per-account
  for (const acct of report.accounts) {
    lines.push(`${ANSI.bold}【账户: ${acct.accountId}】${ANSI.reset}`);
    if (acct.name) lines.push(`  名称:     ${acct.name}`);
    lines.push(`  App ID:   ${acct.appId}`);
    lines.push(`  品牌:     ${acct.brand}`);
    lines.push('');
    for (const c of acct.checks) {
      lines.push(formatCheckCli(c));
    }
    lines.push('');
  }

  // Tools
  lines.push(`${ANSI.bold}【工具注册】${ANSI.reset}`);
  if (report.toolsRegistered.length > 0) {
    lines.push(`  ${report.toolsRegistered.join(', ')}`);
    lines.push(`  共 ${report.toolsRegistered.length} 个`);
  } else {
    lines.push('  无工具注册（未找到已配置的账户）');
  }
  lines.push('');

  // Recent errors
  if (report.recentErrors.length > 0) {
    lines.push(`${ANSI.bold}【最近错误】${ANSI.reset}(${report.recentErrors.length} 条)`);
    for (let i = 0; i < report.recentErrors.length; i++) {
      lines.push(`  ${ANSI.gray}${i + 1}. ${report.recentErrors[i]}${ANSI.reset}`);
    }
    lines.push('');
  }

  // Overall
  const statusColorMap = {
    healthy: `${ANSI.green}HEALTHY${ANSI.reset}`,
    degraded: `${ANSI.yellow}DEGRADED (存在警告)${ANSI.reset}`,
    unhealthy: `${ANSI.red}UNHEALTHY (存在失败项)${ANSI.reset}`,
  };
  lines.push(sep);
  lines.push(`  总体状态: ${statusColorMap[report.overallStatus]}`);
  lines.push(sep);

  return lines.join('\n');
}
