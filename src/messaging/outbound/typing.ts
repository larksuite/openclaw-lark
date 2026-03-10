/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Typing indicator management for the Lark/Feishu channel plugin.
 *
 * Feishu does not expose a first-class "typing indicator" API the way
 * some other messaging platforms do. Instead, this module simulates a
 * typing state by adding a recognisable emoji reaction (the "Typing"
 * emoji) to the user's message while the bot is processing, and
 * removing it once the response is ready.
 *
 * This provides a lightweight visual cue that the bot has acknowledged
 * the message and is working on a reply.
 */

import type { OpenClawConfig } from 'openclaw/plugin-sdk';
import { LarkClient } from '../../core/lark-client';
import { normalizeMessageId } from '../../core/targets';
import { isMessageUnavailableError, runWithMessageUnavailableGuard } from '../../core/message-unavailable';
import { larkLogger } from '../../core/lark-logger';

const log = larkLogger('outbound/typing');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Tracks the state of an active typing indicator so it can be
 * removed later.
 */
export interface TypingIndicatorState {
  /** The message ID that the reaction was added to. */
  messageId: string;
  /** The reaction ID returned by the API, or null if the add failed. */
  reactionId: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The emoji type used to represent the typing indicator.
 *
 * "Typing" is a built-in Feishu emoji that shows a pencil / keyboard
 * animation, making it a natural choice for a typing cue.
 */
const TYPING_EMOJI_TYPE = 'Typing';

// ---------------------------------------------------------------------------
// addTypingIndicator
// ---------------------------------------------------------------------------

/**
 * Add a typing indicator to a message by creating an emoji reaction.
 *
 * The reaction is added silently -- any errors (network issues, missing
 * permissions, rate limits) are caught and logged rather than propagated
 * to the caller. This ensures that a failure to show the typing cue
 * never blocks the actual message processing.
 *
 * @param params.cfg       - Plugin configuration with Feishu credentials.
 * @param params.messageId - The message ID to add the typing reaction to.
 * @param params.accountId - Optional account identifier for multi-account setups.
 * @returns A state object that should be passed to {@link removeTypingIndicator}.
 */
export async function addTypingIndicator(params: {
  cfg: OpenClawConfig;
  messageId: string;
  accountId?: string;
}): Promise<TypingIndicatorState> {
  const { cfg, messageId, accountId } = params;

  // 规范化 message_id，处理合成 ID（如 "om_xxx:auth-complete"）
  const normalizedId = normalizeMessageId(messageId);

  const state: TypingIndicatorState = {
    messageId: normalizedId, // 保存规范化后的 ID
    reactionId: null,
  };

  try {
    const client = LarkClient.fromCfg(cfg, accountId).sdk;

    const response = await runWithMessageUnavailableGuard({
      messageId: normalizedId,
      operation: 'im.messageReaction.create(typing)',
      fn: () =>
        client.im.messageReaction.create({
          path: {
            message_id: normalizedId,
          },
          data: {
            reaction_type: {
              emoji_type: TYPING_EMOJI_TYPE,
            },
          },
        }),
    });

    state.reactionId = response?.data?.reaction_id ?? null;
  } catch (error) {
    if (isMessageUnavailableError(error)) {
      log.debug(`Skip add typing indicator for unavailable message`, { messageId: normalizedId });
      return state;
    }
    // Silently swallow the error. The typing indicator is a best-effort
    // visual cue and must not interfere with message processing.
    log.debug(`Failed to add typing indicator`, {
      messageId,
      error: error instanceof Error ? error.message : error,
    });
  }

  return state;
}

// ---------------------------------------------------------------------------
// removeTypingIndicator
// ---------------------------------------------------------------------------

/**
 * Remove a previously added typing indicator reaction from a message.
 *
 * If the indicator was never successfully added (reactionId is null),
 * this function is a no-op. Errors are silently caught so removal
 * failures do not disrupt downstream logic.
 *
 * @param params.cfg   - Plugin configuration with Feishu credentials.
 * @param params.state - The typing indicator state returned by {@link addTypingIndicator}.
 * @param params.accountId - Optional account identifier for multi-account setups.
 */
export async function removeTypingIndicator(params: {
  cfg: OpenClawConfig;
  state: TypingIndicatorState;
  accountId?: string;
}): Promise<void> {
  const { cfg, state, accountId } = params;
  const reactionId = state.reactionId;

  if (!reactionId) {
    // Nothing to remove -- the indicator was never added or the add
    // call did not return a reaction ID.
    return;
  }

  try {
    const client = LarkClient.fromCfg(cfg, accountId).sdk;

    await runWithMessageUnavailableGuard({
      messageId: state.messageId,
      operation: 'im.messageReaction.delete(typing)',
      fn: () =>
        client.im.messageReaction.delete({
          path: {
            message_id: state.messageId,
            reaction_id: reactionId,
          },
        }),
    });
  } catch (error) {
    if (isMessageUnavailableError(error)) {
      log.debug(`Skip remove typing indicator for unavailable message`, { messageId: state.messageId });
      return;
    }
    // Silently swallow the error. A leftover reaction is acceptable;
    // it will not confuse the user and will disappear if the message
    // is deleted or the reaction is manually removed.
    log.debug(`Failed to remove typing indicator`, {
      messageId: state.messageId,
      error: error instanceof Error ? error.message : error,
    });
  }
}
