/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Guard against operating on unavailable (deleted/recalled) messages.
 *
 * Encapsulates the terminateDueToUnavailable / shouldSkipForUnavailable
 * logic previously scattered as closures in reply-dispatcher.ts.
 */

import { larkLogger } from '../core/lark-logger';
import { extractLarkApiCode } from '../core/api-error';
import {
  getMessageUnavailableState,
  isMessageUnavailable,
  isMessageUnavailableError,
  isTerminalMessageApiCode,
  markMessageUnavailable,
} from '../core/message-unavailable';

const log = larkLogger('card/unavailable-guard');

// ---------------------------------------------------------------------------
// Constructor params
// ---------------------------------------------------------------------------

export interface UnavailableGuardParams {
  replyToMessageId: string | undefined;
  getCardMessageId: () => string | null;
  onTerminate: () => void;
}

// ---------------------------------------------------------------------------
// UnavailableGuard
// ---------------------------------------------------------------------------

export class UnavailableGuard {
  private terminated = false;

  private readonly replyToMessageId: string | undefined;
  private readonly getCardMessageId: () => string | null;
  private readonly onTerminate: () => void;

  constructor(params: UnavailableGuardParams) {
    this.replyToMessageId = params.replyToMessageId;
    this.getCardMessageId = params.getCardMessageId;
    this.onTerminate = params.onTerminate;
  }

  get isTerminated(): boolean {
    return this.terminated;
  }

  /**
   * Check whether the reply pipeline should skip further operations.
   * Returns true if the message is already known to be unavailable.
   */
  shouldSkip(source: string): boolean {
    if (this.terminated) return true;
    if (!this.replyToMessageId) return false;
    if (!isMessageUnavailable(this.replyToMessageId)) return false;
    return this.terminate(source);
  }

  /**
   * Attempt to terminate the reply pipeline due to an unavailable message.
   *
   * @param source - Descriptive label for the caller (for logging).
   * @param err    - Optional error that triggered the check.
   * @returns true if the pipeline was (or already had been) terminated.
   */
  terminate(source: string, err?: unknown): boolean {
    if (this.terminated) return true;

    const fromError = isMessageUnavailableError(err) ? err : undefined;
    const cardMessageId = this.getCardMessageId();
    const state =
      getMessageUnavailableState(this.replyToMessageId) ?? getMessageUnavailableState(cardMessageId ?? undefined);
    let apiCode = fromError?.apiCode ?? state?.apiCode;

    if (!apiCode && err) {
      const detectedCode = extractLarkApiCode(err);
      if (isTerminalMessageApiCode(detectedCode)) {
        const fallbackMessageId = this.replyToMessageId ?? cardMessageId ?? undefined;
        if (fallbackMessageId) {
          markMessageUnavailable({
            messageId: fallbackMessageId,
            apiCode: detectedCode,
            operation: source,
          });
        }
        apiCode = detectedCode;
      }
    }
    if (!apiCode) return false;

    this.terminated = true;
    this.onTerminate();

    const affectedMessageId = fromError?.messageId ?? this.replyToMessageId ?? cardMessageId ?? 'unknown';
    log.warn('reply pipeline terminated by unavailable message', {
      source,
      apiCode,
      messageId: affectedMessageId,
    });
    return true;
  }
}
