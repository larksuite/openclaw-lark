/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Streaming card controller for the Lark/Feishu channel plugin.
 *
 * Manages the full lifecycle of a streaming CardKit card:
 * idle → creating → streaming → completed / aborted / terminated.
 *
 * Delegates throttling to FlushController and message-unavailable
 * detection to UnavailableGuard.
 */

import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
// eslint-disable-next-line n/no-unsupported-features/node-builtins
import { DatabaseSync } from 'node:sqlite';
import { resolveDefaultAgentId } from 'openclaw/plugin-sdk/agent-runtime';
import { getSessionEntry, resolveStorePath } from 'openclaw/plugin-sdk/session-store-runtime';
import type { ReplyPayload } from 'openclaw/plugin-sdk/core';
import { SILENT_REPLY_TOKEN } from 'openclaw/plugin-sdk/reply-runtime';
import { extractLarkApiCode } from '../core/api-error';
import { larkLogger } from '../core/lark-logger';
import { registerShutdownHook } from '../core/shutdown-hooks';
import { sendCardFeishu, updateCardFeishu } from '../messaging/outbound/send';
import {
  STREAMING_ELEMENT_ID,
  buildCardContent,
  buildStreamingPreAnswerCard,
  buildStreamingThinkingCard,
  splitReasoningText,
  stripReasoningTags,
  toCardKit2,
} from './builder';
import {
  FEISHU_CARD_TABLE_LIMIT,
  isCardRateLimitError,
  isCardTableLimitError,
  sanitizeTextSegmentsForCard,
} from './card-error';
import {
  createCardEntity,
  sendCardByCardId,
  setCardStreamingMode,
  streamCardContent,
  updateCardKitCard,
} from './cardkit';
import { FlushController } from './flush-controller';
import { ImageResolver } from './image-resolver';
import { optimizeMarkdownStyle } from './markdown-style';
import { type ToolUseDisplayResult, buildToolUseTitleSuffix, normalizeToolUseDisplay } from './tool-use-display';
import { clearToolUseTraceRun, getToolUseTraceSteps } from './tool-use-trace-store';
import type {
  CardKitState,
  CardPhase,
  FooterSessionMetrics,
  ReasoningState,
  StreamingCardDeps,
  StreamingTextState,
  TerminalReason,
  ToolUseState,
} from './reply-dispatcher-types';
import {
  EMPTY_REPLY_FALLBACK_TEXT,
  PHASE_TRANSITIONS,
  TERMINAL_PHASES,
  THROTTLE_CONSTANTS,
} from './reply-dispatcher-types';
import { UnavailableGuard } from './unavailable-guard';

const log = larkLogger('card/streaming');

interface TerminalCardTextImageResolver {
  resolveImages(text: string): string;
}

interface TerminalCardContentInput {
  text: string;
  reasoningText?: string;
}

// ---------------------------------------------------------------------------
// StreamingCardController
// ---------------------------------------------------------------------------

/** 从会话条目提取页脚指标；只要存在任一指标字段即返回，否则返回 undefined。 */
function extractFooterSessionMetrics(entry: Record<string, unknown>): FooterSessionMetrics | undefined {
  const metrics: FooterSessionMetrics = {
    inputTokens: typeof entry.inputTokens === 'number' ? entry.inputTokens : undefined,
    outputTokens: typeof entry.outputTokens === 'number' ? entry.outputTokens : undefined,
    cacheRead: typeof entry.cacheRead === 'number' ? entry.cacheRead : undefined,
    cacheWrite: typeof entry.cacheWrite === 'number' ? entry.cacheWrite : undefined,
    totalTokens: typeof entry.totalTokens === 'number' ? entry.totalTokens : undefined,
    totalTokensFresh: typeof entry.totalTokensFresh === 'boolean' ? entry.totalTokensFresh : undefined,
    contextTokens: typeof entry.contextTokens === 'number' ? entry.contextTokens : undefined,
    model: typeof entry.model === 'string' ? entry.model : undefined,
  };
  const hasAny = Object.values(metrics).some((v) => v !== undefined);
  return hasAny ? metrics : undefined;
}

/**
 * 从 sessions.json store 路径推导 per-agent SQLite 库路径。
 * 与 openclaw 9.7 内部 resolveUnsuffixedSqliteTargetFromSessionStorePath 逻辑一致：
 * <stateDir>/agents/<agentId>/sessions/sessions.json → <stateDir>/agents/<agentId>/agent/openclaw-agent.sqlite
 */
function resolveSqlitePathFromStorePath(storePath: string): string {
  const resolvedPath = resolve(storePath);
  if (resolvedPath.endsWith('.sqlite')) return resolvedPath;
  const sessionsDir = dirname(resolvedPath);
  if (basename(resolvedPath) !== 'sessions.json') return join(sessionsDir, 'openclaw-agent.sqlite');
  if (basename(sessionsDir) !== 'sessions') return join(sessionsDir, 'openclaw-agent.sqlite');
  const agentDir = dirname(sessionsDir);
  if (basename(dirname(agentDir)) !== 'agents') return join(sessionsDir, 'openclaw-agent.sqlite');
  return join(agentDir, 'agent', 'openclaw-agent.sqlite');
}

/**
 * v6：直读会话库（绕开 9.7 SDK 的复制快照机制）。
 * 9.7 的 getSessionEntry 内部把源库复制到临时目录做只读快照（createStableReadOnlyCopyInTempDirectory），
 * 宿主高频写活库时快照反复失败（SqliteSourceChangedError → "did not stabilize after 10 read-only
 * inspection attempts"）→ 永远读不到。这里用 node:sqlite 直接以只读方式打开主库查询——
 * SQLite 本身支持并发读（WAL 模式），读操作不会与宿主写操作互斥，稳定可靠。
 */
function directReadSessionEntryViaSqlite(storePath: string, sessionKey: string): Record<string, unknown> | undefined {
  try {
    const sqlitePath = resolveSqlitePathFromStorePath(storePath);
    if (!existsSync(sqlitePath)) return undefined;
    const db = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
      const row = db
        .prepare('SELECT entry_json FROM session_entries WHERE session_key = ?')
        .get(sessionKey) as { entry_json?: unknown } | undefined;
      if (!row || typeof row.entry_json !== 'string' || !row.entry_json) return undefined;
      const parsed: unknown = JSON.parse(row.entry_json);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
    } finally {
      try {
        db.close();
      } catch {
        // 忽略关闭异常
      }
    }
  } catch (err) {
    log.debug('footer metrics direct sqlite read failed', { storePath, sessionKey, error: String(err) });
    return undefined;
  }
}

export class StreamingCardController {
  // ---- Explicit state machine ----
  private phase: CardPhase = 'idle';

  // ---- Structured state ----
  private cardKit: CardKitState = {
    cardKitCardId: null,
    originalCardKitCardId: null,
    cardKitSequence: 0,
    cardMessageId: null,
  };
  private text: StreamingTextState = {
    accumulatedText: '',
    completedText: '',
    streamingPrefix: '',
    lastPartialText: '',
    lastFlushedText: '',
  };

  private reasoning: ReasoningState = {
    accumulatedReasoningText: '',
    reasoningStartTime: null,
    reasoningElapsedMs: 0,
    isReasoningPhase: false,
  };

  private toolUse: ToolUseState = {
    startedAt: null,
    elapsedMs: 0,
    isActive: false,
  };
  // ---- Sub-controllers ----
  private readonly flush: FlushController;
  private readonly guard: UnavailableGuard;
  private readonly imageResolver: ImageResolver;

  // ---- Lifecycle ----
  private createEpoch = 0;
  private _terminalReason: TerminalReason | null = null;
  private dispatchFullyComplete = false;
  private cardCreationPromise: Promise<void> | null = null;
  private disposeShutdownHook: (() => void) | null = null;
  // v9：footer 回填生命周期控制。宿主 shutdown/插件卸载时统一 abort 未完成回填，
  // 避免"卸载后仍跑 30 秒"的迟到卡片更新与误报警。
  private readonly footerBackfillControllers = new Set<AbortController>();
  private disposeFooterMetricsHook: (() => void) | null = null;
  private readonly dispatchStartTime = Date.now();

  // ---- Injected dependencies ----
  private readonly deps: StreamingCardDeps;

  private elapsed(): number {
    return Date.now() - this.dispatchStartTime;
  }

  private needsFooterMetrics(): boolean {
    const footer = this.deps.resolvedFooter;
    return footer.tokens || footer.cache || footer.context || footer.model;
  }

  private async getFooterSessionMetrics(opts?: {
    maxAttempts?: number;
    intervalMs?: number;
    signal?: AbortSignal;
  }): Promise<FooterSessionMetrics | undefined> {
    const signal = opts?.signal;
    // v9：delay 可被 signal 打断——shutdown 钩子 abort 后立即停止轮询，
    // 不再等满 5.2s/30s 窗口。
    const delay = (ms: number) =>
      new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        const t = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          resolve();
        }, { once: true });
      });
    const FOOTER_METRICS_POLL_ATTEMPTS = 13; // 13 × 400ms ≈ 5.2s 窗口
    const FOOTER_METRICS_POLL_INTERVAL_MS = 400;
    const maxAttempts = opts?.maxAttempts ?? FOOTER_METRICS_POLL_ATTEMPTS;
    const intervalMs = opts?.intervalMs ?? FOOTER_METRICS_POLL_INTERVAL_MS;
    try {
      const cfgWithSession = this.deps.cfg as { sessions?: { store?: string }; session?: { store?: string } };
      const sessionStorePath = cfgWithSession.sessions?.store ?? cfgWithSession.session?.store;
      const key = this.deps.sessionKey.trim().toLowerCase();

      // WORKAROUND: SDK session key round-trip bug.
      // The SDK's toAgentRequestSessionKey() strips the agent scope from keys
      // like "agent:hr:main" → "main", then toAgentStoreSessionKey() rebuilds
      // using the default agent ID → "agent:main:main".  This means metrics
      // written by the SDK always land under "agent:<defaultAgentId>:…"
      // regardless of the account-scoped agent ID the plugin routing generated.
      // Fallback: when the primary key misses, try replacing the agent-id
      // segment with the resolved default agent ID.
      // TODO: remove once the SDK preserves the original agent ID during the
      // request→store key round-trip.
      let defaultAgentId: string | undefined;
      try {
        defaultAgentId = resolveDefaultAgentId(this.deps.cfg as Record<string, unknown>);
      } catch (err) {
        // v7：explicit 多 Agent 归属下 resolveDefaultAgentId 必然抛 AgentSelectionRequiredError
        // （它只认唯一 Agent 或 default:true，不读 agents.defaults.systemAgent.agentId=main）。
        // 回退到当前会话路由的 agentId，保证 footer 读取不被中止。
        defaultAgentId = this.deps.agentId;
        log.warn('footer metrics: resolveDefaultAgentId failed, falling back to session agentId', {
          agentId: this.deps.agentId,
          error: String(err),
        });
      }
      const fallbackKey = defaultAgentId
        ? key.replace(/^(agent):[^:]+:/, `$1:${defaultAgentId}:`)
        : key;
      const candidateKeys = Array.from(new Set([key, fallbackKey]));

      // v2 加固：多作用域（本 agent / 默认 agent / 不限定）+ 多路径（配置路径 / 默认路径）+ 短重试。
      // 9.7 宿主可能按默认 agent 写入会话，或指标落盘略晚于完成回调，逐项兜底。
      // v4 加固：服务器实测（小七实证）确认——9.7 宿主在卡片定稿后才把 model/tokens
      // 等指标写入会话条目（定稿时字段为空，落库后才有值）。因此重试窗口从 ~0.8s
      // 加长到 ~5s（每 400ms 轮询），确保卡片发送前能等到宿主落库。
      // v8 削峰：组合去重。v7 回退后 defaultAgentId === this.deps.agentId（相同），
      // 两个 storePath 推导也可能相同——Set 去重把每轮 3×2×2=12 组合降到最少 2 组合，
      // 全 miss 的最坏路径开库/SDK 探测量随之下一个数量级。
      const agentScopes = Array.from(new Set([this.deps.agentId, defaultAgentId, undefined]));
      const storePaths = Array.from(
        new Set([
          resolveStorePath(sessionStorePath, { agentId: this.deps.agentId }),
          resolveStorePath(undefined, { agentId: this.deps.agentId }),
        ]),
      );
      log.debug('footer metrics: probing session store', {
        sessionKey: this.deps.sessionKey,
        agentId: this.deps.agentId,
        defaultAgentId,
        storePaths,
        candidateKeys,
        maxAttempts,
        intervalMs,
        cwd: process.cwd(),
      });

      // v8 削峰：每轮 SDK 只探测主组合一次（其余组合仅直读）。
      // 直读与 SDK 读同一底层数据（主库 vs 快照副本）——数据未落库时 SDK 必 miss，
      // 原实现每组合都调 SDK 造成最坏路径 720 次快照复制；降为每轮 1 次（≤60 次），
      // 仍保留 SDK 内部路径推导差异的兜底能力。
      let sdkProbeDone = false;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (signal?.aborted) return undefined; // v9：shutdown 中止
        for (const agentId of agentScopes) {
          for (const storePath of storePaths) {
            for (const candidate of candidateKeys) {
              // v6：直读优先。9.7 的 getSessionEntry 内部复制源库做只读快照，
              // 宿主高频写活库时快照不稳定（did not stabilize after 10 attempts）→ 返回 undefined。
              // node:sqlite 直读主库（SQLite 并发读安全）稳定，先试直读再走 SDK 兜底。
              const directEntry = directReadSessionEntryViaSqlite(storePath, candidate);
              if (directEntry) {
                const directMetrics = extractFooterSessionMetrics(directEntry);
                if (directMetrics) {
                  log.debug('footer metrics lookup: direct sqlite hit', {
                    sessionKey: this.deps.sessionKey,
                    matchedKey: candidate,
                    agentId: agentId ?? '(default)',
                    storePath,
                    sqlitePath: resolveSqlitePathFromStorePath(storePath),
                    attempt,
                  });
                  return directMetrics;
                }
              }
              if (!sdkProbeDone && storePath === storePaths[0] && candidate === candidateKeys[0]) {
                sdkProbeDone = true;
                let entry: Record<string, unknown> | undefined;
                try {
                  entry = getSessionEntry(
                    agentId === undefined
                      ? { storePath, sessionKey: candidate }
                      : { agentId, storePath, sessionKey: candidate },
                  ) as Record<string, unknown> | undefined;
                } catch {
                  continue; // 该作用域不可读，跳过
                }
                if (!entry) continue;
                const metrics = extractFooterSessionMetrics(entry);
                if (metrics) {
                  log.debug('footer metrics lookup: session entry found', {
                    sessionKey: this.deps.sessionKey,
                    matchedKey: candidate,
                    agentId: agentId ?? '(default)',
                    storePath,
                    attempt,
                  });
                  return metrics;
                }
              }
            }
          }
        }
        if (attempt < maxAttempts - 1) await delay(intervalMs);
      }
      log.warn('footer metrics lookup: session entry missing', {
        sessionKey: this.deps.sessionKey,
        candidateKeys,
        agentScopes,
        storePaths,
        maxAttempts,
      });
      return undefined;
    } catch (err) {
      log.warn('footer metrics lookup failed', { error: String(err), sessionKey: this.deps.sessionKey });
      return undefined;
    }
  }

  /**
   * v5：卡片先发、指标后补。
   * 9.7 宿主在回复交付收尾阶段（晚于插件 onComplete/onIdle）才通过
   * recordReplyUsageState() 把用量写入会话库，因此 finalize 时同步读必为空。
   * 这里用后台任务继续长轮询（最长 ~15s），拿到指标后重建卡片并更新已发送的卡片。
   */
  private scheduleFooterMetricsBackfill(params: {
    logTag: string;
    cardId: string | null | undefined;
    messageId: string;
    isCardKit: boolean;
    build: (metrics: FooterSessionMetrics | undefined) => ReturnType<typeof buildCardContent>;
  }): void {
    // v9：接入生命周期。每次回填创建 AbortController 并登记；首次使用时懒注册
    // shutdown 钩子，宿主关闭时统一 abort 所有未完成回填。正常结束（命中/超时）
    // 在 finally 中自动移除登记。
    const controller = new AbortController();
    this.footerBackfillControllers.add(controller);
    if (!this.disposeFooterMetricsHook) {
      this.disposeFooterMetricsHook = registerShutdownHook('streaming-card:footer-metrics', async () => {
        for (const c of this.footerBackfillControllers) c.abort();
      });
    }
    void (async () => {
      try {
        log.debug(`footer metrics backfill: started (${params.logTag})`, {
          messageId: params.messageId,
          cardId: params.cardId ?? null,
          isCardKit: params.isCardKit,
        });
        const metrics = await this.getFooterSessionMetrics({
          maxAttempts: 60,
          intervalMs: 500,
          signal: controller.signal,
        });
        if (!metrics) {
          // v9：新会话/无指标属正常现象（首轮无落库），降 debug；真正异常由
          // lookup failed / backfill failed / resolveDefaultAgentId 失败三条 warn 覆盖。
          log.debug(`footer metrics backfill: not available after polling (${params.logTag})`);
          return;
        }
        const card = params.build(metrics);
        if (params.isCardKit && params.cardId) {
          const sequence = this.cardKit.cardKitSequence + 1;
          this.cardKit.cardKitSequence = sequence;
          await updateCardKitCard({
            cfg: this.deps.cfg,
            cardId: params.cardId,
            card: toCardKit2(card),
            sequence,
            accountId: this.deps.accountId,
          });
        } else {
          await updateCardFeishu({
            cfg: this.deps.cfg,
            messageId: params.messageId,
            card: card as unknown as Record<string, unknown>,
            accountId: this.deps.accountId,
          });
        }
        log.debug(`footer metrics backfill: card updated (${params.logTag})`, {
          matchedKey: this.deps.sessionKey,
        });
      } catch (err) {
        log.warn(`footer metrics backfill failed (${params.logTag})`, { error: String(err) });
      } finally {
        this.footerBackfillControllers.delete(controller);
      }
    })();
  }

  constructor(deps: StreamingCardDeps) {
    this.deps = deps;

    this.guard = new UnavailableGuard({
      replyToMessageId: deps.replyToMessageId,
      getCardMessageId: () => this.cardKit.cardMessageId,
      onTerminate: () => {
        this.transition('terminated', 'UnavailableGuard', 'unavailable');
      },
    });

    this.flush = new FlushController(() => this.performFlush());

    this.imageResolver = new ImageResolver({
      cfg: deps.cfg,
      accountId: deps.accountId,
      onImageResolved: () => {
        if (!this.isTerminalPhase && this.cardKit.cardMessageId) {
          void this.throttledCardUpdate();
        }
      },
    });
  }

  // ------------------------------------------------------------------
  // Public accessors
  // ------------------------------------------------------------------

  get cardMessageId(): string | null {
    return this.cardKit.cardMessageId;
  }

  get isTerminalPhase(): boolean {
    return TERMINAL_PHASES.has(this.phase);
  }

  /**
   * Whether the card has been explicitly aborted (via abortCard()).
   *
   * Distinct from isTerminalPhase — creation_failed is NOT an abort;
   * it should allow fallthrough to static delivery in the factory.
   */
  get isAborted(): boolean {
    return this.phase === 'aborted';
  }

  /** Whether the reply pipeline was terminated due to an unavailable message. */
  get isTerminated(): boolean {
    return this.guard.isTerminated;
  }

  /** Check if the pipeline should skip further operations for this source. */
  shouldSkipForUnavailable(source: string): boolean {
    return this.guard.shouldSkip(source);
  }

  /** Attempt to terminate the pipeline due to an unavailable message error. */
  terminateIfUnavailable(source: string, err?: unknown): boolean {
    return this.guard.terminate(source, err);
  }

  /** Why the controller entered a terminal phase, or null if still active. */
  get terminalReason(): TerminalReason | null {
    return this._terminalReason;
  }

  /** @internal — exposed for test assertions only. */
  get currentPhase(): CardPhase {
    return this.phase;
  }

  private get shouldDisplayToolUse(): boolean {
    return this.deps.toolUseDisplay.showToolUse;
  }

  private computeToolUseDisplay(): ToolUseDisplayResult | null {
    if (!this.shouldDisplayToolUse) return null;
    const traceSteps = getToolUseTraceSteps(this.deps.sessionKey);
    return normalizeToolUseDisplay({
      traceSteps,
      showFullPaths: this.deps.toolUseDisplay.showFullPaths,
      showResultDetails: this.deps.toolUseDisplay.showToolResultDetails,
    });
  }

  private get visibleToolUseElapsedMs(): number | undefined {
    if (!this.shouldDisplayToolUse || !this.toolUse.startedAt) {
      return undefined;
    }
    return this.toolUse.elapsedMs || Date.now() - this.toolUse.startedAt;
  }

  private computeToolUseTitleSuffix(display: ToolUseDisplayResult | null): { zh: string; en: string } | undefined {
    if (!this.shouldDisplayToolUse) return undefined;
    const stepCount = display?.stepCount ?? 0;
    return stepCount > 0 ? buildToolUseTitleSuffix({ stepCount }) : undefined;
  }

  // ------------------------------------------------------------------
  // Unified callback guard
  // ------------------------------------------------------------------

  /**
   * Unified callback guard — returns true if the pipeline is active
   * and the callback should proceed.
   *
   * Combines three checks:
   * 1. guard.isTerminated — message recalled/deleted
   * 2. guard.shouldSkip(source) — eagerly detect unavailable messages
   * 3. isTerminalPhase — completed/aborted/terminated/creation_failed
   */
  private shouldProceed(source: string): boolean {
    if (this.guard.isTerminated || this.guard.shouldSkip(source)) return false;
    return !this.isTerminalPhase;
  }

  // ------------------------------------------------------------------
  // State machine
  // ------------------------------------------------------------------

  private isStaleCreate(epoch: number): boolean {
    return epoch !== this.createEpoch;
  }

  private transition(to: CardPhase, source: string, reason?: TerminalReason): boolean {
    const from = this.phase;
    if (from === to) return false;
    if (!PHASE_TRANSITIONS[from].has(to)) {
      log.warn('phase transition rejected', { from, to, source });
      return false;
    }
    this.phase = to;
    log.info('phase transition', { from, to, source, reason });
    if (TERMINAL_PHASES.has(to)) {
      this._terminalReason = reason ?? null;
      this.onEnterTerminalPhase();
    }
    return true;
  }

  private onEnterTerminalPhase(): void {
    this.createEpoch += 1;
    this.flush.cancelPendingFlush();
    this.flush.complete();
    this.disposeShutdownHook?.();
    this.disposeShutdownHook = null;
    if (this.phase === 'terminated' || this.phase === 'creation_failed') {
      clearToolUseTraceRun(this.deps.sessionKey);
    }
  }

  private markToolUseActivity(): void {
    if (!this.toolUse.startedAt) {
      this.toolUse.startedAt = Date.now();
    }
    this.toolUse.elapsedMs = Date.now() - this.toolUse.startedAt;
    this.toolUse.isActive = true;
  }

  private captureToolUseElapsed(): void {
    if (!this.toolUse.startedAt) return;
    this.toolUse.elapsedMs = Date.now() - this.toolUse.startedAt;
    this.toolUse.isActive = false;
  }

  // ------------------------------------------------------------------
  // SDK callback bindings
  // ------------------------------------------------------------------

  /**
   * Handle a deliver() call in streaming card mode.
   *
   * Accumulates text from the SDK's deliver callbacks to build the
   * authoritative "completedText" for the final card.
   */
  async onDeliver(payload: ReplyPayload): Promise<void> {
    if (!this.shouldProceed('onDeliver')) return;

    const text = payload.text ?? '';
    if (!text.trim()) return;

    await this.ensureCardCreated();
    if (!this.shouldProceed('onDeliver.postCreate')) return;

    if (!this.cardKit.cardMessageId) return;
    this.captureToolUseElapsed();

    const split = splitReasoningText(text);

    if (split.reasoningText && !split.answerText) {
      // Pure reasoning payload
      this.reasoning.reasoningElapsedMs = this.reasoning.reasoningStartTime
        ? Date.now() - this.reasoning.reasoningStartTime
        : 0;
      this.reasoning.accumulatedReasoningText = split.reasoningText;
      this.reasoning.isReasoningPhase = true;
      await this.throttledCardUpdate();
      return;
    }

    // Answer payload (may also contain inline reasoning from tags)
    this.reasoning.isReasoningPhase = false;
    if (split.reasoningText) {
      this.reasoning.accumulatedReasoningText = split.reasoningText;
    }
    const answerText = split.answerText ?? text;

    // 累积 deliver 文本用于最终卡片
    this.text.completedText += (this.text.completedText ? '\n\n' : '') + answerText;

    // 没有流式数据时，用 deliver 文本显示在卡片上
    if (!this.text.lastPartialText && !this.text.streamingPrefix) {
      this.text.accumulatedText += (this.text.accumulatedText ? '\n\n' : '') + answerText;
      this.text.streamingPrefix = this.text.accumulatedText;
      await this.throttledCardUpdate();
    }
  }

  async onReasoningStream(payload: ReplyPayload): Promise<void> {
    if (!this.shouldProceed('onReasoningStream')) return;

    await this.ensureCardCreated();
    if (!this.shouldProceed('onReasoningStream.postCreate')) return;
    if (!this.cardKit.cardMessageId) return;

    const rawText = payload.text ?? '';
    if (!rawText) return;

    if (!this.reasoning.reasoningStartTime) {
      this.reasoning.reasoningStartTime = Date.now();
    }
    this.reasoning.isReasoningPhase = true;
    const split = splitReasoningText(rawText);
    this.reasoning.accumulatedReasoningText = split.reasoningText ?? rawText;
    await this.throttledCardUpdate();
  }

  async onToolStart(payload: { name?: string; phase?: string }): Promise<void> {
    if (!this.shouldProceed('onToolStart')) return;
    if (!this.shouldDisplayToolUse) return;
    if (payload.phase && payload.phase !== 'start') return;

    this.markToolUseActivity();

    await this.ensureCardCreated();
    if (!this.shouldProceed('onToolStart.postCreate')) return;
    if (!this.cardKit.cardMessageId) return;
    if (!this.text.accumulatedText && this.cardKit.cardKitCardId) {
      await this.throttledToolUseStatusUpdate();
      return;
    }
    await this.throttledCardUpdate();
  }

  async onToolPayload(_payload: ReplyPayload): Promise<void> {
    if (!this.shouldProceed('onToolPayload')) return;
    if (!this.shouldDisplayToolUse) return;

    this.markToolUseActivity();

    await this.ensureCardCreated();
    if (!this.shouldProceed('onToolPayload.postCreate')) return;
    if (!this.cardKit.cardMessageId) return;
    if (!this.text.accumulatedText && this.cardKit.cardKitCardId) {
      await this.throttledToolUseStatusUpdate();
      return;
    }
    await this.throttledCardUpdate();
  }

  async onPartialReply(payload: ReplyPayload): Promise<void> {
    if (!this.shouldProceed('onPartialReply')) return;

    // Use splitReasoningText (consistent with onDeliver/onReasoningStream)
    // to extract <think> tag content before stripping it from the answer.
    // Previously only stripReasoningTags was called, silently discarding
    // any thinking content that the LLM wrapped in <think> tags.
    const rawText = payload.text ?? '';
    const split = splitReasoningText(rawText);
    if (split.reasoningText) {
      if (!this.reasoning.reasoningStartTime) {
        this.reasoning.reasoningStartTime = Date.now();
      }
      this.reasoning.accumulatedReasoningText = split.reasoningText;
      this.reasoning.isReasoningPhase = true;
    }
    const text = split.answerText ?? stripReasoningTags(rawText);
    log.debug('onPartialReply', { len: text.length });
    if (!text) return;

    this.captureToolUseElapsed();
    if (!this.reasoning.reasoningStartTime) {
      this.reasoning.reasoningStartTime = Date.now();
    }
    if (this.reasoning.isReasoningPhase) {
      this.reasoning.isReasoningPhase = false;
      this.reasoning.reasoningElapsedMs = this.reasoning.reasoningStartTime
        ? Date.now() - this.reasoning.reasoningStartTime
        : 0;
    }

    // 检测回复边界：文本长度缩短 → 新回复开始
    if (this.text.lastPartialText && text.length < this.text.lastPartialText.length) {
      this.text.streamingPrefix += (this.text.streamingPrefix ? '\n\n' : '') + this.text.lastPartialText;
    }
    this.text.lastPartialText = text;
    this.text.accumulatedText = this.text.streamingPrefix ? this.text.streamingPrefix + '\n\n' + text : text;

    // NO_REPLY 缓冲
    if (!this.text.streamingPrefix && SILENT_REPLY_TOKEN.startsWith(this.text.accumulatedText.trim())) {
      log.debug('onPartialReply: buffering NO_REPLY prefix');
      return;
    }

    await this.ensureCardCreated();
    if (!this.shouldProceed('onPartialReply.postCreate')) return;
    if (!this.cardKit.cardMessageId) return;
    await this.throttledCardUpdate();
  }

  async onError(err: unknown, info: { kind: string }): Promise<void> {
    if (this.guard.terminate('onError', err)) return;

    log.error(`${info.kind} reply failed`, { error: String(err) });

    this.captureToolUseElapsed();
    this.finalizeCard('onError', 'error');

    await this.flush.waitForFlush();

    if (this.cardCreationPromise) await this.cardCreationPromise;

    const errorEffectiveCardId = this.cardKit.cardKitCardId ?? this.cardKit.originalCardKitCardId;
    // v5：只快速读一次（不阻塞卡片定稿），拿不到则异步补 footer
    const footerMetrics = this.needsFooterMetrics()
      ? await this.getFooterSessionMetrics({ maxAttempts: 1 })
      : undefined;
    const toolUseDisplay = this.computeToolUseDisplay();
    try {
      if (this.cardKit.cardMessageId) {
        const rawErrorText = this.text.accumulatedText
          ? `${this.text.accumulatedText}\n\n---\n**Error**: An error occurred while generating the response.`
          : '**Error**: An error occurred while generating the response.';
        const terminalContent = prepareTerminalCardContent(
          {
            text: rawErrorText,
            reasoningText: this.reasoning.accumulatedReasoningText || undefined,
          },
          this.imageResolver,
        );
        const errorCard = buildCardContent('complete', {
          text: terminalContent.text,
          reasoningText: terminalContent.reasoningText,
          reasoningElapsedMs: this.reasoning.reasoningElapsedMs || undefined,
          toolUseSteps: toolUseDisplay?.steps,
          toolUseTitleSuffix: this.computeToolUseTitleSuffix(toolUseDisplay),
          toolUseElapsedMs: this.visibleToolUseElapsedMs,
          showToolUse: this.deps.toolUseDisplay.showToolUse,
          elapsedMs: this.elapsed(),
          isError: true,
          footer: this.deps.resolvedFooter,
          footerMetrics,
        });
        if (errorEffectiveCardId) {
          await this.closeStreamingAndUpdate(errorEffectiveCardId, errorCard, 'onError');
        } else {
          await updateCardFeishu({
            cfg: this.deps.cfg,
            messageId: this.cardKit.cardMessageId,
            card: errorCard as unknown as Record<string, unknown>,
            accountId: this.deps.accountId,
          });
        }
        // v5：主卡片已定稿，若快速读未命中则后台补 footer
        if (this.needsFooterMetrics() && !footerMetrics && this.cardKit.cardMessageId) {
          this.scheduleFooterMetricsBackfill({
            logTag: 'onError',
            cardId: errorEffectiveCardId,
            messageId: this.cardKit.cardMessageId,
            isCardKit: !!errorEffectiveCardId,
            build: (m) =>
              buildCardContent('complete', {
                text: terminalContent.text,
                reasoningText: terminalContent.reasoningText,
                reasoningElapsedMs: this.reasoning.reasoningElapsedMs || undefined,
                toolUseSteps: toolUseDisplay?.steps,
                toolUseTitleSuffix: this.computeToolUseTitleSuffix(toolUseDisplay),
                toolUseElapsedMs: this.visibleToolUseElapsedMs,
                showToolUse: this.deps.toolUseDisplay.showToolUse,
                elapsedMs: this.elapsed(),
                isError: true,
                footer: this.deps.resolvedFooter,
                footerMetrics: m,
              }),
          });
        }
      }
    } catch {
      // Ignore update failures during error handling
    } finally {
      clearToolUseTraceRun(this.deps.sessionKey);
    }
  }

  async onIdle(): Promise<void> {
    if (this.guard.isTerminated || this.guard.shouldSkip('onIdle')) return;

    if (!this.dispatchFullyComplete) return;

    if (this.isTerminalPhase) return;
    this.captureToolUseElapsed();
    this.finalizeCard('onIdle', 'normal');

    await this.flush.waitForFlush();

    if (this.cardCreationPromise) {
      await this.cardCreationPromise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      await this.flush.waitForFlush();
    }

    const idleEffectiveCardId = this.cardKit.cardKitCardId ?? this.cardKit.originalCardKitCardId;
    try {
      if (this.cardKit.cardMessageId) {
        if (idleEffectiveCardId) {
          const seqBeforeClose = this.cardKit.cardKitSequence;
          this.cardKit.cardKitSequence += 1;
          log.info('onIdle: closing streaming mode', {
            seqBefore: seqBeforeClose,
            seqAfter: this.cardKit.cardKitSequence,
          });
          await setCardStreamingMode({
            cfg: this.deps.cfg,
            cardId: idleEffectiveCardId,
            streamingMode: false,
            sequence: this.cardKit.cardKitSequence,
            accountId: this.deps.accountId,
          });
        }

        const isNoReplyLeak =
          !this.text.completedText && SILENT_REPLY_TOKEN.startsWith(this.text.accumulatedText.trim());
        const displayText =
          this.text.completedText || (isNoReplyLeak ? '' : this.text.accumulatedText) || EMPTY_REPLY_FALLBACK_TEXT;
        if (!this.text.completedText && !this.text.accumulatedText) {
          log.warn('reply completed without visible text, using empty-reply fallback');
        }

        // 等待图片异步解析（最多 15s），避免终态卡片留占位符
        const resolvedDisplayText = await this.imageResolver.resolveImagesAwait(displayText, 15_000);

        const idleToolUseDisplay = this.computeToolUseDisplay();
        const terminalContent = prepareTerminalCardContent(
          {
            text: resolvedDisplayText,
            reasoningText: this.reasoning.accumulatedReasoningText || undefined,
          },
          this.imageResolver,
        );
        // v5：只快速读一次（不阻塞卡片定稿），拿不到则异步补 footer
        const footerMetrics = this.needsFooterMetrics()
          ? await this.getFooterSessionMetrics({ maxAttempts: 1 })
          : undefined;

        const completeCard = buildCardContent('complete', {
          text: terminalContent.text,
          reasoningText: terminalContent.reasoningText,
          reasoningElapsedMs: this.reasoning.reasoningElapsedMs || undefined,
          toolUseSteps: idleToolUseDisplay?.steps,
          toolUseTitleSuffix: this.computeToolUseTitleSuffix(idleToolUseDisplay),
          toolUseElapsedMs: this.visibleToolUseElapsedMs,
          showToolUse: this.deps.toolUseDisplay.showToolUse,
          elapsedMs: this.elapsed(),
          footer: this.deps.resolvedFooter,
          footerMetrics,
        });

        if (idleEffectiveCardId) {
          const seqBeforeUpdate = this.cardKit.cardKitSequence;
          this.cardKit.cardKitSequence += 1;
          log.info('onIdle: updating final card', {
            seqBefore: seqBeforeUpdate,
            seqAfter: this.cardKit.cardKitSequence,
          });
          await updateCardKitCard({
            cfg: this.deps.cfg,
            cardId: idleEffectiveCardId,
            card: toCardKit2(completeCard),
            sequence: this.cardKit.cardKitSequence,
            accountId: this.deps.accountId,
          });
        } else {
          await updateCardFeishu({
            cfg: this.deps.cfg,
            messageId: this.cardKit.cardMessageId,
            card: completeCard as unknown as Record<string, unknown>,
            accountId: this.deps.accountId,
          });
        }
        log.info('reply completed, card finalized', {
          elapsedMs: this.elapsed(),
          isCardKit: !!idleEffectiveCardId,
        });
        // v5：主卡片已定稿，若快速读未命中则后台补 footer
        if (this.needsFooterMetrics() && !footerMetrics && this.cardKit.cardMessageId) {
          this.scheduleFooterMetricsBackfill({
            logTag: 'onIdle',
            cardId: idleEffectiveCardId,
            messageId: this.cardKit.cardMessageId,
            isCardKit: !!idleEffectiveCardId,
            build: (m) =>
              buildCardContent('complete', {
                text: terminalContent.text,
                reasoningText: terminalContent.reasoningText,
                reasoningElapsedMs: this.reasoning.reasoningElapsedMs || undefined,
                toolUseSteps: idleToolUseDisplay?.steps,
                toolUseTitleSuffix: this.computeToolUseTitleSuffix(idleToolUseDisplay),
                toolUseElapsedMs: this.visibleToolUseElapsedMs,
                showToolUse: this.deps.toolUseDisplay.showToolUse,
                elapsedMs: this.elapsed(),
                footer: this.deps.resolvedFooter,
                footerMetrics: m,
              }),
          });
        }
      }
    } catch (err) {
      log.warn('final card update failed', { error: String(err) });
    } finally {
      clearToolUseTraceRun(this.deps.sessionKey);
    }
  }

  // ------------------------------------------------------------------
  // External control
  // ------------------------------------------------------------------

  markFullyComplete(): void {
    log.debug('markFullyComplete', {
      completedTextLen: this.text.completedText.length,
      accumulatedTextLen: this.text.accumulatedText.length,
    });
    this.dispatchFullyComplete = true;
  }

  async abortCard(): Promise<void> {
    try {
      this.captureToolUseElapsed();
      if (!this.transition('aborted', 'abortCard', 'abort')) return;

      // transition() already executed onEnterTerminalPhase (cancel + complete + dispose hook)
      // Only need to wait for any in-flight flush to finish
      await this.flush.waitForFlush();

      if (this.cardCreationPromise) await this.cardCreationPromise;

      const effectiveCardId = this.cardKit.cardKitCardId ?? this.cardKit.originalCardKitCardId;
      const elapsedMs = Date.now() - this.dispatchStartTime;
      const abortToolUseDisplay = this.computeToolUseDisplay();
      const terminalContent = prepareTerminalCardContent(
        {
          text: this.text.accumulatedText || 'Aborted.',
          reasoningText: this.reasoning.accumulatedReasoningText || undefined,
        },
        this.imageResolver,
      );
      // v5：只快速读一次（不阻塞卡片定稿），拿不到则异步补 footer
      const footerMetrics = this.needsFooterMetrics()
        ? await this.getFooterSessionMetrics({ maxAttempts: 1 })
        : undefined;
      if (effectiveCardId) {
        const abortCardContent = buildCardContent('complete', {
          text: terminalContent.text,
          reasoningText: terminalContent.reasoningText,
          reasoningElapsedMs: this.reasoning.reasoningElapsedMs || undefined,
          toolUseSteps: abortToolUseDisplay?.steps,
          toolUseTitleSuffix: this.computeToolUseTitleSuffix(abortToolUseDisplay),
          toolUseElapsedMs: this.visibleToolUseElapsedMs,
          showToolUse: this.deps.toolUseDisplay.showToolUse,
          elapsedMs,
          isAborted: true,
          footer: this.deps.resolvedFooter,
          footerMetrics,
        });
        await this.closeStreamingAndUpdate(effectiveCardId, abortCardContent, 'abortCard');
        log.info('abortCard completed', { effectiveCardId });
        // v5：主卡片已定稿，若快速读未命中则后台补 footer
        if (this.needsFooterMetrics() && !footerMetrics && this.cardKit.cardMessageId) {
          this.scheduleFooterMetricsBackfill({
            logTag: 'abortCard',
            cardId: effectiveCardId,
            messageId: this.cardKit.cardMessageId,
            isCardKit: true,
            build: (m) =>
              buildCardContent('complete', {
                text: terminalContent.text,
                reasoningText: terminalContent.reasoningText,
                reasoningElapsedMs: this.reasoning.reasoningElapsedMs || undefined,
                toolUseSteps: abortToolUseDisplay?.steps,
                toolUseTitleSuffix: this.computeToolUseTitleSuffix(abortToolUseDisplay),
                toolUseElapsedMs: this.visibleToolUseElapsedMs,
                showToolUse: this.deps.toolUseDisplay.showToolUse,
                elapsedMs,
                isAborted: true,
                footer: this.deps.resolvedFooter,
                footerMetrics: m,
              }),
          });
        }
      } else if (this.cardKit.cardMessageId) {
        // IM fallback: 卡片不是通过 CardKit 发的，用 im.message.patch 更新
        const abortCard = buildCardContent('complete', {
          text: terminalContent.text,
          reasoningText: terminalContent.reasoningText,
          reasoningElapsedMs: this.reasoning.reasoningElapsedMs || undefined,
          toolUseSteps: abortToolUseDisplay?.steps,
          toolUseTitleSuffix: this.computeToolUseTitleSuffix(abortToolUseDisplay),
          toolUseElapsedMs: this.visibleToolUseElapsedMs,
          showToolUse: this.deps.toolUseDisplay.showToolUse,
          elapsedMs,
          isAborted: true,
          footer: this.deps.resolvedFooter,
          footerMetrics,
        });
        await updateCardFeishu({
          cfg: this.deps.cfg,
          messageId: this.cardKit.cardMessageId,
          card: abortCard as unknown as Record<string, unknown>,
          accountId: this.deps.accountId,
        });
        log.info('abortCard completed (IM fallback)', {
          messageId: this.cardKit.cardMessageId,
        });
        // v5：主卡片已定稿，若快速读未命中则后台补 footer
        if (this.needsFooterMetrics() && !footerMetrics) {
          this.scheduleFooterMetricsBackfill({
            logTag: 'abortCard-im',
            cardId: undefined,
            messageId: this.cardKit.cardMessageId,
            isCardKit: false,
            build: (m) =>
              buildCardContent('complete', {
                text: terminalContent.text,
                reasoningText: terminalContent.reasoningText,
                reasoningElapsedMs: this.reasoning.reasoningElapsedMs || undefined,
                toolUseSteps: abortToolUseDisplay?.steps,
                toolUseTitleSuffix: this.computeToolUseTitleSuffix(abortToolUseDisplay),
                toolUseElapsedMs: this.visibleToolUseElapsedMs,
                showToolUse: this.deps.toolUseDisplay.showToolUse,
                elapsedMs,
                isAborted: true,
                footer: this.deps.resolvedFooter,
                footerMetrics: m,
              }),
          });
        }
      }
    } catch (err) {
      log.warn('abortCard failed', { error: String(err) });
    } finally {
      clearToolUseTraceRun(this.deps.sessionKey);
    }
  }

  // ------------------------------------------------------------------
  // Internal: card creation
  // ------------------------------------------------------------------

  async ensureCardCreated(): Promise<void> {
    if (this.guard.shouldSkip('ensureCardCreated.precheck')) return;
    if (this.cardKit.cardMessageId || this.phase === 'creation_failed' || this.isTerminalPhase) {
      return;
    }
    if (this.cardCreationPromise) {
      await this.cardCreationPromise;
      return;
    }
    if (!this.transition('creating', 'ensureCardCreated')) return;
    this.createEpoch += 1;
    const epoch = this.createEpoch;
    this.cardCreationPromise = (async () => {
      try {
        try {
          // Step 1: Create card entity
          const cId = await createCardEntity({
            cfg: this.deps.cfg,
            card: buildStreamingThinkingCard(this.deps.toolUseDisplay.showToolUse),
            accountId: this.deps.accountId,
          });

          if (this.isStaleCreate(epoch)) {
            log.info('ensureCardCreated: stale epoch after createCardEntity, bailing out', {
              epoch,
              phase: this.phase,
            });
            return;
          }

          if (cId) {
            this.cardKit.cardKitCardId = cId;
            this.cardKit.originalCardKitCardId = cId;
            this.cardKit.cardKitSequence = 1;
            this.disposeShutdownHook = registerShutdownHook(`streaming-card:${cId}`, () => this.abortCard());
            log.info('created CardKit entity', {
              cardId: cId,
              initialSequence: this.cardKit.cardKitSequence,
            });

            // Step 2: Send IM message referencing card_id
            const result = await sendCardByCardId({
              cfg: this.deps.cfg,
              to: this.deps.chatId,
              cardId: cId,
              replyToMessageId: this.deps.replyToMessageId,
              replyInThread: this.deps.replyInThread,
              accountId: this.deps.accountId,
            });

            if (this.isStaleCreate(epoch)) {
              log.info('ensureCardCreated: stale epoch after sendCardByCardId, bailing out', {
                epoch,
                phase: this.phase,
              });
              this.disposeShutdownHook?.();
              this.disposeShutdownHook = null;
              return;
            }

            this.cardKit.cardMessageId = result.messageId;
            this.flush.setCardMessageReady(true);
            if (!this.transition('streaming', 'ensureCardCreated.cardkit')) {
              this.disposeShutdownHook?.();
              this.disposeShutdownHook = null;
              return;
            }
            log.info('sent CardKit card', { messageId: result.messageId });
          } else {
            throw new Error('card.create returned empty card_id');
          }
        } catch (cardKitErr: unknown) {
          if (this.isStaleCreate(epoch)) return;
          if (this.guard.terminate('ensureCardCreated.cardkitFlow', cardKitErr)) {
            return;
          }
          // CardKit flow failed — fall back to regular IM card
          const apiDetail = extractApiDetail(cardKitErr);
          log.warn('CardKit flow failed, falling back to IM', { apiDetail });
          this.cardKit.cardKitCardId = null;
          this.cardKit.originalCardKitCardId = null;

          const fallbackCard = buildCardContent('streaming', {
            showToolUse: this.deps.toolUseDisplay.showToolUse,
          });
          const result = await sendCardFeishu({
            cfg: this.deps.cfg,
            to: this.deps.chatId,
            card: fallbackCard as unknown as Record<string, unknown>,
            replyToMessageId: this.deps.replyToMessageId,
            replyInThread: this.deps.replyInThread,
            accountId: this.deps.accountId,
          });

          if (this.isStaleCreate(epoch)) {
            log.info('ensureCardCreated: stale epoch after IM fallback send, bailing out', {
              epoch,
              phase: this.phase,
            });
            return;
          }

          this.cardKit.cardMessageId = result.messageId;
          this.flush.setCardMessageReady(true);
          if (!this.transition('streaming', 'ensureCardCreated.imFallback')) {
            return;
          }
          log.info('sent fallback IM card', { messageId: result.messageId });
        }
      } catch (err) {
        if (this.isStaleCreate(epoch)) return;
        if (this.guard.terminate('ensureCardCreated.outer', err)) {
          return;
        }
        log.warn('thinking card failed, falling back to static', {
          error: String(err),
        });
        this.transition('creation_failed', 'ensureCardCreated.outer', 'creation_failed');
      }
    })();
    await this.cardCreationPromise;
  }

  // ------------------------------------------------------------------
  // Internal: flush
  // ------------------------------------------------------------------

  private async performFlush(): Promise<void> {
    if (!this.cardKit.cardMessageId || this.isTerminalPhase) return;

    // v2 CardKit 卡片不能走 IM patch，如果流式 CardKit 已禁用但 originalCardKitCardId
    // 仍在，说明卡片是通过 CardKit 发的——跳过中间态更新，等终态用 originalCardKitCardId 收尾
    if (!this.cardKit.cardKitCardId && this.cardKit.originalCardKitCardId) {
      log.debug('performFlush: skipping (CardKit streaming disabled, awaiting final update)');
      return;
    }

    log.debug('flushCardUpdate: enter', {
      seq: this.cardKit.cardKitSequence,
      isCardKit: !!this.cardKit.cardKitCardId,
    });

    try {
      const displayText = this.buildDisplayText();
      // 流式中间帧使用同步 resolveImages（不等待异步上传）
      const resolvedText = this.imageResolver.resolveImages(displayText);

      if (this.cardKit.cardKitCardId) {
        if (resolvedText !== this.text.lastFlushedText) {
          const prevSeq = this.cardKit.cardKitSequence;
          this.cardKit.cardKitSequence += 1;
          log.debug('flushCardUpdate: answer seq bump', {
            seqBefore: prevSeq,
            seqAfter: this.cardKit.cardKitSequence,
          });
          await streamCardContent({
            cfg: this.deps.cfg,
            cardId: this.cardKit.cardKitCardId,
            elementId: STREAMING_ELEMENT_ID,
            content: optimizeMarkdownStyle(resolvedText),
            sequence: this.cardKit.cardKitSequence,
            accountId: this.deps.accountId,
          });
          this.text.lastFlushedText = resolvedText;
        }
      } else {
        log.debug('flushCardUpdate: IM patch fallback');
        const flushDisplay = this.computeToolUseDisplay();
        const card = buildCardContent('streaming', {
          text: this.reasoning.isReasoningPhase ? '' : resolvedText,
          reasoningText: this.reasoning.isReasoningPhase ? this.reasoning.accumulatedReasoningText : undefined,
          toolUseSteps: flushDisplay?.steps,
          toolUseTitleSuffix: this.computeToolUseTitleSuffix(flushDisplay),
          showToolUse: this.deps.toolUseDisplay.showToolUse,
        });
        await updateCardFeishu({
          cfg: this.deps.cfg,
          messageId: this.cardKit.cardMessageId,
          card: card as unknown as Record<string, unknown>,
          accountId: this.deps.accountId,
        });
      }
    } catch (err: unknown) {
      if (this.guard.terminate('flushCardUpdate', err)) return;

      const apiCode = extractLarkApiCode(err);

      // 速率限制（230020）— 跳过此帧，不降级
      if (isCardRateLimitError(err)) {
        log.info('flushCardUpdate: rate limited (230020), skipping', {
          seq: this.cardKit.cardKitSequence,
        });
        return;
      }

      // 卡片表格数超出飞书限制（230099/11310）— 禁用 CardKit 流式，
      // 保留 originalCardKitCardId 供 onIdle 做最终 CardKit 更新
      if (isCardTableLimitError(err)) {
        log.warn('flushCardUpdate: card table limit exceeded (230099/11310), disabling CardKit streaming', {
          seq: this.cardKit.cardKitSequence,
        });
        this.cardKit.cardKitCardId = null;
        return;
      }

      const apiDetail = extractApiDetail(err);
      log.error('card stream update failed', {
        apiCode,
        seq: this.cardKit.cardKitSequence,
        apiDetail,
      });
      if (this.cardKit.cardKitCardId) {
        log.warn('disabling CardKit streaming, falling back to im.message.patch');
        this.cardKit.cardKitCardId = null;
      }
    }
  }

  private buildDisplayText(): string {
    if (this.reasoning.isReasoningPhase && this.reasoning.accumulatedReasoningText) {
      const reasoningDisplay = `💭 **Thinking...**\n\n${this.reasoning.accumulatedReasoningText}`;
      return this.text.accumulatedText ? this.text.accumulatedText + '\n\n' + reasoningDisplay : reasoningDisplay;
    }
    return this.text.accumulatedText;
  }

  private async throttledCardUpdate(): Promise<void> {
    if (this.guard.shouldSkip('throttledCardUpdate')) return;
    const throttleMs = this.cardKit.cardKitCardId ? THROTTLE_CONSTANTS.CARDKIT_MS : THROTTLE_CONSTANTS.PATCH_MS;
    await this.flush.throttledUpdate(throttleMs);
  }

  // ---- Tool-use status streaming (pre-answer phase) ----

  private lastToolUseStatusUpdateTime = 0;

  private async throttledToolUseStatusUpdate(): Promise<void> {
    if (!this.cardKit.cardKitCardId) return;
    const now = Date.now();
    if (now - this.lastToolUseStatusUpdateTime < THROTTLE_CONSTANTS.REASONING_STATUS_MS) return;
    this.lastToolUseStatusUpdateTime = now;
    await this.updateToolUseStatus();
  }

  private async updateToolUseStatus(): Promise<void> {
    if (!this.cardKit.cardKitCardId || this.isTerminalPhase) return;
    try {
      const display = this.computeToolUseDisplay();
      const card = buildStreamingPreAnswerCard({
        steps: display?.steps,
        elapsedMs: this.visibleToolUseElapsedMs,
        showToolUse: this.shouldDisplayToolUse,
      });
      this.cardKit.cardKitSequence += 1;
      await updateCardKitCard({
        cfg: this.deps.cfg,
        cardId: this.cardKit.cardKitCardId,
        card,
        sequence: this.cardKit.cardKitSequence,
        accountId: this.deps.accountId,
      });
    } catch (err) {
      log.debug('updateToolUseStatus failed', { error: String(err) });
    }
  }

  // ------------------------------------------------------------------
  // Internal: lifecycle helpers
  // ------------------------------------------------------------------

  private finalizeCard(source: string, reason: TerminalReason): void {
    this.transition('completed', source, reason);
  }

  /**
   * Close streaming mode then update card content (shared by onError and abortCard).
   */
  private async closeStreamingAndUpdate(
    cardId: string,
    card: ReturnType<typeof buildCardContent>,
    label: string,
  ): Promise<void> {
    const seqBeforeClose = this.cardKit.cardKitSequence;
    this.cardKit.cardKitSequence += 1;
    log.info(`${label}: closing streaming mode`, {
      seqBefore: seqBeforeClose,
      seqAfter: this.cardKit.cardKitSequence,
    });
    await setCardStreamingMode({
      cfg: this.deps.cfg,
      cardId,
      streamingMode: false,
      sequence: this.cardKit.cardKitSequence,
      accountId: this.deps.accountId,
    });
    const seqBeforeUpdate = this.cardKit.cardKitSequence;
    this.cardKit.cardKitSequence += 1;
    log.info(`${label}: updating card`, {
      seqBefore: seqBeforeUpdate,
      seqAfter: this.cardKit.cardKitSequence,
    });
    await updateCardKitCard({
      cfg: this.deps.cfg,
      cardId,
      card: toCardKit2(card),
      sequence: this.cardKit.cardKitSequence,
      accountId: this.deps.accountId,
    });
  }
}

// ---------------------------------------------------------------------------
// Error detail extraction helpers (replacing `any` casts)
// ---------------------------------------------------------------------------

/**
 * 终态卡片的正文和 reasoning 都会被飞书按 markdown 渲染，
 * 因此两者都要先做图片替换与表格降级，避免再次撞到 230099/11310。
 */
export function prepareTerminalCardContent(
  content: TerminalCardContentInput,
  imageResolver: TerminalCardTextImageResolver,
  tableLimit: number = FEISHU_CARD_TABLE_LIMIT,
): TerminalCardContentInput {
  const resolvedReasoningText = content.reasoningText ? imageResolver.resolveImages(content.reasoningText) : undefined;
  const resolvedText = imageResolver.resolveImages(content.text);
  const sanitizedSegments = sanitizeTextSegmentsForCard(
    resolvedReasoningText ? [resolvedReasoningText, resolvedText] : [resolvedText],
    tableLimit,
  );

  if (resolvedReasoningText) {
    return {
      reasoningText: sanitizedSegments[0],
      text: sanitizedSegments[1],
    };
  }

  return { text: sanitizedSegments[0] };
}

function extractApiDetail(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err);
  const e = err as { response?: { data?: unknown } };
  return e.response?.data ? JSON.stringify(e.response.data) : String(err);
}
