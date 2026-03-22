/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * auto-auth.ts — 工具层自动授权处理。
 *
 * 当 OAPI 工具遇到授权问题时，直接在工具层处理，不再让 AI 判断：
 *
 * - UserAuthRequiredError (appScopeVerified=true)
 *   → 直接调用 executeAuthorize 发起 OAuth Device Flow 卡片
 *
 * - UserScopeInsufficientError
 *   → 直接调用 executeAuthorize（使用 missingScopes）
 *
 * - AppScopeMissingError
 *   → 发送应用权限引导卡片；用户点击"我已完成"后：
 *     1. 更新卡片为处理中状态
 *     2. invalidateAppScopeCache
 *     3. 发送中间合成消息告知 AI（"应用权限已确认，正在发起用户授权..."）
 *     4. 调用 executeAuthorize 发起 OAuth Device Flow
 *
 * - 其他情况（AppScopeCheckFailedError、appScopeVerified=false 等）
 *   → 回退到原 handleInvokeError（不触发自动授权）
 *
 * 降级策略（保守）：以下情况均回退到 handleInvokeError：
 * - 无 LarkTicket（非消息场景）
 * - 无 senderOpenId（无法确定授权对象）
 * - 账号未配置（!acct.configured）
 * - 任何步骤抛出异常
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import type { ConfiguredLarkAccount, LarkBrand } from '../core/types';
import type { LarkTicket } from '../core/lark-ticket';
import { getTicket } from '../core/lark-ticket';
import { larkLogger } from '../core/lark-logger';

const log = larkLogger('tools/auto-auth');
import { getLarkAccount } from '../core/accounts';
import { UserAuthRequiredError, UserScopeInsufficientError, AppScopeMissingError } from '../core/tool-client';
import { invalidateAppScopeCache, getAppGrantedScopes, isAppScopeSatisfied } from '../core/app-scope-checker';
import { LarkClient } from '../core/lark-client';
import { createCardEntity, sendCardByCardId, updateCardKitCardForAuth } from '../card/cardkit';
import { executeAuthorize } from './oauth';
import { formatLarkError, json } from './oapi/helpers';
import { getResolvedConfig } from './helpers';
import { OwnerAccessDeniedError } from '../core/owner-policy';
import { enqueueFeishuChatTask } from '../channel/chat-queue';
import { handleFeishuMessage } from '../messaging/inbound/handler';
import { withTicket } from '../core/lark-ticket';

// ---------------------------------------------------------------------------
// Debounce + scope merge — 防抖缓冲区（两阶段）
//
// 工具调用可能是真正并发（50ms 内到达）或被框架序列化（间隔数秒到达）。
// 为同时覆盖两种场景，采用两阶段设计：
//
//   collecting（收集阶段）：50ms 防抖窗口，合并 scope
//   executing（执行阶段）：flushFn 正在运行，后续请求复用同一结果
//
// 从 collecting → executing 转换时不从 Map 中删除 entry，
// 直到 flushFn 完成（resolve / reject）才移除。
// ---------------------------------------------------------------------------

type JsonResult = ReturnType<typeof json>;

/** 缓冲中的授权请求 */
interface AuthBatchEntry {
  phase: 'collecting' | 'executing';
  scopes: Set<string>;
  waiters: Array<{ resolve: (v: JsonResult) => void; reject: (e: unknown) => void }>;
  timer: ReturnType<typeof setTimeout> | null;
  /** flushFn 执行中的 Promise（executing 阶段有值） */
  resultPromise: Promise<JsonResult> | null;
  /** executing 阶段：新 scope 到达时的延迟刷新定时器 */
  updateTimer: ReturnType<typeof setTimeout> | null;
  /** scope 更新的 executeAuthorize 是否正在执行（互斥锁） */
  isUpdating: boolean;
  /** isUpdating 期间又有新 scope 到达，需要再更新一轮 */
  pendingReupdate: boolean;
  /** flushFn 引用，executing 阶段用于 scope 更新时重新调用 */
  flushFn: ((mergedScopes: string[]) => Promise<JsonResult>) | null;
  /** 以下字段来自第一个入队的请求，后续请求复用 */
  account: ConfiguredLarkAccount;
  cfg: ClawdbotConfig;
  ticket: LarkTicket;
}

/**
 * 防抖缓冲区 Map。
 *
 * Key 规则：
 *   用户授权：`user:${accountId}:${senderOpenId}:${messageId}`
 *   应用授权：`app:${accountId}:${chatId}:${messageId}`
 */
const authBatches = new Map<string, AuthBatchEntry>();

/** 防抖窗口（毫秒） */
const AUTH_DEBOUNCE_MS = 50;

/** 用户授权防抖窗口（毫秒）。比 app auth 的 50ms 更长，保证应用权限卡片先发出。 */
const AUTH_USER_DEBOUNCE_MS = 150;

/**
 * Scope 更新防抖窗口（毫秒）。
 * 比初始防抖更长，因为工具调用可能间隔数十到数百毫秒顺序到达。
 * 需要等足够久以收集所有后续到达的 scope 后再一次性更新卡片。
 */
const AUTH_UPDATE_DEBOUNCE_MS = 500;

/**
 * 冷却期（毫秒）。
 * flushFn 执行完毕后，entry 继续保留在 Map 中这么长时间，
 * 防止后续顺序到达的工具调用创建重复卡片。
 */
const AUTH_COOLDOWN_MS = 30_000;

/**
 * 将授权请求入队到防抖缓冲区。
 *
 * 同一 bufferKey 的请求会被合并：
 * - collecting 阶段：scope 集合取并集，共享同一个 flushFn 执行结果
 * - executing 阶段：flushFn 已在运行，后续请求直接复用已有结果（不重复发卡片）
 *
 * @param bufferKey - 缓冲区 key（区分不同用户/会话）
 * @param scopes - 本次请求需要的 scope 列表
 * @param ctx - 上下文信息（仅第一个请求的被采用）
 * @param flushFn - 定时器到期后执行的实际授权函数，接收合并后的 scope 数组
 */
function enqueueAuthRequest(
  bufferKey: string,
  scopes: string[],
  ctx: { account: ConfiguredLarkAccount; cfg: ClawdbotConfig; ticket: LarkTicket },
  flushFn: (mergedScopes: string[]) => Promise<JsonResult>,
  debounceMs: number = AUTH_DEBOUNCE_MS,
): Promise<JsonResult> {
  const existing = authBatches.get(bufferKey);

  if (existing) {
    // 不论哪个阶段，都追加 scope
    for (const s of scopes) existing.scopes.add(s);

    if (existing.phase === 'executing') {
      // flushFn 已在执行或已完成（卡片已发出），复用结果
      // 同时触发延迟刷新：用合并后的 scope 重新调用 flushFn 更新卡片
      log.info(`auth in-flight, piggyback → key=${bufferKey}, scopes=[${[...existing.scopes].join(', ')}]`);

      // 防抖 + 互斥：多个快速到达的请求只触发一次卡片更新
      if (existing.updateTimer) clearTimeout(existing.updateTimer);
      existing.updateTimer = setTimeout(async () => {
        existing.updateTimer = null;

        // 互斥：如果上一轮更新还在执行，标记 pendingReupdate 等它结束后重跑
        if (existing.isUpdating) {
          existing.pendingReupdate = true;
          log.info(`scope update deferred (previous update still running) → key=${bufferKey}`);
          return;
        }

        existing.isUpdating = true;
        try {
          const mergedScopes = [...existing.scopes];
          log.info(`scope update flush → key=${bufferKey}, scopes=[${mergedScopes.join(', ')}]`);
          // 重新调用 flushFn（executeAuthorize 会检测到 pendingFlow，
          // 原地更新旧卡片内容 + 重启 Device Flow）
          await existing.flushFn!(mergedScopes);
        } catch (err) {
          log.warn(`scope update failed: ${err}`);
        } finally {
          existing.isUpdating = false;
          // 如果锁定期间有新 scope 到达，再跑一轮
          if (existing.pendingReupdate) {
            existing.pendingReupdate = false;
            const finalScopes = [...existing.scopes];
            log.info(`scope reupdate → key=${bufferKey}, scopes=[${finalScopes.join(', ')}]`);
            try {
              await existing.flushFn!(finalScopes);
            } catch (err) {
              log.warn(`scope reupdate failed: ${err}`);
            }
          }
        }
      }, AUTH_UPDATE_DEBOUNCE_MS);

      return existing.resultPromise!;
    }

    // collecting 阶段：正常合并
    log.info(`debounce merge → key=${bufferKey}, scopes=[${[...existing.scopes].join(', ')}]`);
    return new Promise<JsonResult>((resolve, reject) => {
      existing.waiters.push({ resolve, reject });
    });
  }

  // 创建新缓冲区（collecting 阶段）
  const entry: AuthBatchEntry = {
    phase: 'collecting',
    scopes: new Set(scopes),
    waiters: [],
    timer: null,
    resultPromise: null,
    updateTimer: null,
    isUpdating: false,
    pendingReupdate: false,
    flushFn: null,
    account: ctx.account,
    cfg: ctx.cfg,
    ticket: ctx.ticket,
  };

  const promise = new Promise<JsonResult>((resolve, reject) => {
    entry.waiters.push({ resolve, reject });
  });

  entry.timer = setTimeout(async () => {
    // 转入 executing 阶段（不从 Map 中删除，阻止后续请求创建新卡片）
    entry.phase = 'executing';
    entry.timer = null;
    entry.flushFn = flushFn; // 保存引用，供 executing 阶段 scope 更新时重新调用
    const mergedScopes = [...entry.scopes];

    log.info(
      `debounce flush → key=${bufferKey}, ` + `waiters=${entry.waiters.length}, scopes=[${mergedScopes.join(', ')}]`,
    );

    // 将 flushFn 的 Promise 存入 entry，供 executing 阶段的后来者复用
    entry.resultPromise = flushFn(mergedScopes);

    try {
      const result = await entry.resultPromise;
      for (const w of entry.waiters) w.resolve(result);
    } catch (err) {
      for (const w of entry.waiters) w.reject(err);
    } finally {
      // 进入冷却期：entry 继续留在 Map 中，后续到达的工具调用
      // 会命中 executing 分支并复用 resultPromise，不会创建新卡片。
      // 冷却期结束后清理。
      setTimeout(() => authBatches.delete(bufferKey), AUTH_COOLDOWN_MS);
    }
  }, debounceMs);

  authBatches.set(bufferKey, entry);
  return promise;
}

// ---------------------------------------------------------------------------
// PendingAppAuthFlow — 等待用户确认的应用权限引导流程
// ---------------------------------------------------------------------------

interface PendingAppAuthFlow {
  appId: string;
  accountId: string;
  cardId: string;
  sequence: number;
  requiredScopes: string[];
  /** 与触发 AppScopeMissingError 时的 scopeNeedType 一致。 */
  scopeNeedType?: 'one' | 'all';
  /** 与触发 AppScopeMissingError 时的 tokenType 一致。 */
  tokenType?: 'user' | 'tenant';
  cfg: ClawdbotConfig;
  ticket: LarkTicket;
}

/** TTL：15 分钟后自动清理，防止内存泄漏。 */
const PENDING_FLOW_TTL_MS = 15 * 60 * 1000;

/** 计算去重 key（chatId + messageId + 有序 scopes）。 */
function makeDedupKey(chatId: string, messageId: string, scopes: string[]): string {
  return chatId + '\0' + messageId + '\0' + [...scopes].sort().join(',');
}

/** 注册后的 flow，附加索引键信息 */
type RegisteredFlow = PendingAppAuthFlow & {
  dedupKey: string;
  activeCardKey: string;
};

/**
 * 应用权限授权流管理器 — 统一管理三个关联索引的一致性。
 *
 * 替代原来散布的 pendingAppAuthFlows / dedupIndex / activeAppCardIndex 三个 Map，
 * 确保注册、删除、迁移操作的原子性。
 */
class AppAuthFlowManager {
  private readonly flows = new Map<string, RegisteredFlow>();
  private readonly dedupIndex = new Map<string, string>();
  private readonly activeCardIndex = new Map<string, string>();

  /** 原子注册新流程（同时写入 3 个索引 + 设置统一 TTL） */
  register(operationId: string, flow: PendingAppAuthFlow, dedupKey: string, activeCardKey: string): void {
    const registered: RegisteredFlow = { ...flow, dedupKey, activeCardKey };
    this.flows.set(operationId, registered);
    this.dedupIndex.set(dedupKey, operationId);
    this.activeCardIndex.set(activeCardKey, operationId);

    // 统一 TTL 清理
    setTimeout(() => {
      if (!this.flows.has(operationId)) return; // 已被手动清理，跳过
      this.remove(operationId);
    }, PENDING_FLOW_TTL_MS);
  }

  /** 只需 operationId 即可原子清理所有索引 */
  remove(operationId: string): void {
    const flow = this.flows.get(operationId);
    if (!flow) return;

    // 联动清理延迟用户授权队列（防止内存泄漏）
    if (flow.ticket?.senderOpenId) {
      const deferKey = `${flow.accountId}:${flow.ticket.senderOpenId}:${flow.ticket.messageId}`;
      deferredUserAuth.delete(deferKey);
    }

    this.flows.delete(operationId);
    // 条件删除：防止误删已被新 flow 覆盖的索引
    if (this.dedupIndex.get(flow.dedupKey) === operationId) {
      this.dedupIndex.delete(flow.dedupKey);
    }
    if (this.activeCardIndex.get(flow.activeCardKey) === operationId) {
      this.activeCardIndex.delete(flow.activeCardKey);
    }
  }

  /**
   * 迁移到新 operationId（卡片复用场景：按钮回调需要匹配新 ID）。
   * 原子操作：清理旧索引 → 更新 flow → 建立新索引 → 注册新 TTL。
   *
   * 修复原代码卡片复用路径缺少 TTL 注册导致的内存泄漏。
   */
  migrateToNewOperationId(
    oldOperationId: string,
    newOperationId: string,
    updates?: { dedupKey?: string; requiredScopes?: string[]; scopeNeedType?: 'one' | 'all' },
  ): RegisteredFlow | undefined {
    const flow = this.flows.get(oldOperationId);
    if (!flow) return undefined;

    // 清理旧索引
    this.flows.delete(oldOperationId);
    if (updates?.dedupKey) {
      if (this.dedupIndex.get(flow.dedupKey) === oldOperationId) {
        this.dedupIndex.delete(flow.dedupKey);
      }
      flow.dedupKey = updates.dedupKey;
    }
    if (updates?.requiredScopes) flow.requiredScopes = updates.requiredScopes;
    if (updates?.scopeNeedType) flow.scopeNeedType = updates.scopeNeedType;

    // 建立新索引
    this.flows.set(newOperationId, flow);
    this.dedupIndex.set(flow.dedupKey, newOperationId);
    this.activeCardIndex.set(flow.activeCardKey, newOperationId);

    // 为新 operationId 注册 TTL（修复原代码的内存泄漏）
    setTimeout(() => {
      if (!this.flows.has(newOperationId)) return;
      this.remove(newOperationId);
    }, PENDING_FLOW_TTL_MS);

    return flow;
  }

  /** 通过 operationId 查询（card action 回调用） */
  getByOperationId(id: string): PendingAppAuthFlow | undefined {
    return this.flows.get(id);
  }

  /** 通过去重键查询（避免发送重复卡片） */
  getByDedupKey(key: string): { operationId: string; flow: PendingAppAuthFlow } | undefined {
    const opId = this.dedupIndex.get(key);
    if (!opId) return undefined;
    const flow = this.flows.get(opId);
    return flow ? { operationId: opId, flow } : undefined;
  }

  /** 通过活跃卡片键查询（同消息卡片复用） */
  getByActiveCardKey(key: string): { operationId: string; flow: RegisteredFlow } | undefined {
    const opId = this.activeCardIndex.get(key);
    if (!opId) return undefined;
    const flow = this.flows.get(opId);
    return flow ? { operationId: opId, flow } : undefined;
  }
}

const appAuthFlows = new AppAuthFlowManager();

// ---------------------------------------------------------------------------
// Deferred User Auth Queue — 用户授权延迟队列
//
// 当用户授权请求到达时，如果同一消息上下文存在未完成的应用权限流程，
// 将 scope 收集到延迟队列，等应用授权完成后统一发起 OAuth。
// ---------------------------------------------------------------------------

interface DeferredUserAuthEntry {
  scopes: Set<string>;
  account: ConfiguredLarkAccount;
  cfg: ClawdbotConfig;
  ticket: LarkTicket;
}

/** 延迟用户授权队列。Key: `${accountId}:${senderOpenId}:${messageId}` */
const deferredUserAuth = new Map<string, DeferredUserAuthEntry>();

/**
 * 检查指定消息上下文是否有未完成的应用权限授权流程。
 * 检查两个来源：
 *   1. authBatches 中的 app auth entry（collecting/executing 阶段）
 *   2. appAuthFlows 中的活跃流（卡片已发送，等待用户点击"已完成"）
 */
function hasActiveAppAuthForMessage(ticket: LarkTicket): boolean {
  const appKey = `app:${ticket.accountId}:${ticket.chatId}:${ticket.messageId}`;
  const appEntry = authBatches.get(appKey);
  if (appEntry && (appEntry.phase === 'collecting' || appEntry.phase === 'executing')) {
    return true;
  }
  const activeCardKey = `${ticket.chatId}:${ticket.messageId}`;
  return !!appAuthFlows.getByActiveCardKey(activeCardKey);
}

/**
 * 将用户授权 scope 添加到延迟队列。
 * 多个工具调用的 scope 会被合并到同一个 entry。
 */
function addToDeferredUserAuth(
  ticket: LarkTicket,
  scopes: string[],
  account: ConfiguredLarkAccount,
  cfg: ClawdbotConfig,
): void {
  const key = `${ticket.accountId}:${ticket.senderOpenId}:${ticket.messageId}`;
  const existing = deferredUserAuth.get(key);
  if (existing) {
    for (const s of scopes) existing.scopes.add(s);
    log.info(`deferred user auth scope merge → key=${key}, scopes=[${[...existing.scopes].join(', ')}]`);
  } else {
    deferredUserAuth.set(key, { scopes: new Set(scopes), account, cfg, ticket });
    log.info(`deferred user auth created → key=${key}, scopes=[${scopes.join(', ')}]`);
  }
}

// ---------------------------------------------------------------------------
// Card builders — CardKit v2 格式 + i18n_content 多语言
// ---------------------------------------------------------------------------

/** v2 卡片 i18n 配置 */
const I18N_CONFIG = {
  update_multi: true,
  locales: ['zh_cn', 'en_us'],
};

/**
 * 构建应用权限引导卡片。
 *
 * 橙色 header，列出缺失的 scope，提供权限管理链接和"已完成"按钮。
 */
function buildAppScopeMissingCard(params: {
  missingScopes: string[];
  appId?: string;
  operationId: string;
  brand?: LarkBrand;
}): Record<string, unknown> {
  const { missingScopes, appId, operationId, brand } = params;
  const openDomain = brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  const authUrl = appId
    ? `${openDomain}/app/${appId}/auth?q=${encodeURIComponent(missingScopes.join(','))}&op_from=feishu-openclaw&token_type=user`
    : `${openDomain}/`;
  const multiUrl = { url: authUrl, pc_url: '', android_url: '', ios_url: '' };

  const scopeList = missingScopes.map((s) => `• ${s}`).join('\n');

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, ...I18N_CONFIG },
    header: {
      title: {
        tag: 'plain_text',
        content: '🔐 Permissions required to continue',
        i18n_content: {
          zh_cn: '🔐 需要申请权限才能继续',
          en_us: '🔐 Permissions required to continue',
        },
      },
      template: 'orange',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `Please request **all** the following permissions to proceed:\n\n${scopeList}`,
          i18n_content: {
            zh_cn: `调用前，请你先申请以下**所有**权限：\n\n${scopeList}`,
            en_us: `Please request **all** the following permissions to proceed:\n\n${scopeList}`,
          },
          text_size: 'normal',
        },
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: '**Step 1: Request all permissions**',
          i18n_content: {
            zh_cn: '**第一步：申请所有权限**',
            en_us: '**Step 1: Request all permissions**',
          },
          text_size: 'normal',
        },
        {
          tag: 'button',
          text: {
            tag: 'plain_text',
            content: 'Request Now',
            i18n_content: { zh_cn: '去申请', en_us: 'Request Now' },
          },
          type: 'primary',
          multi_url: multiUrl,
        },
        {
          tag: 'markdown',
          content: '**Step 2: Create version and get approval**',
          i18n_content: {
            zh_cn: '**第二步：创建版本并审核通过**',
            en_us: '**Step 2: Create version and get approval**',
          },
          text_size: 'normal',
        },
        {
          tag: 'button',
          text: {
            tag: 'plain_text',
            content: 'Done',
            i18n_content: { zh_cn: '已完成', en_us: 'Done' },
          },
          type: 'default',
          value: { action: 'app_auth_done', operation_id: operationId },
        },
      ],
    },
  };
}

/**
 * 构建应用权限引导卡片的"处理中"状态（用户点击按钮后更新）。
 */
function buildAppAuthProgressCard(): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { wide_screen_mode: false, ...I18N_CONFIG },
    header: {
      title: {
        tag: 'plain_text',
        content: 'Permissions enabled',
        i18n_content: {
          zh_cn: '应用权限已开通',
          en_us: 'Permissions enabled',
        },
      },
      subtitle: { tag: 'plain_text', content: '' },
      template: 'green',
      padding: '12px 12px 12px 12px',
      icon: { tag: 'standard_icon', token: 'yes_filled' },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: 'App permissions ready. Starting user authorization...',
          i18n_content: {
            zh_cn: '你的应用权限已开通，正在为你发起用户授权',
            en_us: 'App permissions ready. Starting user authorization...',
          },
          text_size: 'normal',
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * 发送应用权限引导卡片，并将 flow 存入 pendingAppAuthFlows。
 * 返回工具结果（告知 AI 等待用户操作）。
 */
async function sendAppScopeCard(params: {
  account: ConfiguredLarkAccount;
  missingScopes: string[];
  appId?: string;
  scopeNeedType?: 'one' | 'all';
  tokenType?: 'user' | 'tenant';
  cfg: ClawdbotConfig;
  ticket: LarkTicket;
}): Promise<ReturnType<typeof json>> {
  const { account, missingScopes, appId, scopeNeedType, tokenType, cfg, ticket } = params;
  const { accountId, chatId, messageId } = ticket;
  const activeCardKey = `${chatId}:${messageId}`;

  // ---- 去重：避免并发工具调用时发出多张内容相同的卡片 ----
  const dedup = makeDedupKey(chatId, messageId, missingScopes);
  const existingEntry = appAuthFlows.getByDedupKey(dedup);
  if (existingEntry) {
    log.info(
      `dedup – app-scope card already pending for chatId=${chatId}, ` +
        `scopes=[${missingScopes.join(', ')}], skipping duplicate send`,
    );
    return json({
      awaiting_app_authorization: true,
      message:
        '已向用户发送授权引导卡片，等待用户完成授权操作。' +
        '请告知用户：按照卡片提示完成授权，完成后系统将自动重试之前的操作。' +
        '请等待用户完成卡片操作，不要建议其他替代方案。',
      missing_scopes: missingScopes,
    });
  }

  // ---- 卡片复用：同一 chatId+messageId 已有活跃卡片时，原地更新而非创建新卡片 ----
  const activeEntry = appAuthFlows.getByActiveCardKey(activeCardKey);

  if (activeEntry) {
    const { operationId: activeOpId, flow: activeFlow } = activeEntry;
    // 更新已有卡片的内容（合并后的 scope）
    const newOperationId = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const card = buildAppScopeMissingCard({ missingScopes, appId, operationId: newOperationId, brand: account.brand });
    const newSeq = activeFlow.sequence + 1;

    // TOCTOU 修复：先原子迁移（同步操作），再 await 更新卡片
    const newDedup = makeDedupKey(chatId, messageId, missingScopes);
    const migrated = appAuthFlows.migrateToNewOperationId(activeOpId, newOperationId, {
      dedupKey: newDedup,
      requiredScopes: missingScopes,
      scopeNeedType,
    });
    if (!migrated) {
      // 被其他并发请求抢先迁移了，降级到新建卡片
      log.info(`migrate raced, falling through to new card creation`);
    } else {
      try {
        await updateCardKitCardForAuth({
          cfg,
          cardId: activeFlow.cardId,
          card,
          sequence: newSeq,
          accountId,
        });
        log.info(
          `app-scope card updated in-place, cardId=${activeFlow.cardId}, ` +
            `seq=${newSeq}, scopes=[${missingScopes.join(', ')}]`,
        );

        // 更新 sequence（migrate 不处理 sequence）
        migrated.sequence = newSeq;

        return json({
          awaiting_app_authorization: true,
          message:
            '已向用户发送授权引导卡片，等待用户完成授权操作。' +
            '请告知用户：按照卡片提示完成授权，完成后系统将自动重试之前的操作。' +
            '请等待用户完成卡片操作，不要建议其他替代方案。',
          missing_scopes: missingScopes,
        });
      } catch (err) {
        // 回滚：删除已迁移的 flow
        appAuthFlows.remove(newOperationId);
        log.warn(`failed to update existing app-scope card, creating new one: ${err}`);
        // 降级：走下面的新建卡片路径
      }
    }
  }

  const operationId = Date.now().toString(36) + Math.random().toString(36).slice(2);

  const card = buildAppScopeMissingCard({ missingScopes, appId, operationId, brand: account.brand });

  // 创建 CardKit 卡片实体
  const cardId = await createCardEntity({ cfg, card, accountId });
  if (!cardId) {
    log.warn('createCardEntity failed for app-scope card, falling back');
    return json({
      error: 'app_scope_missing',
      missing_scopes: missingScopes,
      message:
        `应用缺少以下权限：${missingScopes.join(', ')}，` +
        `请管理员在开放平台开通后重试。` +
        (appId ? `\n权限管理：${account.brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'}/app/${appId}/permission` : ''),
    });
  }

  // 发送到当前会话
  const replyToMsgId = ticket.messageId?.startsWith('om_') ? ticket.messageId : undefined;

  await sendCardByCardId({
    cfg,
    to: chatId,
    cardId,
    replyToMessageId: replyToMsgId,
    replyInThread: Boolean(ticket?.threadId),
    accountId,
  });

  // 原子注册到管理器（统一 TTL 清理）
  const flow: PendingAppAuthFlow = {
    appId: appId ?? account.appId,
    accountId,
    cardId,
    sequence: 0,
    requiredScopes: missingScopes,
    scopeNeedType,
    tokenType,
    cfg,
    ticket,
  };
  appAuthFlows.register(operationId, flow, dedup, activeCardKey);

  log.info(`app-scope card sent, operationId=${operationId}, scopes=[${missingScopes.join(', ')}]`);

  return json({
    awaiting_app_authorization: true,
    message:
      '已向用户发送授权引导卡片，等待用户完成授权操作。' +
      '请告知用户：按照卡片提示完成授权，完成后系统将自动重试之前的操作。' +
      '请等待用户完成卡片操作，不要建议其他替代方案。',
    missing_scopes: missingScopes,
  });
}

// ---------------------------------------------------------------------------
// Card action handler (exported for monitor.ts)
// ---------------------------------------------------------------------------

/**
 * 处理 card.action.trigger 回调事件（由 monitor.ts 调用）。
 *
 * 当用户点击应用权限引导卡片的"我已完成，继续授权"按钮时：
 * 1. 更新卡片为"处理中"状态
 * 2. 清除应用 scope 缓存
 * 3. 发送中间合成消息告知 AI
 * 4. 发起 OAuth Device Flow
 *
 * 注意：函数体内的主要逻辑通过 setImmediate + fire-and-forget 异步执行，
 * 确保 Feishu card.action.trigger 回调在 3 秒内返回。
 */
export async function handleCardAction(data: unknown, cfg: ClawdbotConfig, accountId: string): Promise<unknown> {
  let action: string | undefined;
  let operationId: string | undefined;
  let senderOpenId: string | undefined;

  try {
    const event = data as {
      operator?: { open_id?: string };
      action?: { value?: { action?: string; operation_id?: string } };
    };
    action = event.action?.value?.action;
    operationId = event.action?.value?.operation_id;
    senderOpenId = event.operator?.open_id;
  } catch {
    return;
  }

  if (action !== 'app_auth_done' || !operationId) return;

  const flow = appAuthFlows.getByOperationId(operationId);
  if (!flow) {
    log.warn(`card action ${operationId} not found (expired or already handled)`);
    return;
  }

  log.info(`app_auth_done clicked by ${senderOpenId}, operationId=${operationId}`);

  // scope 校验在同步路径完成（3 秒内返回 toast response）
  invalidateAppScopeCache(flow.appId);

  const acct = getLarkAccount(flow.cfg, flow.accountId);
  if (!acct.configured) {
    log.warn(`account ${flow.accountId} not configured, skipping OAuth`);
    return;
  }

  const sdk = LarkClient.fromAccount(acct).sdk;
  let grantedScopes: string[] = [];
  try {
    // 使用与原始 AppScopeMissingError 相同的 tokenType，保证校验逻辑完全一致
    grantedScopes = await getAppGrantedScopes(sdk, flow.appId, flow.tokenType);
  } catch (err) {
    log.warn(`failed to re-check app scopes: ${err}, proceeding anyway`);
  }

  // 使用共享函数 isAppScopeSatisfied，与 tool-client invoke() 逻辑完全一致：
  //   - scopeNeedType "all" → 全部必须有
  //   - 默认"one" → 交集非空即可
  //   - grantedScopes 为空 → 视为满足（API 失败退回服务端判断）
  if (!isAppScopeSatisfied(grantedScopes, flow.requiredScopes, flow.scopeNeedType)) {
    log.warn(`app scopes still missing after user confirmation: [${flow.requiredScopes.join(', ')}]`);
    return {
      toast: {
        type: 'error',
        content: '权限尚未开通，请确认已申请并审核通过后再试',
      },
    };
  }

  log.info(`app scopes verified, proceeding with OAuth`);

  // ★ 在 remove() 之前先取出延迟队列数据，避免 remove() 的联动清理提前删掉它
  const deferKey = flow.ticket.senderOpenId
    ? `${flow.accountId}:${flow.ticket.senderOpenId}:${flow.ticket.messageId}`
    : undefined;
  const consumedDeferred = deferKey ? deferredUserAuth.get(deferKey) : undefined;
  if (consumedDeferred && deferKey) {
    deferredUserAuth.delete(deferKey);
    log.info(`consumed deferred user auth scopes: [${[...consumedDeferred.scopes].join(', ')}]`);
  }

  // 校验通过才删除，防止用户在权限通过前多次点击无法重试
  appAuthFlows.remove(operationId);

  // 通过回调返回值直接更新卡片（方式一：3 秒内立即更新）。
  // 飞书文档要求 card 字段必须包含 type + data 包装：
  //   { card: { type: "raw", data: { schema: "2.0", ... } } }
  // 注意：不能在回调返回前调用 card.update API，飞书文档明确说明
  // "延时更新必须在响应回调请求之后执行，并行执行或提前执行会出现更新失败"。
  const successCard = buildAppAuthProgressCard();

  // 后台异步：回调响应之后再执行 API 更新 + OAuth
  setImmediate(async () => {
    try {
      // 通过 API 再次更新卡片（确保所有查看者都看到更新，不只是点击者）
      try {
        await updateCardKitCardForAuth({
          cfg,
          cardId: flow.cardId,
          card: successCard,
          sequence: flow.sequence + 1,
          accountId,
        });
      } catch (err) {
        log.warn(`failed to update app-scope card to progress via API: ${err}`);
      }

      // 发起 OAuth Device Flow（完成后 executeAuthorize 会自动发合成消息触发 AI 重试）
      if (!flow.ticket.senderOpenId) {
        log.warn('no senderOpenId in ticket, skipping OAuth');
        return;
      }

      // 收集所有来源的 scope（过滤 offline_access：仅 app 级需要，device-flow 自动追加）
      const mergedScopes = new Set(flow.requiredScopes.filter((s) => s !== 'offline_access'));

      // 来源 1: 延迟用户授权队列（已在同步路径中提前取出，见 consumedDeferred）
      if (consumedDeferred) {
        for (const s of consumedDeferred.scopes) mergedScopes.add(s);
      }

      // 来源 2: 现有 user auth batch（向后兼容，处理未被延迟拦截的 user auth）
      const userBatchKey = `user:${flow.accountId}:${flow.ticket.senderOpenId}:${flow.ticket.messageId}`;
      const userBatch = authBatches.get(userBatchKey);
      if (userBatch) {
        for (const s of userBatch.scopes) mergedScopes.add(s);
        log.info(`merged user batch scopes into app auth completion: [${[...mergedScopes].join(', ')}]`);
      }

      if (mergedScopes.size === 0) {
        // 无业务 scope 需要用户授权（例如 offline_access 是唯一缺失的应用权限，
        // 且没有其他工具产生用户授权需求）。跳过 OAuth，直接发合成消息触发 AI 重试，
        // 重试时工具会自然发现需要用户授权并发起正确的 OAuth 流程。
        log.info('no business scopes to authorize after app auth, sending synthetic message for retry');
        const syntheticMsgId = `${flow.ticket.messageId}:app-auth-complete`;
        const syntheticEvent = {
          sender: { sender_id: { open_id: flow.ticket.senderOpenId } },
          message: {
            message_id: syntheticMsgId,
            chat_id: flow.ticket.chatId,
            chat_type: flow.ticket.chatType ?? ('p2p' as const),
            message_type: 'text',
            content: JSON.stringify({ text: '应用权限已开通，请继续执行之前的操作。' }),
            thread_id: flow.ticket.threadId,
          },
        };
        const syntheticRuntime = {
          log: (msg: string) => log.info(msg),
          error: (msg: string) => log.error(msg),
        };
        const { promise } = enqueueFeishuChatTask({
          accountId: flow.accountId,
          chatId: flow.ticket.chatId,
          threadId: flow.ticket.threadId,
          task: async () => {
            await withTicket(
              {
                messageId: syntheticMsgId,
                chatId: flow.ticket.chatId,
                accountId: flow.accountId,
                startTime: Date.now(),
                senderOpenId: flow.ticket.senderOpenId!,
                chatType: flow.ticket.chatType,
                threadId: flow.ticket.threadId,
              },
              () =>
                handleFeishuMessage({
                  cfg: flow.cfg,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  event: syntheticEvent as any,
                  accountId: flow.accountId,
                  forceMention: true,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  runtime: syntheticRuntime as any,
                  replyToMessageId: flow.ticket.messageId,
                }),
            );
          },
        });
        await promise;
        log.info('synthetic message dispatched after app-auth-only completion');
      } else {
        await executeAuthorize({
          account: acct,
          senderOpenId: flow.ticket.senderOpenId,
          scope: [...mergedScopes].join(' '),
          showBatchAuthHint: true,
          forceAuth: true, // 应用权限刚经历移除→补回，不信任本地 UAT 缓存
          cfg: flow.cfg,
          ticket: flow.ticket,
        });
      }
    } catch (err) {
      log.error(`handleCardAction background task failed: ${err}`);
    }
  });

  // 回调返回值：通过 card 字段立即更新卡片 + toast 提示
  return {
    toast: {
      type: 'success' as const,
      content: '权限确认成功',
    },
    card: {
      type: 'raw' as const,
      data: successCard,
    },
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * 统一处理 `client.invoke()` 抛出的错误，支持自动发起 OAuth 授权。
 *
 * 替代 `handleInvokeError`，在工具层直接处理授权问题：
 * - 用户授权类错误 → 直接 executeAuthorize（发 Device Flow 卡片）
 * - 应用权限缺失 → 发送引导卡片，用户确认后自动接力 OAuth
 * - 其他错误 → 回退到 handleInvokeError 的标准处理
 *
 * @param err - invoke() 或其他逻辑抛出的错误
 * @param cfg - OpenClaw 配置对象（从工具注册函数的闭包中获取）
 */
export async function handleInvokeErrorWithAutoAuth(err: unknown, cfg: ClawdbotConfig) {
  // api.config (cfg) is channel-scoped and lacks the accounts sub-map.
  // Use live config for all account resolution and card dispatch.
  cfg = getResolvedConfig(cfg);

  const ticket = getTicket();

  // --- Path 0：Owner 访问拒绝 → 直接返回友好提示 ---
  if (err instanceof OwnerAccessDeniedError) {
    return json({
      error: 'permission_denied',
      message: '当前应用仅限所有者（App Owner）使用。您没有权限使用相关功能。',
      user_open_id: err.userOpenId,
      // 注意：不序列化 err.appOwnerId，避免泄露 owner 的 open_id
    });
  }

  if (ticket) {
    const senderOpenId = ticket.senderOpenId;

    // --- Path 1：用户授权类错误 → 防抖合并后发起 OAuth ---

    if (senderOpenId) {
      // 1a. 用户未授权或 token scope 不足（且 app scope 已验证）
      if (err instanceof UserAuthRequiredError && err.appScopeVerified) {
        const scopes = err.requiredScopes;
        try {
          const acct = getLarkAccount(cfg, ticket.accountId);
          if (acct.configured) {
            // ★ 延迟检查：如果同一消息有未完成的应用权限流程，
            //   将用户授权 scope 收集到延迟队列，等应用授权完成后统一发起 OAuth
            if (hasActiveAppAuthForMessage(ticket)) {
              addToDeferredUserAuth(ticket, scopes, acct, cfg);
              log.info(`UserAuthRequiredError deferred (app auth pending), scopes=[${scopes.join(', ')}]`);
              return json({
                awaiting_app_authorization: true,
                user_auth_deferred: true,
                message:
                  '应用权限尚未开通，将在应用权限通过后自动为您发起用户授权。' +
                  '请先按照应用权限卡片的提示完成操作。' +
                  '请等待用户完成卡片操作，不要建议其他替代方案。',
                deferred_scopes: scopes,
              });
            }

            const bufferKey = `user:${ticket.accountId}:${senderOpenId}:${ticket.messageId}`;
            log.info(`UserAuthRequiredError → enqueue, key=${bufferKey}, scopes=[${scopes.join(', ')}]`);
            return await enqueueAuthRequest(
              bufferKey,
              scopes,
              { account: acct, cfg, ticket },
              async (mergedScopes) => {
                // 等待同一消息的 app auth 卡片先发出
                const appKey = `app:${ticket.accountId}:${ticket.chatId}:${ticket.messageId}`;
                const appEntry = authBatches.get(appKey);
                if (appEntry?.resultPromise) {
                  await appEntry.resultPromise.catch(() => {});
                }
                return executeAuthorize({
                  account: acct,
                  senderOpenId,
                  scope: mergedScopes.join(' '),
                  showBatchAuthHint: true,
                  cfg,
                  ticket,
                });
              },
              AUTH_USER_DEBOUNCE_MS,
            );
          }
        } catch (autoAuthErr) {
          log.warn(`executeAuthorize failed: ${autoAuthErr}, falling back`);
        }
      }

      // 1b. 用户 token 存在但 scope 不足（服务端 LARK_ERROR.USER_SCOPE_INSUFFICIENT / 99991679）
      if (err instanceof UserScopeInsufficientError) {
        const scopes = err.missingScopes;
        try {
          const acct = getLarkAccount(cfg, ticket.accountId);
          if (acct.configured) {
            // ★ 延迟检查：同 Path 1a
            if (hasActiveAppAuthForMessage(ticket)) {
              addToDeferredUserAuth(ticket, scopes, acct, cfg);
              log.info(`UserScopeInsufficientError deferred (app auth pending), scopes=[${scopes.join(', ')}]`);
              return json({
                awaiting_app_authorization: true,
                user_auth_deferred: true,
                message:
                  '应用权限尚未开通，将在应用权限通过后自动为您发起用户授权。' +
                  '请先按照应用权限卡片的提示完成操作。' +
                  '请等待用户完成卡片操作，不要建议其他替代方案。',
                deferred_scopes: scopes,
              });
            }

            const bufferKey = `user:${ticket.accountId}:${senderOpenId}:${ticket.messageId}`;
            log.info(`UserScopeInsufficientError → enqueue, key=${bufferKey}, scopes=[${scopes.join(', ')}]`);
            return await enqueueAuthRequest(
              bufferKey,
              scopes,
              { account: acct, cfg, ticket },
              async (mergedScopes) => {
                // 等待同一消息的 app auth 卡片先发出
                const appKey = `app:${ticket.accountId}:${ticket.chatId}:${ticket.messageId}`;
                const appEntry = authBatches.get(appKey);
                if (appEntry?.resultPromise) {
                  await appEntry.resultPromise.catch(() => {});
                }
                return executeAuthorize({
                  account: acct,
                  senderOpenId,
                  scope: mergedScopes.join(' '),
                  showBatchAuthHint: true,
                  cfg,
                  ticket,
                });
              },
              AUTH_USER_DEBOUNCE_MS,
            );
          }
        } catch (autoAuthErr) {
          log.warn(`executeAuthorize failed: ${autoAuthErr}, falling back`);
        }
      }
    } else {
      log.error(`senderOpenId not found ${err}`);
    }

    // --- Path 2：应用权限缺失 → 防抖合并后发送引导卡片 ---

    if (err instanceof AppScopeMissingError && ticket.chatId) {
      // 捕获当前错误的附加信息，供 flushFn 使用
      const appScopeErr = err;
      try {
        const acct = getLarkAccount(cfg, ticket.accountId);
        if (acct.configured) {
          // ★ 将工具的全部所需 scope 加入延迟用户授权队列。
          // 应用权限完成后 handleCardAction 会消费这些 scope，
          // 与 flow.requiredScopes（仅 app 缺失的）合并，一次性发起 OAuth。
          if (senderOpenId && appScopeErr.allRequiredScopes?.length) {
            addToDeferredUserAuth(ticket, appScopeErr.allRequiredScopes, acct, cfg);
            log.info(`AppScopeMissingError → deferred allRequiredScopes=[${appScopeErr.allRequiredScopes.join(', ')}]`);
          }

          const bufferKey = `app:${ticket.accountId}:${ticket.chatId}:${ticket.messageId}`;
          log.info(
            `AppScopeMissingError → enqueue, key=${bufferKey}, ` + `scopes=[${appScopeErr.missingScopes.join(', ')}]`,
          );
          return await enqueueAuthRequest(
            bufferKey,
            appScopeErr.missingScopes,
            { account: acct, cfg, ticket },
            (mergedScopes) =>
              sendAppScopeCard({
                account: acct,
                missingScopes: mergedScopes,
                appId: appScopeErr.appId,
                scopeNeedType: 'all', // 合并后所有 scope 都需要
                tokenType: appScopeErr.tokenType,
                cfg,
                ticket,
              }),
          );
        }
      } catch (cardErr) {
        log.warn(`sendAppScopeCard failed: ${cardErr}, falling back`);
      }
    }
  } else {
    log.error(`ticket not found ${err}`);
  }
  return json({
    error: formatLarkError(err),
  });
}
