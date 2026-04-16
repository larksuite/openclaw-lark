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

import { readFile } from 'node:fs/promises';

import type { ReplyPayload } from 'openclaw/plugin-sdk';
import { SILENT_REPLY_TOKEN } from 'openclaw/plugin-sdk/reply-runtime';
import { extractLarkApiCode } from '../core/api-error';
import { larkLogger } from '../core/lark-logger';
import { LarkClient } from '../core/lark-client';
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

  private async getFooterSessionMetrics(): Promise<FooterSessionMetrics | undefined> {
    try {
      const runtime = LarkClient.runtime as {
        agent?: {
          session?: {
            resolveStorePath?: (storePath?: string, opts?: { agentId?: string }) => string;
            loadSessionStore?: (storePath: string) => Record<string, Record<string, unknown>>;
          };
        };
        channel?: {
          session?: {
            resolveStorePath?: (storePath?: string, opts?: { agentId?: string }) => string;
          };
        };
      } | null;
      if (!runtime) return undefined;

      const cfgWithSession = this.deps.cfg as { sessions?: { store?: string }; session?: { store?: string } };
      const sessionStorePath = cfgWithSession.sessions?.store ?? cfgWithSession.session?.store;
      const key = this.deps.sessionKey.trim().toLowerCase();
      // Extract agentId from session key (format: "agent:<agentId>:feishu:...")
      // to route the store lookup to the correct per-agent session file.
      const agentId = key.match(/^agent:([^:]+):/)?.[1];

      const sessionApi = runtime.agent?.session;
      if (sessionApi?.resolveStorePath && sessionApi?.loadSessionStore) {
        const storePath = sessionApi.resolveStorePath(sessionStorePath, { agentId });
        const store = sessionApi.loadSessionStore(storePath);

        const entry = store[key];
        if (!entry || typeof entry !== 'object') {
          log.debug('footer metrics lookup: session entry missing', {
            sessionKey: this.deps.sessionKey,
            key,
            storePath,
            source: 'runtime.agent.session',
          });
          return undefined;
        }

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
        log.debug('footer metrics lookup: session entry found', {
          sessionKey: this.deps.sessionKey,
          key,
          storePath,
          source: 'runtime.agent.session',
        });
        return metrics;
      }

      const channelSession = runtime.channel?.session;
      if (!channelSession?.resolveStorePath) {
        return undefined;
      }

      const storePath = channelSession.resolveStorePath(sessionStorePath, { agentId });
      const raw = await readFile(storePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const store =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, Record<string, unknown>>)
          : {};

      const entry = store[key];
      if (!entry || typeof entry !== 'object') {
        log.debug('footer metrics lookup: session entry missing', {
          sessionKey: this.deps.sessionKey,
          key,
          storePath,
          source: 'channel.session.file',
        });
        return undefined;
      }

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
      log.debug('footer metrics lookup: session entry found', {
        sessionKey: this.deps.sessionKey,
        key,
        storePath,
        source: 'channel.session.file',
      });
      return metrics;
    } catch (err) {
      log.warn('footer metrics lookup failed', { error: String(err), sessionKey: this.deps.sessionKey });
      return undefined;
    }
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
    const footerMetrics = this.needsFooterMetrics() ? await this.getFooterSessionMetrics() : undefined;
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
        const footerMetrics = this.needsFooterMetrics() ? await this.getFooterSessionMetrics() : undefined;

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
      const footerMetrics = this.needsFooterMetrics() ? await this.getFooterSessionMetrics() : undefined;
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
