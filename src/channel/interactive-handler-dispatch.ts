/**
 * Dispatch card actions to configured prompt handlers via synthetic Agent messages.
 *
 * Flow: sync ack (≤3s) → render handler prompt with card context → dispatch to Agent.
 * No local process launch or external webhooks; the Agent executes skills/tools from the prompt.
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import { getLarkAccount } from '../core/accounts';
import { larkLogger } from '../core/lark-logger';
import { dispatchSyntheticTextMessage } from '../messaging/inbound/synthetic-message';
import { buildDefaultInteractiveAck } from './interactive-ack';
import {
  buildInteractiveHandlerContext,
  renderInteractiveHandlerPrompt,
} from './interactive-prompt';
import { resolveInteractiveRoute } from './interactive-route';

const log = larkLogger('channel/interactive-handler-dispatch');

/**
 * Dispatch a card action to `channels.feishu.interactive.handlers.<namespace>`.
 *
 * Returns a synchronous Feishu callback payload when a handler prompt is configured.
 */
export async function dispatchFeishuInteractiveHandler(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  data: unknown;
}): Promise<unknown | undefined> {
  const route = resolveInteractiveRoute(params.data);
  if (!route) return undefined;
  const account = getLarkAccount(params.cfg, params.accountId);
  const interactive = account.config.interactive;
  if (interactive?.enabled === false) return undefined;
  const handler = interactive?.handlers?.[route.namespace];
  if (!handler?.prompt?.trim()) return undefined;
  const chatId = route.openChatId ?? '';
  const senderOpenId = route.senderOpenId ?? '';
  if (!chatId || !senderOpenId) {
    log.warn('interactive handler dispatch skipped: missing chatId or operator open_id', {
      namespace: route.namespace,
      action: route.action,
    });
    return buildDefaultInteractiveAck(interactive?.defaultAck);
  }
  const dedupeId = `feishu:${params.accountId}:${chatId}:${route.openMessageId ?? '-'}:${senderOpenId}:${route.action}`;
  const promptVars = buildInteractiveHandlerContext({
    route,
    accountId: params.accountId,
    dedupeId,
  });
  const text = renderInteractiveHandlerPrompt(handler.prompt, promptVars);
  const syntheticMessageId = `${route.openMessageId ?? 'om_unknown'}:interactive:${route.namespace}:${Date.now()}`;
  const forceMention = handler.forceMention ?? true;
  log.info('interactive handler dispatch matched', {
    namespace: route.namespace,
    action: route.action,
    openChatId: route.openChatId,
    openMessageId: route.openMessageId,
    senderOpenId: route.senderOpenId,
  });
  setImmediate(() => {
    dispatchSyntheticTextMessage({
      cfg: params.cfg,
      accountId: params.accountId,
      chatId,
      senderOpenId,
      text,
      syntheticMessageId,
      replyToMessageId: route.openMessageId ?? syntheticMessageId,
      chatType: route.chatType,
      threadId: route.threadId,
      runtime: { log: (msg: string) => log.info(msg), error: (msg: string) => log.warn(msg) },
      forceMention,
    }).catch((err: unknown) => {
      log.warn(`interactive handler synthetic dispatch failed: ${String(err)}`);
    });
  });
  return buildDefaultInteractiveAck(interactive?.defaultAck);
}
