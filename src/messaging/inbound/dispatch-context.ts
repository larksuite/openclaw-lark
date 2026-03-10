/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Dispatch context construction for the inbound agent dispatch pipeline.
 *
 * Derives all shared values needed by downstream dispatch helpers:
 * logging, addressing, route resolution, thread session, and system
 * event emission.
 */

import type { ClawdbotConfig, RuntimeEnv } from 'openclaw/plugin-sdk';
import { resolveThreadSessionKeys } from 'openclaw/plugin-sdk';
import type { MessageContext } from '../types';
import type { LarkAccount } from '../../core/types';
import { LarkClient } from '../../core/lark-client';
import { larkLogger } from '../../core/lark-logger';
import { isThreadCapableGroup } from '../../core/chat-info-cache';

const log = larkLogger('inbound/dispatch-context');

// ---------------------------------------------------------------------------
// DispatchContext type
// ---------------------------------------------------------------------------

export interface DispatchContext {
  ctx: MessageContext;
  /** account 级别的 ClawdbotConfig（channels.feishu 已替换为 per-account 合并后的配置） */
  accountScopedCfg: ClawdbotConfig;
  account: LarkAccount;
  runtime: RuntimeEnv;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  core: typeof LarkClient.runtime;
  isGroup: boolean;
  isThread: boolean;
  feishuFrom: string;
  feishuTo: string;
  envelopeFrom: string;
  envelopeOptions: ReturnType<typeof LarkClient.runtime.channel.reply.resolveEnvelopeFormatOptions>;
  route: ReturnType<typeof LarkClient.runtime.channel.routing.resolveAgentRoute>;
  threadSessionKey?: string;
  commandAuthorized?: boolean;
}

// ---------------------------------------------------------------------------
// RuntimeEnv fallback
// ---------------------------------------------------------------------------

/**
 * Provide a safe RuntimeEnv fallback when the caller did not supply one.
 * Replaces the previous unsafe `runtime as RuntimeEnv` casts.
 */
export function ensureRuntime(runtime: RuntimeEnv | undefined): RuntimeEnv {
  if (runtime) return runtime;
  return {
    log: (...args: unknown[]) => log.info(args.map(String).join(' ')),
    error: (...args: unknown[]) => log.error(args.map(String).join(' ')),
    exit: (code: number) => process.exit(code) as never,
  };
}

// ---------------------------------------------------------------------------
// Context construction
// ---------------------------------------------------------------------------

/**
 * Derive all shared values needed by downstream helpers:
 * logging, addressing, route resolution, and system event emission.
 */
export function buildDispatchContext(params: {
  ctx: MessageContext;
  account: LarkAccount;
  accountScopedCfg: ClawdbotConfig;
  runtime?: RuntimeEnv;
  commandAuthorized?: boolean;
}): DispatchContext {
  const { ctx, account, accountScopedCfg } = params;

  const runtime = ensureRuntime(params.runtime);
  const log = runtime.log;
  const error = runtime.error;
  const isGroup = ctx.chatType === 'group';
  const isThread = isGroup && Boolean(ctx.threadId);
  const core = LarkClient.runtime;

  const feishuFrom = `feishu:${ctx.senderId}`;
  const feishuTo = isGroup ? `chat:${ctx.chatId}` : `user:${ctx.senderId}`;

  const envelopeFrom = isGroup ? `${ctx.chatId}:${ctx.senderId}` : ctx.senderId;

  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(accountScopedCfg);

  // ---- Route resolution ----
  const route = core.channel.routing.resolveAgentRoute({
    cfg: accountScopedCfg,
    channel: 'feishu',
    accountId: account.accountId,
    peer: {
      kind: isGroup ? 'group' : 'direct',
      id: isGroup ? ctx.chatId : ctx.senderId,
    },
  });

  // ---- System event ----
  const sender = ctx.senderName ? `${ctx.senderName} (${ctx.senderId})` : ctx.senderId;
  const location = isGroup ? `group ${ctx.chatId}` : 'DM';

  const tags: string[] = [];
  tags.push(`msg:${ctx.messageId}`);
  if (ctx.parentId) tags.push(`reply_to:${ctx.parentId}`);
  if (ctx.contentType !== 'text') tags.push(ctx.contentType);
  if (ctx.mentions.some((m) => m.isBot)) tags.push('@bot');
  if (ctx.threadId) tags.push(`thread:${ctx.threadId}`);
  if (ctx.resources.length > 0) {
    tags.push(`${ctx.resources.length} attachment(s)`);
  }
  const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';

  core.system.enqueueSystemEvent(`Feishu[${account.accountId}] ${location} | ${sender}${tagStr}`, {
    sessionKey: route.sessionKey,
    contextKey: `feishu:message:${ctx.chatId}:${ctx.messageId}`,
  });

  return {
    ctx,
    accountScopedCfg,
    account,
    runtime,
    log,
    error,
    core,
    isGroup,
    isThread,
    feishuFrom,
    feishuTo,
    envelopeFrom,
    envelopeOptions,
    route,
    threadSessionKey: undefined,
    commandAuthorized: params.commandAuthorized,
  };
}

// ---------------------------------------------------------------------------
// Thread session resolution
// ---------------------------------------------------------------------------

/**
 * Resolve thread session key for thread-capable groups.
 *
 * Returns a thread-scoped session key when ALL conditions are met:
 *   1. `threadSession` config is enabled on the account
 *   2. The group is a topic group (chat_mode=topic) or uses thread
 *      message mode (group_message_type=thread)
 *
 * The group info is fetched via `im.chat.get` with a 1-hour LRU cache
 * to minimise OAPI calls.
 */
export async function resolveThreadSessionKey(params: {
  accountScopedCfg: ClawdbotConfig;
  account: LarkAccount;
  chatId: string;
  threadId: string;
  baseSessionKey: string;
}): Promise<string | undefined> {
  const { accountScopedCfg, account, chatId, threadId, baseSessionKey } = params;

  if (account.config?.threadSession !== true) return undefined;

  const threadCapable = await isThreadCapableGroup({
    cfg: accountScopedCfg,
    chatId,
    accountId: account.accountId,
  });
  if (!threadCapable) {
    log.info(`thread session skipped: group ${chatId} is not topic/thread mode`);
    return undefined;
  }

  // 使用 SDK 标准函数，保证分隔符格式与 resolveThreadParentSessionKey 兼容
  const { sessionKey } = resolveThreadSessionKeys({
    baseSessionKey,
    threadId,
    parentSessionKey: baseSessionKey,
    normalizeThreadId: (id) => id, // 飞书 thread ID (omt_xxx) 区分大小写，不做 lowercase
  });
  return sessionKey;
}
