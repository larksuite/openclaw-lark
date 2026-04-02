/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Subagent merge interceptor.
 *
 * When `subagent.mergeToMain` is enabled (default) and an active streaming
 * card exists for the conversation, this module attempts to merge the text
 * into that card.
 *
 * On merge failure, the module checks the account's `delivery` config:
 * - `'card'` → sends as a standalone card WITH footer (subagent-specific)
 * - `'text'` → returns null so sendText sends as plain text
 *
 * This separation ensures that `outbound.ts sendText` stays a pure delivery
 * primitive — all subagent-aware logic lives here.
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import { buildCardContent, toCardKit2 } from '../../card/builder';
import { buildConversationKey, getCompletedCard } from '../../card/card-registry';
import { resolveFooterSessionMetrics } from '../../card/footer-metrics';
import { handleSubagentCompletion } from '../../card/subagent-completion-handler';
import { getCurrentSessionKey } from '../../card/subagent-tracker';
import { getLarkAccount } from '../../core/accounts';
import { resolveFooterConfig } from '../../core/footer-config';
import { larkLogger } from '../../core/lark-logger';
import { normalizeFeishuTarget } from '../../core/targets';
import { sendCardLark } from './deliver';

const log = larkLogger('outbound/subagent-delivery');

/**
 * Try to deliver text as a subagent completion.
 *
 * 1. If mergeToMain is enabled and an active card exists → merge into it.
 * 2. If merge fails and delivery='card' → send as standalone card with footer.
 * 3. Otherwise → return null (caller sends as plain text).
 */
export async function tryMergeToMainCard(params: {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  accountId?: string;
  threadId?: string;
  replyToMessageId?: string;
  replyInThread: boolean;
}): Promise<{ channel: string; messageId: string; chatId: string } | null> {
  const { cfg, to, text, accountId, threadId } = params;

  const account = getLarkAccount(cfg, accountId);
  if (account.config?.subagent?.mergeToMain === false) return null;

  const chatId = normalizeFeishuTarget(to) ?? to;
  const key = buildConversationKey({ to: chatId, accountId, threadId });
  if (!getCompletedCard(key)) return null;

  log.info('tryMergeToMainCard: active card found, attempting merge', { key });

  const result = await handleSubagentCompletion({ cfg, to, accountId, threadId, text });
  if (result.status === 'merged' || result.status === 'buffered') {
    return { channel: 'feishu', messageId: result.messageId, chatId: result.chatId };
  }

  // Merge failed — check if we should fallback to a standalone card with footer
  const delivery = account.config?.delivery ?? 'text';
  if (delivery === 'card') {
    log.info('tryMergeToMainCard: merge failed, falling back to standalone card', { key });
    return sendSubagentCard({ cfg, to: params.to, text, accountId, threadId, replyToMessageId: params.replyToMessageId, replyInThread: params.replyInThread });
  }

  // delivery === 'text' → let sendText handle as plain text
  return null;
}

/**
 * Send subagent text as a standalone card with full footer metrics.
 * Only called when merge fails and delivery='card'.
 */
async function sendSubagentCard(params: {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  accountId?: string;
  threadId?: string;
  replyToMessageId?: string;
  replyInThread: boolean;
}): Promise<{ channel: string; messageId: string; chatId: string }> {
  const { cfg, to, text, accountId, threadId } = params;
  const account = getLarkAccount(cfg, accountId);
  const footer = resolveFooterConfig(account.config?.footer);
  const chatId = normalizeFeishuTarget(to) ?? to;
  const mainSessionKey = getCurrentSessionKey(chatId, accountId, threadId);
  const footerMetrics = mainSessionKey
    ? await resolveFooterSessionMetrics({ cfg, sessionKey: mainSessionKey })
    : undefined;

  const card = toCardKit2(buildCardContent('complete', { text, footer, footerMetrics }));
  const result = await sendCardLark({
    cfg,
    to,
    card,
    replyToMessageId: params.replyToMessageId,
    replyInThread: params.replyInThread,
    accountId,
  });
  return { channel: 'feishu', ...result };
}
