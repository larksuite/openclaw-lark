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
import { getSessionBindingService } from 'openclaw/plugin-sdk/conversation-runtime';
import { deriveLastRoutePolicy, resolveAgentIdFromSessionKey, resolveThreadSessionKeys } from 'openclaw/plugin-sdk/routing';
import type { MessageContext } from '../types';
import type { LarkAccount } from '../../core/types';
import { LarkClient } from '../../core/lark-client';
import { larkLogger } from '../../core/lark-logger';
import { isThreadCapableGroup } from '../../core/chat-info-cache';
import { isCommentTarget } from '../../core/comment-target';

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
  /** 此入站会话命中的运行时 ACP/session 绑定。 */
  runtimeBindingId?: string;
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
  const isComment = isCommentTarget(ctx.chatId);
  const isGroup = !isComment && ctx.chatType === 'group';
  const isThread = isGroup && Boolean(ctx.threadId);
  const core = LarkClient.runtime;

  const feishuFrom = `feishu:${ctx.senderId}`;
  // Comment targets use the comment target string directly as the "To"
  // so the outbound routing layer can detect it and route through Drive API.
  const feishuTo = isComment
    ? ctx.chatId
    : isGroup
      ? `chat:${ctx.chatId}`
      : `user:${ctx.senderId}`;

  const envelopeFrom = isGroup ? `${ctx.chatId}:${ctx.senderId}` : ctx.senderId;

  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(accountScopedCfg);

  // ---- Route resolution ----
  // Comment targets use the comment target as the peer ID so each
  // comment thread gets its own session key.
  let route = core.channel.routing.resolveAgentRoute({
    cfg: accountScopedCfg,
    channel: 'feishu',
    accountId: account.accountId,
    peer: isComment
      ? { kind: 'direct' as const, id: ctx.chatId }
      : {
          kind: isGroup ? ('group' as const) : ('direct' as const),
          id: isGroup ? ctx.chatId : ctx.senderId,
      },
  });

  // ACP 命令绑定规范化后的原生会话 ID：私聊为 `user:<open_id>`，群聊为
  // 原始 chat ID，群线程为原生 thread ID。使用 monitor 注册适配器时的同一
  // account ID；命中后替换普通路由。
  const conversationId = isThread ? ctx.threadId : isGroup ? ctx.chatId : `user:${ctx.senderId}`;
  const parentConversationId = isThread ? `chat:${ctx.chatId}` : undefined;
  let runtimeBindingId: string | undefined;

  if (conversationId) {
    const binding = getSessionBindingService().resolveByConversation({
      channel: 'feishu',
      accountId: account.accountId,
      conversationId,
      ...(parentConversationId ? { parentConversationId } : {}),
    });
    const boundSessionKey = binding?.targetSessionKey.trim();

    if (binding && boundSessionKey) {
      route = {
        ...route,
        sessionKey: boundSessionKey,
        agentId: resolveAgentIdFromSessionKey(boundSessionKey) || route.agentId,
        lastRoutePolicy: deriveLastRoutePolicy({
          sessionKey: boundSessionKey,
          mainSessionKey: route.mainSessionKey,
        }),
        matchedBy: 'binding.channel',
      };
      runtimeBindingId = binding.bindingId;
      getSessionBindingService().touch(binding.bindingId);
      log(`feishu[${account.accountId}]: routed via bound conversation ${conversationId} -> ${boundSessionKey}`);
    }
  }

  // ---- System event ----
  const sender = ctx.senderName ? `${ctx.senderName} (${ctx.senderId})` : ctx.senderId;
  const location = isComment ? `comment ${ctx.chatId}` : isGroup ? `group ${ctx.chatId}` : 'DM';

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
    runtimeBindingId,
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
