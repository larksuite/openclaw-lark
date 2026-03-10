/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Inbound message handling pipeline for the Lark/Feishu channel plugin.
 *
 * Orchestrates a seven-stage pipeline:
 *   1. Account resolution
 *   2. Event parsing         → parse.ts (merge_forward expanded in-place)
 *   3. Sender enrichment     → enrich.ts (lightweight, before gate)
 *   4. Policy gate           → gate.ts
 *   5. User name prefetch    → enrich.ts (batch cache warm-up)
 *   6. Content resolution    → enrich.ts (media / quote, parallel)
 *   7. Agent dispatch        → dispatch.ts
 */

import type { ClawdbotConfig, RuntimeEnv } from 'openclaw/plugin-sdk';
import {
  recordPendingHistoryEntryIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  resolveSenderCommandAuthorization,
  isNormalizedSenderAllowed,
  type HistoryEntry,
} from 'openclaw/plugin-sdk';
import type { FeishuMessageEvent } from '../types';
import { getLarkAccount } from '../../core/accounts';
import { LarkClient } from '../../core/lark-client';
import { larkLogger } from '../../core/lark-logger';
import { ticketElapsed } from '../../core/lark-ticket';
import { parseMessageEvent } from './parse';
import {
  resolveSenderInfo,
  prefetchUserNames,
  resolveMedia,
  resolveQuotedContent,
  substituteMediaPaths,
} from './enrich';
import { checkMessageGate, readFeishuAllowFromStore, type GateResult } from './gate';
import { dispatchToAgent } from './dispatch';
import { resolveFeishuGroupConfig, splitLegacyGroupAllowFrom } from './policy';
import { threadScopedKey } from '../../channel/chat-queue';

const logger = larkLogger('inbound/handler');

// ---------------------------------------------------------------------------
// Public: handle inbound message
// ---------------------------------------------------------------------------

export async function handleFeishuMessage(params: {
  cfg: ClawdbotConfig;
  event: FeishuMessageEvent;
  botOpenId?: string;
  runtime?: RuntimeEnv;
  chatHistories?: Map<string, HistoryEntry[]>;
  accountId?: string;
  /** Override the message ID used for reply threading (typing indicators,
   *  card replies, etc.).  Useful for synthetic messages whose message_id
   *  is not a real Feishu message ID. */
  replyToMessageId?: string;
  /** When true, skip the policy gate (mention requirement, allowlist).
   *  Used for synthetic messages that are not real user messages. */
  forceMention?: boolean;
  /** When true, skip the typing indicator for this dispatch (e.g. reactions). */
  skipTyping?: boolean;
}): Promise<void> {
  const { cfg, event, botOpenId, runtime, chatHistories, accountId, replyToMessageId, forceMention, skipTyping } =
    params;

  // 1. Account resolution
  const account = getLarkAccount(cfg, accountId);
  const accountFeishuCfg = account.config;

  // ★ 多账号配置隔离：构造 account 级别的 ClawdbotConfig
  //
  //   在多账号场景下，每个 account 可以独立配置 groupPolicy / requireMention
  //   等策略。但 SDK 的 resolveGroupPolicy / resolveRequireMention 等函数从
  //   cfg.channels.feishu 读取配置，而 cfg 是顶层全局配置，不包含 per-account
  //   的覆盖值。
  //
  //   这里将 cfg.channels.feishu 替换为经过 getLarkAccount() 合并后的
  //   accountFeishuCfg（= base config + account override），确保下游所有 SDK 调用
  //   都能正确读取当前 account 的配置。
  const accountScopedCfg: ClawdbotConfig = {
    ...cfg,
    channels: { ...cfg.channels, feishu: accountFeishuCfg },
  };

  const log = runtime?.log ?? ((...args: unknown[]) => logger.info(args.map(String).join(' ')));
  const error = runtime?.error ?? ((...args: unknown[]) => logger.error(args.map(String).join(' ')));

  // 2. Parse event → MessageContext (merge_forward expanded in-place)
  let ctx = await parseMessageEvent(event, botOpenId, {
    cfg: accountScopedCfg,
    accountId: account.accountId,
  });

  // 3. Enrich (lightweight): sender name + permission error tracking
  const { ctx: enrichedCtx, permissionError } = await resolveSenderInfo({
    ctx,
    account,
    log,
  });
  ctx = enrichedCtx;

  log(`feishu[${account.accountId}]: received message from ${ctx.senderId} in ${ctx.chatId} (${ctx.chatType})`);
  logger.info(`received from ${ctx.senderId} in ${ctx.chatId} (${ctx.chatType})`);

  const historyLimit = Math.max(
    0,
    accountFeishuCfg?.historyLimit ?? accountScopedCfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
  );

  // 4. Gate: policy / access-control checks (skipped for synthetic messages)
  const gate = forceMention
    ? ({ allowed: true } as GateResult)
    : await checkMessageGate({ ctx, accountFeishuCfg, account, accountScopedCfg, log });
  if (!gate.allowed) {
    if (gate.reason === 'no_mention') {
      logger.info(`rejected: no bot mention in group ${ctx.chatId}`);
    }
    // Record history entry if the gate produced one (group no-mention case)
    if (gate.historyEntry && chatHistories) {
      const historyKey = threadScopedKey(ctx.chatId, ctx.threadId);
      recordPendingHistoryEntryIfEnabled({
        historyMap: chatHistories,
        historyKey,
        limit: historyLimit,
        entry: gate.historyEntry,
      });
    }
    return;
  }

  // 5. Batch pre-warm user name cache (sender + mentions)
  await prefetchUserNames({ ctx, account, log });

  // 6. Enrich (heavyweight, after gate — parallel where possible)
  const enrichParams = { ctx, accountScopedCfg, account, log };
  const [mediaResult, quotedContent] = await Promise.all([
    resolveMedia(enrichParams),
    resolveQuotedContent(enrichParams),
  ]);

  // 6b. Replace Feishu file-key placeholders in content with local
  //     file paths so the SDK can detect images for native vision and
  //     the AI receives meaningful file references.
  if (mediaResult.mediaList.length > 0) {
    ctx = {
      ...ctx,
      content: substituteMediaPaths(ctx.content, mediaResult.mediaList),
    };
  }

  // 7. Compute commandAuthorized via SDK access group command gating
  const core = LarkClient.runtime;
  const isGroup = ctx.chatType === 'group';
  const dmPolicy = accountFeishuCfg?.dmPolicy ?? 'pairing';

  // Resolve per-group config early — shared by both command authorization
  // and dispatch (step 8).
  const groupConfig = isGroup ? resolveFeishuGroupConfig({ cfg: accountFeishuCfg, groupId: ctx.chatId }) : undefined;
  const defaultGroupConfig = isGroup ? accountFeishuCfg?.groups?.['*'] : undefined;

  // Build the sender allowlist for command authorization in group context.
  // Excludes legacy oc_xxx chat-id entries (group admission, not sender identity).
  //
  // When the explicit group sender policy is "open", pass ["*"] to align
  // command authorization with chat access (if you can chat, you can run
  // commands).  When no policy is configured (undefined fallback), default to
  // allowlist behaviour — only users in accountFeishuCfg.allowFrom (owner list) or
  // an explicit groupAllowFrom/per-group allowFrom can run commands.
  const configuredGroupAllowFrom = (() => {
    if (!isGroup) return undefined;
    // Exclude legacy oc_xxx chat-id entries from groupAllowFrom (sender filter only).
    const { senderAllowFrom } = splitLegacyGroupAllowFrom(accountFeishuCfg?.groupAllowFrom ?? []);
    const senderGroupAllowFrom = senderAllowFrom;
    const perGroupAllowFrom = (groupConfig?.allowFrom ?? []).map(String);
    const defaultSenderAllowFrom =
      !groupConfig && defaultGroupConfig?.allowFrom ? defaultGroupConfig.allowFrom.map(String) : [];
    const combined = [...senderGroupAllowFrom, ...perGroupAllowFrom, ...defaultSenderAllowFrom];
    if (combined.length > 0) return combined;
    // No allowFrom list configured — check if sender policy is explicitly "open".
    // Do NOT fall back to "open" as a default: unset policy → allowlist behaviour.
    const explicitSenderPolicy =
      groupConfig?.groupPolicy ?? defaultGroupConfig?.groupPolicy ?? accountFeishuCfg?.groupPolicy;
    return explicitSenderPolicy === 'open' ? ['*'] : [];
  })();

  const { commandAuthorized } = await resolveSenderCommandAuthorization({
    rawBody: ctx.content,
    cfg: accountScopedCfg,
    isGroup,
    dmPolicy,
    configuredAllowFrom: (accountFeishuCfg?.allowFrom ?? []).map(String),
    configuredGroupAllowFrom,
    senderId: ctx.senderId,
    isSenderAllowed: (senderId, allowFrom) => isNormalizedSenderAllowed({ senderId, allowFrom }),
    readAllowFromStore: () => readFeishuAllowFromStore(account.accountId),
    shouldComputeCommandAuthorized: core.channel.commands.shouldComputeCommandAuthorized,
    resolveCommandAuthorizedFromAuthorizers: core.channel.commands.resolveCommandAuthorizedFromAuthorizers,
  });

  // 8. Dispatch to agent
  // groupConfig and defaultGroupConfig are already resolved above.

  try {
    await dispatchToAgent({
      ctx,
      permissionError,
      mediaPayload: mediaResult.payload,
      quotedContent,
      account,
      accountScopedCfg,
      runtime,
      chatHistories,
      historyLimit,
      replyToMessageId,
      commandAuthorized,
      groupConfig,
      defaultGroupConfig,
      skipTyping,
    });
  } catch (err) {
    error(`feishu[${account.accountId}]: failed to dispatch message: ${String(err)}`);
    logger.error(`dispatch failed: ${String(err)} (elapsed=${ticketElapsed()}ms)`);
  }
}
