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
import { resolveThreadSessionKeys } from 'openclaw/plugin-sdk/routing';
import type { MessageContext } from '../types';
import type { LarkAccount } from '../../core/types';
import { LarkClient } from '../../core/lark-client';
import { larkLogger } from '../../core/lark-logger';

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
 * Resolve a thread-scoped session key for any inbound Feishu message that
 * already carries a concrete thread ID.
 *
 * Some Feishu groups surface reply threads in message events even when
 * `im.chat.get` still reports `chat_mode=group` and
 * `group_message_type=chat`. In that case, gating thread isolation on
 * chat metadata causes distinct topics to collapse into the shared group
 * session, which can leak prior topic context into a fresh request.
 *
 * Once the inbound event already provides `threadId`, we should trust the
 * event payload and isolate the session by that thread ID directly.
 */
export async function resolveThreadSessionKey(params: {
  account: LarkAccount;
  threadId: string;
  baseSessionKey: string;
}): Promise<string | undefined> {
  const { account, threadId, baseSessionKey } = params;

  if (account.config?.threadSession !== true) return undefined;

  // 使用 SDK 标准函数，保证分隔符格式与 resolveThreadParentSessionKey 兼容
  const { sessionKey } = resolveThreadSessionKeys({
    baseSessionKey,
    threadId,
    parentSessionKey: baseSessionKey,
    normalizeThreadId: (id) => id, // 飞书 thread ID (omt_xxx) 区分大小写，不做 lowercase
  });
  return sessionKey;
}
