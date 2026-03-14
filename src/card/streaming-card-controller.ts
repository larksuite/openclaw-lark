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

import { SILENT_REPLY_TOKEN, type ReplyPayload } from 'openclaw/plugin-sdk';
import { extractLarkApiCode } from '../core/api-error';
import { larkLogger } from '../core/lark-logger';
import { sendCardFeishu, updateCardFeishu } from '../messaging/outbound/send';
import {
  createCardEntity,
  sendCardByCardId,
  streamCardContent,
  updateCardKitCard,
  setCardStreamingMode,
} from './cardkit';
import { buildCardContent, splitReasoningText, stripReasoningTags, STREAMING_ELEMENT_ID, toCardKit2 } from './builder';
import { optimizeMarkdownStyle } from './markdown-style';
import { ImageResolver } from './image-resolver';
import { registerShutdownHook } from '../core/shutdown-hooks';
import { FlushController } from './flush-controller';
import { UnavailableGuard } from './unavailable-guard';
import type {
  CardPhase,
  TerminalReason,
  ReasoningState,
  StreamingTextState,
  CardKitState,
  StreamingCardDeps,
} from './reply-dispatcher-types';
import {
  TERMINAL_PHASES,
  PHASE_TRANSITIONS,
  THROTTLE_CONSTANTS,
  EMPTY_REPLY_FALLBACK_TEXT,
} from './reply-dispatcher-types';

const log = larkLogger('card/streaming');
// ---------------------------------------------------------------------------
// CardKit 2.0 initial streaming payload
// ---------------------------------------------------------------------------

const STREAMING_THINKING_CARD = {
  schema: '2.0',
  config: {
    streaming_mode: true,
    locales: ['zh_cn', 'en_us'],
    summary: {
      content: 'Thinking...',
      i18n_content: { zh_cn: '思考中...', en_us: 'Thinking...' },
    },
  },
  body: {
    elements: [
      {
        tag: 'markdown',
        content: '',
        text_align: 'left',
        text_size: 'normal_v2',
        margin: '0px 0px 0px 0px',
        element_id: STREAMING_ELEMENT_ID,
      },
      {
        tag: 'markdown',
        content: ' ',
        icon: {
          tag: 'custom_icon',
          img_key: 'img_v3_02vb_496bec09-4b43-4773-ad6b-0cdd103cd2bg',
          size: '16px 16px',
        },
        element_id: 'loading_icon',
      },
    ],
  },
} as const;

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
  };
  private reasoning: ReasoningState = {
    accumulatedReasoningText: '',
    reasoningStartTime: null,
    reasoningElapsedMs: 0,
    isReasoningPhase: false,
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

  async onPartialReply(payload: ReplyPayload): Promise<void> {
    if (!this.shouldProceed('onPartialReply')) return;

    const text = stripReasoningTags(payload.text ?? '');
    log.debug('onPartialReply', { len: text.length });
    if (!text) return;

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

    this.finalizeCard('onError', 'error');

    await this.flush.waitForFlush();

    if (this.cardCreationPromise) await this.cardCreationPromise;

    const errorEffectiveCardId = this.cardKit.cardKitCardId ?? this.cardKit.originalCardKitCardId;
    if (this.cardKit.cardMessageId) {
      try {
        const rawErrorText = this.text.accumulatedText
          ? `${this.text.accumulatedText}\n\n---\n**Error**: An error occurred while generating the response.`
          : '**Error**: An error occurred while generating the response.';
        const errorText = this.imageResolver.resolveImages(rawErrorText);
        const errorCard = buildCardContent('complete', {
          text: errorText,
          reasoningText: this.reasoning.accumulatedReasoningText || undefined,
          reasoningElapsedMs: this.reasoning.reasoningElapsedMs || undefined,
          elapsedMs: this.elapsed(),
          isError: true,
          footer: this.deps.resolvedFooter,
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
      } catch {
        // Ignore update failures during error handling
      }
    }
  }

  async onIdle(): Promise<void> {
    if (this.guard.isTerminated || this.guard.shouldSkip('onIdle')) return;

    if (!this.dispatchFullyComplete) return;

    if (this.isTerminalPhase) return;
    this.finalizeCard('onIdle', 'normal');

    await this.flush.waitForFlush();

    if (this.cardCreationPromise) {
      await this.cardCreationPromise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      await this.flush.waitForFlush();
    }

    const idleEffectiveCardId = this.cardKit.cardKitCardId ?? this.cardKit.originalCardKitCardId;
    if (this.cardKit.cardMessageId) {
      try {
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

        const resolvedDisplayText = await this.imageResolver.resolveImagesAwait(displayText, 15_000);

        const completeCard = buildCardContent('complete', {
          text: resolvedDisplayText,
          reasoningText: this.reasoning.accumulatedReasoningText || undefined,
          reasoningElapsedMs: this.reasoning.reasoningElapsedMs || undefined,
          elapsedMs: this.elapsed(),
          footer: this.deps.resolvedFooter,
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
      } catch (err) {
        log.warn('final card update failed', { error: String(err) });
      }
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
      if (!this.transition('aborted', 'abortCard', 'abort')) return;

      // transition() already executed onEnterTerminalPhase (cancel + complete + dispose hook)
      // Only need to wait for any in-flight flush to finish
      await this.flush.waitForFlush();

      if (this.cardCreationPromise) await this.cardCreationPromise;

      const effectiveCardId = this.cardKit.cardKitCardId ?? this.cardKit.originalCardKitCardId;
      if (effectiveCardId) {
        const elapsedMs = Date.now() - this.dispatchStartTime;
        const abortText = this.imageResolver.resolveImages(this.text.accumulatedText || 'Aborted.');
        const abortCardContent = buildCardContent('complete', {
          text: abortText,
          reasoningText: this.reasoning.accumulatedReasoningText || undefined,
          reasoningElapsedMs: this.reasoning.reasoningElapsedMs || undefined,
          elapsedMs,
          isAborted: true,
          footer: this.deps.resolvedFooter,
        });
        await this.closeStreamingAndUpdate(effectiveCardId, abortCardContent, 'abortCard');
        log.info('abortCard completed', { effectiveCardId });
      } else if (this.cardKit.cardMessageId) {
        // IM fallback: 卡片不是通过 CardKit 发的，用 im.message.patch 更新
        const elapsedMs = Date.now() - this.dispatchStartTime;
        const abortText = this.imageResolver.resolveImages(this.text.accumulatedText || 'Aborted.');
        const abortCard = buildCardContent('complete', {
          text: abortText,
          reasoningText: this.reasoning.accumulatedReasoningText || undefined,
          reasoningElapsedMs: this.reasoning.reasoningElapsedMs || undefined,
          elapsedMs,
          isAborted: true,
          footer: this.deps.resolvedFooter,
        });
        await updateCardFeishu({
          cfg: this.deps.cfg,
          messageId: this.cardKit.cardMessageId,
          card: abortCard as unknown as Record<string, unknown>,
          accountId: this.deps.accountId,
        });
        log.info('abortCard completed (IM fallback)', { messageId: this.cardKit.cardMessageId });
      }
    } catch (err) {
      log.warn('abortCard failed', { error: String(err) });
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
            card: STREAMING_THINKING_CARD,
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

          const fallbackCard = buildCardContent('thinking');
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
        log.warn('thinking card failed, falling back to static', { error: String(err) });
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
      const resolvedText = this.imageResolver.resolveImages(displayText);

      if (this.cardKit.cardKitCardId) {
        // CardKit streaming — typewriter effect
        const prevSeq = this.cardKit.cardKitSequence;
        this.cardKit.cardKitSequence += 1;
        log.debug('flushCardUpdate: seq bump', {
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
      } else {
        log.debug('flushCardUpdate: IM patch fallback');
        const card = buildCardContent('streaming', {
          text: this.reasoning.isReasoningPhase ? '' : resolvedText,
          reasoningText: this.reasoning.isReasoningPhase ? this.reasoning.accumulatedReasoningText : undefined,
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

      if (apiCode === 230020) {
        log.info('flushCardUpdate: rate limited (230020), skipping', {
          seq: this.cardKit.cardKitSequence,
        });
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

function extractApiDetail(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err);
  const e = err as { response?: { data?: unknown } };
  return e.response?.data ? JSON.stringify(e.response.data) : String(err);
}
