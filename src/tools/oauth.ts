/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_oauth tool — User OAuth authorisation management.
 *
 * Actions:
 *   - authorize : Initiate Device Flow, send auth card, poll for token.
 *   - status    : Check whether the current user has a valid UAT.
 *   - revoke    : Remove the current user's stored UAT.
 *
 * Security:
 *   - **Does not** accept a `user_open_id` parameter.  The target user is
 *     always the message sender, obtained from the LarkTicket.
 *   - Token values are never included in the return payload (AI cannot see
 *     them).
 */

import type { OpenClawPluginApi, ClawdbotConfig } from 'openclaw/plugin-sdk';
import type { ConfiguredLarkAccount } from '../core/types';
import { Type } from '@sinclair/typebox';
import { getLarkAccount } from '../core/accounts';
import { assertOwnerAccessStrict, OwnerAccessDeniedError } from '../core/owner-policy';
import { LarkClient } from '../core/lark-client';
import { getAppGrantedScopes } from '../core/app-scope-checker';
import type { LarkTicket } from '../core/lark-ticket';
import { getTicket, withTicket } from '../core/lark-ticket';
import { larkLogger } from '../core/lark-logger';

const log = larkLogger('tools/oauth');
import { handleFeishuMessage } from '../messaging/inbound/handler';
import { formatLarkError } from '../core/api-error';
import { enqueueFeishuChatTask } from '../channel/chat-queue';
import { requestDeviceAuthorization, pollDeviceToken } from '../core/device-flow';
import { getStoredToken, setStoredToken, tokenStatus, type StoredUAToken } from '../core/token-store';
import { revokeUAT } from '../core/uat-client';
import { createCardEntity, sendCardByCardId, updateCardKitCardForAuth } from '../card/cardkit';
import { buildAuthCard, buildAuthSuccessCard, buildAuthFailedCard, buildAuthIdentityMismatchCard } from './oauth-cards';
import { json, registerTool } from './oapi/helpers';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuOAuthSchema = Type.Object(
  {
    action: Type.Union(
      [
        // Type.Literal("authorize"),  // 已由 auto-auth 自动处理，不再对外暴露
        Type.Literal('revoke'),
      ],
      {
        description: 'revoke: 撤销当前用户已保存的授权凭据',
      },
    ),
  },
  {
    description:
      '飞书用户撤销授权工具。' +
      '仅在用户明确说"撤销授权"、"取消授权"、"退出登录"、"清除授权"时调用。' +
      '【严禁调用场景】用户说"重新授权"、"发起授权"、"重新发起"、"授权失败"、"授权过期"时，绝对不要调用此工具，授权流程由系统自动处理。',
  },
);

interface FeishuOAuthParams {
  action: 'revoke';
}

// ---------------------------------------------------------------------------
// In-flight authorize guard (prevent duplicate device-flows per user)
// ---------------------------------------------------------------------------

interface PendingFlow {
  controller: AbortController;
  cardId: string;
  sequence: number;
  messageId: string;
  /** 被新流替换后标记为 true，旧轮询回调检测到后跳过卡片更新 */
  superseded: boolean;
  /** 当前 flow 请求的 scope（空格分隔），用于后续 scope 合并 */
  scope?: string;
}

const pendingFlows = new Map<string, PendingFlow>();

// ---------------------------------------------------------------------------
// Identity verification after Device Flow
// ---------------------------------------------------------------------------

/**
 * 使用刚获取的 UAT 调用 /authen/v1/user_info，
 * 验证实际完成 OAuth 授权的用户 open_id 是否与预期的 senderOpenId 一致。
 *
 * 防止群聊中其他用户点击授权链接后，错误的 UAT 被绑定到 owner 的身份。
 */
async function verifyTokenIdentity(
  brand: string,
  accessToken: string,
  expectedOpenId: string,
): Promise<{ valid: boolean; actualOpenId?: string }> {
  const domain = brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  const url = `${domain}/open-apis/authen/v1/user_info`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = (await res.json()) as {
      code?: number;
      msg?: string;
      data?: { open_id?: string };
    };
    if (data.code !== 0) {
      log.warn(`user_info API error: code=${data.code}, msg=${data.msg}`);
      return { valid: false };
    }
    const actualOpenId = data.data?.open_id;
    if (!actualOpenId) {
      log.warn('user_info API returned no open_id');
      return { valid: false };
    }
    return {
      valid: actualOpenId === expectedOpenId,
      actualOpenId,
    };
  } catch (err) {
    log.warn(`identity verification request failed: ${err}`);
    return { valid: false };
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFeishuOAuthTool(api: OpenClawPluginApi) {
  if (!api.config) return;

  const cfg = api.config;

  registerTool(
    api,
    {
      name: 'feishu_oauth',
      label: 'Feishu OAuth',
      description:
        '飞书用户撤销授权工具。' +
        '仅在用户明确说"撤销授权"、"取消授权"、"退出登录"、"清除授权"时调用 revoke。' +
        '【严禁调用场景】用户说"重新授权"、"发起授权"、"重新发起"、"授权失败"、"授权过期"时，绝对不要调用此工具，授权流程由系统自动处理，无需人工干预。' +
        '不需要传入 user_open_id，系统自动从消息上下文获取当前用户。',
      parameters: FeishuOAuthSchema,

      async execute(_toolCallId: string, params: unknown) {
        const p = params as FeishuOAuthParams;

        // Resolve identity from trace context (set in monitor.ts).
        const ticket = getTicket();
        const senderOpenId = ticket?.senderOpenId;
        if (!senderOpenId) {
          return json({
            error: '无法获取当前用户身份（senderOpenId），请在飞书对话中使用此工具。',
          });
        }

        // Use the accountId from LarkTicket to resolve the correct account
        // (important for multi-account setups like prod + boe).
        const acct = getLarkAccount(cfg, ticket.accountId);
        if (!acct.configured) {
          return json({
            error: `账号 ${ticket.accountId} 缺少 appId 或 appSecret 配置`,
          });
        }
        const account = acct; // Now we know it's ConfiguredLarkAccount

        try {
          switch (p.action) {
            // ---------------------------------------------------------------
            // AUTHORIZE — 已由 auto-auth 自动处理，此分支不再对外暴露
            // ---------------------------------------------------------------
            // case "authorize": {
            //   return await executeAuthorize({
            //     account,
            //     senderOpenId,
            //     scope: p.scope || "",
            //     isBatchAuth: false,
            //     cfg,
            //     ticket,
            //   });
            // }

            // ---------------------------------------------------------------
            // STATUS
            // ---------------------------------------------------------------
            // case "status": {
            //   const status = await getUATStatus(account.appId, senderOpenId);
            //   return json({
            //     authorized: status.authorized,
            //     scope: status.scope,
            //     token_status: status.tokenStatus,
            //     granted_at: status.grantedAt
            //       ? new Date(status.grantedAt).toISOString()
            //       : undefined,
            //     expires_at: status.expiresAt
            //       ? new Date(status.expiresAt).toISOString()
            //       : undefined,
            //   });
            // }

            // ---------------------------------------------------------------
            // REVOKE
            // ---------------------------------------------------------------
            case 'revoke': {
              await revokeUAT(account.appId, senderOpenId);
              return json({ success: true, message: '用户授权已撤销。' });
            }

            default:
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              return json({ error: `未知操作: ${(p as any).action}` });
          }
        } catch (err) {
          log.error(`${p.action} failed: ${err}`);
          return json({ error: formatLarkError(err) });
        }
      },
    },
    { name: 'feishu_oauth' },
  );

  api.logger.debug?.('feishu_oauth: Registered feishu_oauth tool');
}

// ---------------------------------------------------------------------------
// Shared authorize logic (used by both feishu_oauth and feishu_oauth_batch_auth)
// ---------------------------------------------------------------------------

export interface ExecuteAuthorizeParams {
  account: ConfiguredLarkAccount;
  senderOpenId: string;
  scope: string;
  isBatchAuth?: boolean;
  totalAppScopes?: number;
  alreadyGranted?: number;
  batchInfo?: string; // 分批授权提示信息
  skipSyntheticMessage?: boolean; // true 时跳过合成消息发送（onboarding 场景）
  showBatchAuthHint?: boolean; // true 时在授权卡片底部展示"授予所有用户权限"提示（仅 auto-auth 流程）
  forceAuth?: boolean; // true 时跳过本地 token 缓存检查，强制发起新 Device Flow（AppScopeMissing 场景专用）
  onAuthComplete?: () => void | Promise<void>; // 授权完成回调（用于批量授权链式触发）
  cfg: ClawdbotConfig;
  ticket: LarkTicket | undefined;
}

/**
 * 执行 OAuth 授权流程（Device Flow）
 * 可被 feishu_oauth 和 feishu_oauth_batch_auth 共享调用
 */
export async function executeAuthorize(
  params: ExecuteAuthorizeParams,
): Promise<{ content: Array<{ type: 'text'; text: string }>; details: unknown }> {
  const {
    account,
    senderOpenId,
    scope,
    isBatchAuth,
    totalAppScopes,
    alreadyGranted,
    batchInfo,
    skipSyntheticMessage,
    showBatchAuthHint,
    forceAuth,
    onAuthComplete,
    cfg,
    ticket,
  } = params;
  const { appId, appSecret, brand, accountId } = account;

  // 0. Check if the user is the app owner (fail-close: 安全优先).
  const sdk = LarkClient.fromAccount(account).sdk;
  try {
    await assertOwnerAccessStrict(account, sdk, senderOpenId);
  } catch (err) {
    if (err instanceof OwnerAccessDeniedError) {
      log.warn(`non-owner user ${senderOpenId} attempted to authorize`);
      return json({
        error: 'permission_denied',
        message: '当前应用仅限所有者（App Owner）使用。您没有权限发起授权，无法使用相关功能。',
      });
    }
    throw err;
  }

  // effectiveScope：可变 scope 变量，后续可能因 pendingFlow 合并而扩大
  let effectiveScope = scope;

  // 1. Check if user already authorised + scope coverage.
  // forceAuth=true 时跳过缓存检查，直接发起新 Device Flow。
  // 用于 AppScopeMissing 场景：应用权限刚被移除再补回，本地 UAT 缓存的 scope 状态不可信。
  const existing = forceAuth ? null : await getStoredToken(appId, senderOpenId);
  if (existing && tokenStatus(existing) !== 'expired') {
    // 如果请求了特定 scope，检查是否已覆盖
    if (effectiveScope) {
      const requestedScopes = effectiveScope.split(/\s+/).filter(Boolean);
      const grantedScopes = new Set((existing.scope ?? '').split(/\s+/).filter(Boolean));
      const missingScopes = requestedScopes.filter((s) => !grantedScopes.has(s));

      if (missingScopes.length > 0) {
        // scope 不足 → 继续走 Device Flow（飞书 OAuth 是增量授权）
        log.info(`existing token missing scopes [${missingScopes.join(', ')}], starting incremental auth`);
        // 不 revoke 旧 token，直接用缺失的 scope 发起新 Device Flow
        // 飞书会累积授权，新 token 包含旧 + 新 scope
        // 继续执行下面的 Device Flow 逻辑
      } else {
        if (onAuthComplete) {
          try {
            await onAuthComplete();
          } catch (e) {
            log.warn(`onAuthComplete failed: ${e}`);
          }
        }
        return json({
          success: true,
          message: '用户已授权，scope 已覆盖。',
          authorized: true,
          scope: existing.scope,
        });
      }
    } else {
      if (onAuthComplete) {
        try {
          await onAuthComplete();
        } catch (e) {
          log.warn(`onAuthComplete failed: ${e}`);
        }
      }
      return json({
        success: true,
        message: '用户已授权，无需重复授权。',
        authorized: true,
        scope: existing!.scope,
      });
    }
  }

  // 2. Guard against duplicate in-flight flows for this user.
  const flowKey = `${appId}:${senderOpenId}`;
  let reuseCardId: string | undefined;
  let reuseSeq = 0;

  if (pendingFlows.has(flowKey)) {
    const oldFlow = pendingFlows.get(flowKey)!;
    const currentMessageId = ticket?.messageId ?? '';

    if (oldFlow.messageId === currentMessageId) {
      // 同一轮工具调用（messageId 相同）→ 复用旧卡片
      oldFlow.superseded = true;
      oldFlow.controller.abort();
      reuseCardId = oldFlow.cardId;
      reuseSeq = oldFlow.sequence;
      pendingFlows.delete(flowKey);

      // scope 合并：将旧 flow 的 scope 与新请求合并
      if (oldFlow.scope) {
        const oldScopes = oldFlow.scope.split(/\s+/).filter(Boolean);
        const newScopes = effectiveScope?.split(/\s+/).filter(Boolean) ?? [];
        const merged = new Set([...oldScopes, ...newScopes]);
        effectiveScope = [...merged].join(' ');
        log.info(`scope merge on reuse: [${[...merged].join(', ')}]`);
      }

      log.info(`same message, replacing flow for user=${senderOpenId}, app=${appId}, reusing cardId=${reuseCardId}`);
    } else {
      // 新对话（messageId 不同）→ 取消旧流 + 旧卡片标记"授权未完成" + 创建新卡片
      oldFlow.superseded = true;
      oldFlow.controller.abort();
      pendingFlows.delete(flowKey);
      log.info(`new message, cancelling old flow for user=${senderOpenId}, app=${appId}, old cardId=${oldFlow.cardId}`);
      // 标记旧卡片为"授权未完成"
      try {
        await updateCardKitCardForAuth({
          cfg,
          cardId: oldFlow.cardId,
          card: buildAuthFailedCard('新的授权请求已发起'),
          sequence: oldFlow.sequence + 1,
          accountId,
        });
      } catch (e) {
        log.warn(`failed to update old card to expired: ${e}`);
      }
      // reuseCardId 保持 undefined，后续会创建新卡片
    }
  }

  // 2.5 应用 scope 预检：过滤掉应用未开通的 scope
  let filteredScope = effectiveScope;
  let unavailableScopes: string[] = [];

  if (effectiveScope) {
    try {
      const sdk = LarkClient.fromAccount(account).sdk;
      const requestedScopes = effectiveScope.split(/\s+/).filter(Boolean);
      const appScopes = await getAppGrantedScopes(sdk, appId, 'user');

      const availableScopes = requestedScopes.filter((s) => appScopes.includes(s));
      unavailableScopes = requestedScopes.filter((s) => !appScopes.includes(s));

      if (unavailableScopes.length > 0) {
        log.info(`app has not granted scopes [${unavailableScopes.join(', ')}], filtering them out`);

        if (availableScopes.length === 0) {
          // 所有 scope 都未开通，直接返回错误
          const openDomain = brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
          const permissionUrl = `${openDomain}/app/${appId}/permission`;
          return json({
            error: 'app_scopes_not_granted',
            message: `应用未开通任何请求的用户权限，无法发起授权。请先在开放平台开通以下权限：\n${unavailableScopes.map((s) => `- ${s}`).join('\n')}\n\n权限管理地址：${permissionUrl}`,
            unavailable_scopes: unavailableScopes,
            app_permission_url: permissionUrl,
          });
        }

        // 部分 scope 未开通，只授权已开通的 scope
        filteredScope = availableScopes.join(' ');
        log.info(`proceeding with available scopes [${availableScopes.join(', ')}]`);
      }
    } catch (err) {
      // 如果 scope 检查失败，记录日志但继续执行（降级处理）
      log.warn(`failed to check app scopes, proceeding anyway: ${err}`);
    }
  }

  // 3. Request device authorisation.
  const deviceAuth = await requestDeviceAuthorization({
    appId,
    appSecret,
    brand,
    scope: filteredScope,
  });

  // 4. Build and send authorisation card.
  const authCard = buildAuthCard({
    verificationUriComplete: deviceAuth.verificationUriComplete,
    expiresMin: Math.round(deviceAuth.expiresIn / 60),
    scope: filteredScope, // 使用过滤后的 scope
    isBatchAuth,
    totalAppScopes,
    alreadyGranted,
    batchInfo,
    filteredScopes: unavailableScopes.length > 0 ? unavailableScopes : undefined,
    appId,
    showBatchAuthHint,
    brand,
  });

  let cardId: string;
  let seq: number;
  const chatId = ticket?.chatId;
  if (!chatId || !ticket) {
    return json({ error: '无法确定发送目标' });
  }

  if (reuseCardId) {
    // 复用旧卡片：原地更新内容（scope + 授权链接），不创建新卡片
    const newSeq = reuseSeq + 1;
    try {
      await updateCardKitCardForAuth({
        cfg,
        cardId: reuseCardId,
        card: authCard,
        sequence: newSeq,
        accountId,
      });
      log.info(`updated existing card ${reuseCardId} with merged scopes, seq=${newSeq}`);
    } catch (err) {
      log.warn(`failed to update existing card, creating new one: ${err}`);
      // 降级：创建新卡片
      const newCardId = await createCardEntity({ cfg, card: authCard, accountId });
      if (!newCardId) return json({ error: '创建授权卡片失败' });
      if (chatId) {
        await sendCardByCardId({
          cfg,
          to: chatId,
          cardId: newCardId,
          replyToMessageId: ticket?.messageId?.startsWith('om_') ? ticket.messageId : undefined,
          replyInThread: Boolean(ticket?.threadId),
          accountId,
        });
      }
      cardId = newCardId;
      seq = 1;
      reuseCardId = undefined;
    }
    if (reuseCardId) {
      cardId = reuseCardId;
      seq = newSeq;
    } else {
      cardId = cardId!;
      seq = seq!;
    }
  } else {
    // 首次创建卡片
    const newCardId = await createCardEntity({ cfg, card: authCard, accountId });
    if (!newCardId) {
      return json({ error: '创建授权卡片失败' });
    }

    await sendCardByCardId({
      cfg,
      to: chatId,
      cardId: newCardId,
      replyToMessageId: ticket?.messageId?.startsWith('om_') ? ticket.messageId : undefined,
      replyInThread: Boolean(ticket?.threadId),
      accountId,
    });

    cardId = newCardId;
    seq = 1;
  }

  // 7. Start background polling.
  const abortController = new AbortController();

  const currentFlow: PendingFlow = {
    controller: abortController,
    cardId,
    sequence: seq,
    messageId: ticket?.messageId ?? '',
    superseded: false,
    scope: effectiveScope,
  };
  pendingFlows.set(flowKey, currentFlow);
  let pendingFlowDelete = false;
  // Fire-and-forget – polling happens asynchronously.
  pollDeviceToken({
    appId,
    appSecret,
    brand,
    deviceCode: deviceAuth.deviceCode,
    interval: deviceAuth.interval,
    expiresIn: deviceAuth.expiresIn,
    signal: abortController.signal,
  })
    .then(async (result) => {
      // 被新流替换后，跳过所有卡片更新，避免覆盖新流的卡片内容
      if (currentFlow.superseded) {
        log.info(`flow superseded, skipping card update for cardId=${cardId}`);
        return;
      }
      if (result.ok) {
        // ===== 身份校验：验证实际授权用户与发起人一致 =====
        const identity = await verifyTokenIdentity(brand, result.token.accessToken, senderOpenId);
        if (!identity.valid) {
          log.warn(
            `identity mismatch! expected=${senderOpenId}, ` +
              `actual=${identity.actualOpenId ?? 'unknown'}, cardId=${cardId}`,
          );
          try {
            await updateCardKitCardForAuth({
              cfg,
              cardId,
              card: buildAuthIdentityMismatchCard(brand),
              sequence: ++seq,
              accountId,
            });
          } catch (e) {
            log.warn(`failed to update card for identity mismatch: ${e}`);
          }
          pendingFlows.delete(flowKey);
          pendingFlowDelete = true;
          return;
        }
        // ===== 身份校验通过，继续保存 token =====

        // Save token to Keychain.
        const now = Date.now();
        const storedToken: StoredUAToken = {
          userOpenId: senderOpenId,
          appId,
          accessToken: result.token.accessToken,
          refreshToken: result.token.refreshToken,
          expiresAt: now + result.token.expiresIn * 1000,
          refreshExpiresAt: now + result.token.refreshExpiresIn * 1000,
          scope: result.token.scope,
          grantedAt: now,
        };
        await setStoredToken(storedToken);

        // 1. Update card → success immediately so user sees
        //    visual confirmation right away.
        try {
          await updateCardKitCardForAuth({
            cfg,
            cardId,
            card: buildAuthSuccessCard(brand),
            sequence: ++seq,
            accountId,
          });
        } catch (e) {
          log.warn(`failed to update card to success: ${e}`);
        }
        // 删除 pending flow
        pendingFlows.delete(flowKey);
        pendingFlowDelete = true;

        // 2. Send synthetic message to notify AI that auth is
        //    complete, so it can automatically retry the operation.
        //    Skip when called from onboarding (no AI context to retry).
        // 调用 onAuthComplete 回调（用于 onboarding 批量授权链式触发）
        if (onAuthComplete) {
          try {
            await onAuthComplete();
          } catch (e) {
            log.warn(`onAuthComplete failed: ${e}`);
          }
        }

        if (skipSyntheticMessage) {
          log.info('skipSyntheticMessage=true, skipping synthetic message');
        } else
          try {
            // Use a unique message_id for MessageSid (avoids SDK dedup),
            // but pass the real message ID as replyToMessageId so that
            // typing indicators, reply-to threading, and delivery work.
            const syntheticMsgId = `${ticket.messageId}:auth-complete`;

            const syntheticEvent = {
              sender: {
                sender_id: { open_id: senderOpenId },
              },
              message: {
                message_id: syntheticMsgId,
                chat_id: chatId,
                chat_type: ticket.chatType ?? ('p2p' as const),
                message_type: 'text',
                content: JSON.stringify({
                  text: '我已完成飞书账号授权，请继续执行之前的操作。',
                }),
                thread_id: ticket.threadId,
              },
            };

            // Provide a minimal runtime so reply-dispatcher
            // does not crash on `params.runtime.log?.()`.
            const syntheticRuntime = {
              log: (msg: string) => log.info(msg),
              error: (msg: string) => log.error(msg),
            };

            const { status, promise } = enqueueFeishuChatTask({
              accountId,
              chatId,
              threadId: ticket.threadId,
              task: async () => {
                await withTicket(
                  {
                    messageId: syntheticMsgId,
                    chatId,
                    accountId,
                    startTime: Date.now(),
                    senderOpenId,
                    chatType: ticket.chatType,
                    threadId: ticket.threadId,
                  },
                  () =>
                    handleFeishuMessage({
                      cfg,
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      event: syntheticEvent as any,
                      accountId,
                      forceMention: true,
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      runtime: syntheticRuntime as any,
                      replyToMessageId: ticket.messageId,
                    }),
                );
              },
            });

            log.info(`synthetic message queued (${status})`);
            await promise;
            log.info('synthetic message dispatched after successful auth');
          } catch (e) {
            log.warn(`failed to send synthetic message after auth: ${e}`);
          }
      } else {
        // Update card → failure.
        try {
          await updateCardKitCardForAuth({
            cfg,
            cardId,
            card: buildAuthFailedCard(result.message),
            sequence: ++seq,
            accountId,
          });
        } catch (e) {
          log.warn(`failed to update card to failure: ${e}`);
        }
        // 删除 pending flow
        pendingFlows.delete(flowKey);
        pendingFlowDelete = true;
      }
    })
    .catch((err) => {
      log.error(`polling error: ${err}`);
    })
    .finally(() => {
      if (!pendingFlowDelete) {
        // 只在当前 flow 仍是注册的那个时才删除，避免旧流误删新流的 entry
        if (pendingFlows.get(flowKey) === currentFlow) {
          pendingFlows.delete(flowKey);
        }
      }
    });

  const scopeCount = filteredScope.split(/\s+/).filter(Boolean).length;
  let message = isBatchAuth
    ? `已发送批量授权请求卡片，共需授权 ${scopeCount} 个权限。请在卡片中完成授权。`
    : '已发送授权请求卡片，请用户在卡片中点击链接完成授权。授权完成后请重新执行之前的操作。';

  if (batchInfo) {
    message += batchInfo;
  }

  // 如果有被过滤的 scope，添加提示信息
  if (unavailableScopes.length > 0) {
    const openDomain = brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
    const permissionUrl = `${openDomain}/app/${appId}/permission`;
    message += `\n\n⚠️ **注意**：以下权限因应用未开通而被跳过，如需使用请先在开放平台开通：\n${unavailableScopes.map((s) => `- ${s}`).join('\n')}\n\n权限管理地址：${permissionUrl}`;
  }

  const openDomainForResult = brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  return json({
    success: true,
    message,
    awaiting_authorization: true,
    filtered_scopes: unavailableScopes.length > 0 ? unavailableScopes : undefined,
    app_permission_url: unavailableScopes.length > 0 ? `${openDomainForResult}/app/${appId}/permission` : undefined,
  });
}
