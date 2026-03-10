/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * ToolClient — 工具层统一客户端。
 *
 * 专为 `src/tools/` 下的工具设计，封装 account 解析、SDK 管理、
 * TAT/UAT 自动切换和 scope 预检。工具代码只需声明 API 名称和调用逻辑，
 * 身份选择/scope 校验/token 管理全部由 `invoke()` 内聚处理。
 *
 * 用法：
 * ```typescript
 * const client = createToolClient(config);
 *
 * // UAT 调用 — 通过 { as: "user" } 指定用户身份
 * const res = await client.invoke(
 *   "calendar.v4.calendarEvent.create",
 *   (sdk, opts) => sdk.calendar.calendarEvent.create(payload, opts),
 *   { as: "user" },
 * );
 *
 * // TAT 调用 — 默认走应用身份
 * const res = await client.invoke(
 *   "calendar.v4.calendar.list",
 *   (sdk) => sdk.calendar.calendar.list(payload),
 *   { as: "tenant" },
 * );
 * ```
 */

import * as Lark from '@larksuiteoapi/node-sdk';
import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import type { ConfiguredLarkAccount } from './types';
import { getLarkAccount, getEnabledLarkAccounts } from './accounts';
import { LarkClient } from './lark-client';
import { getTicket } from './lark-ticket';
import { callWithUAT } from './uat-client';
import { getStoredToken } from './token-store';
import { getAppGrantedScopes, invalidateAppScopeCache, missingScopes } from './app-scope-checker';
import { getAppOwnerFallback } from './app-owner-fallback';
import { larkLogger } from './lark-logger';
import { type ToolActionKey, getRequiredScopes } from './scope-manager';
import { rawLarkRequest } from './raw-request';
import { assertOwnerAccessStrict } from './owner-policy';
import {
  LARK_ERROR,
  NeedAuthorizationError,
  AppScopeCheckFailedError,
  AppScopeMissingError,
  UserAuthRequiredError,
  UserScopeInsufficientError,
} from './auth-errors';
import type { ScopeErrorInfo, AuthHint, TryInvokeResult } from './auth-errors';

// Re-export for backward compatibility — 下游模块可继续从 tool-client 导入
export {
  LARK_ERROR,
  NeedAuthorizationError,
  AppScopeCheckFailedError,
  AppScopeMissingError,
  UserAuthRequiredError,
  UserScopeInsufficientError,
};
export type { ScopeErrorInfo, AuthHint, TryInvokeResult };

const tcLog = larkLogger('core/tool-client');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-request options returned by `Lark.withUserAccessToken()`. */
type LarkRequestOptions = ReturnType<typeof Lark.withUserAccessToken>;

/**
 * @deprecated 使用 `InvokeFn` 代替。
 * Callback that receives the SDK client and per-request UAT options.
 */
export type ApiFn<T> = (sdk: Lark.Client, opts: LarkRequestOptions) => Promise<T>;

/**
 * invoke() 的回调签名。
 *
 * - UAT 模式：`opts` 为 `Lark.withUserAccessToken(token)`，需传给 SDK 方法；`uat` 为 User Access Token 原始字符串
 * - TAT 模式：`opts` 为 `undefined`，SDK 默认走应用身份；`uat` 也为 `undefined`
 */
export type InvokeFn<T> = (sdk: Lark.Client, opts?: LarkRequestOptions, uat?: string) => Promise<T>;

/** invoke() 的选项。 */
export interface InvokeOptions {
  /** 强制 token 类型。省略时根据 API meta 自动选择（优先 user）。 */
  as?: 'user' | 'tenant';
  /** 覆盖 senderOpenId。 */
  userOpenId?: string;
  /** 直接指定所需 scopes，跳过从 meta.json 读取。宽松模式：只要应用拥有部分 scope（交集非空）即可调用。 */
  /** 严格模式：指定所需 scopes，应用必须拥有所有 scope，缺一个都会报 AppScopeMissingError。 */
}

/** invokeByPath() 的选项 — 在 InvokeOptions 基础上增加 HTTP 请求参数。 */
export type InvokeByPathOptions = InvokeOptions & {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string>;
  /** 自定义请求 header，会与 Authorization / Content-Type 合并（自定义优先）。 */
  headers?: Record<string, string>;
};

// ---------------------------------------------------------------------------
// ToolClient
// ---------------------------------------------------------------------------

export class ToolClient {
  readonly config: ClawdbotConfig;
  /** 当前解析的账号信息（appId、appSecret 保证存在）。 */
  readonly account: ConfiguredLarkAccount;

  /** 当前请求的用户 open_id（来自 LarkTicket，可能为 undefined）。 */
  readonly senderOpenId: string | undefined;

  /** Lark SDK 实例（TAT 身份），直接调用即可。 */
  readonly sdk: Lark.Client;

  constructor(params: {
    account: ConfiguredLarkAccount;
    senderOpenId: string | undefined;
    sdk: Lark.Client;
    config: ClawdbotConfig;
  }) {
    this.account = params.account;
    this.senderOpenId = params.senderOpenId;
    this.sdk = params.sdk;
    this.config = params.config;
  }

  // -------------------------------------------------------------------------
  // invoke() — 统一 API 调用入口
  // -------------------------------------------------------------------------

  /**
   * 统一 API 调用入口。
   *
   * 自动处理：
   * - 根据 API meta 选择 UAT / TAT
   * - 严格模式：检查应用和用户是否拥有所有 API 要求的 scope
   * - 无 token 或 scope 不足时抛出结构化错误
   * - UAT 模式下复用 callWithUAT 的 refresh + retry
   *
   * @param apiName - meta.json 中的 toolName，如 `"calendar.v4.calendarEvent.create"`
   * @param fn - API 调用逻辑。UAT 时 opts 已注入 token，TAT 时 opts 为 undefined。
   * @param options - 可选配置：
   *   - `as`: 指定 UAT/TAT
   *   - `userOpenId`: 覆盖用户 ID
   *
   * @throws {@link AppScopeMissingError} 应用未开通 API 所需 scope
   * @throws {@link UserAuthRequiredError} 用户未授权或 scope 不足
   * @throws {@link UserScopeInsufficientError} 服务端报用户 scope 不足
   *
   * @example
   * // UAT 调用 — 通过 { as: "user" } 指定
   * const res = await client.invoke(
   *   "calendar.v4.calendarEvent.create",
   *   (sdk, opts) => sdk.calendar.calendarEvent.create(payload, opts),
   *   { as: "user" },
   * );
   *
   * @example
   * // TAT 调用
   * const res = await client.invoke(
   *   "calendar.v4.calendar.list",
   *   (sdk) => sdk.calendar.calendar.list(payload),
   *   { as: "tenant" },
   * );
   *
   */
  async invoke<T>(toolAction: ToolActionKey, fn: InvokeFn<T>, options?: InvokeOptions): Promise<T> {
    return this._invokeInternal(toolAction, fn, options);
  }

  /**
   * 内部 invoke 实现，只支持 ToolActionKey（严格类型检查）
   */
  private async _invokeInternal<T>(toolAction: ToolActionKey, fn: InvokeFn<T>, options?: InvokeOptions): Promise<T> {
    // 检查旧版插件是否已禁用 (error)
    const feishuEntry = this.config.plugins?.entries?.feishu;
    if (feishuEntry && feishuEntry.enabled !== false) {
      throw new Error(
        '❌ 检测到旧版插件未禁用。\n' +
          '👉 请依次运行命令：\n' +
          '```\n' +
          'openclaw config set plugins.entries.feishu.enabled false --json\n' +
          'openclaw gateway restart\n' +
          '```',
      );
    }

    // 2. 从 scope.ts 查询 API 需要的 scopes（Required Scopes）
    const requiredScopes = getRequiredScopes(toolAction);

    // 3. 决定 token 类型（默认 user，用户可通过 options.as 覆盖）
    const tokenType = options?.as ?? 'user';

    // ---- App Granted Scopes 检查（应用已开通的权限）----
    // UAT 调用额外检查 offline_access（OAuth Device Flow 的前提权限），
    // 但不加入 requiredScopes（避免阻断业务 scope 进入用户授权流程）。
    const appCheckScopes = tokenType === 'user' ? [...new Set([...requiredScopes, 'offline_access'])] : requiredScopes;

    let appScopeVerified = true;
    if (appCheckScopes.length > 0) {
      const appGrantedScopes = await getAppGrantedScopes(this.sdk, this.account.appId, tokenType);

      if (appGrantedScopes.length > 0) {
        // 严格模式：应用必须开通所有 Required Scopes（+ offline_access）
        const missingAppScopes = missingScopes(appGrantedScopes, appCheckScopes);
        if (missingAppScopes.length > 0) {
          throw new AppScopeMissingError(
            { apiName: toolAction, scopes: missingAppScopes, appId: this.account.appId },
            'all',
            tokenType,
            requiredScopes,
          );
        }
      } else {
        // 查询失败（返回空数组）→ 标记 appScopeVerified=false，跳过本地 scope 预检，
        // 让服务端来判断是应用缺权限还是用户缺授权。
        appScopeVerified = false;
      }
    }

    // 5. 执行调用
    if (tokenType === 'tenant') {
      return this.invokeAsTenant(toolAction, fn, requiredScopes);
    }

    // 5.1 获取 userOpenId，支持兜底逻辑
    let userOpenId = options?.userOpenId ?? this.senderOpenId;

    // 5.2 兜底逻辑：如果没有 senderOpenId，尝试使用应用所有者
    if (!userOpenId) {
      const fallbackUserId = await getAppOwnerFallback(this.account, this.sdk);
      if (fallbackUserId) {
        userOpenId = fallbackUserId;
        tcLog.info(`Using app owner as fallback user`, {
          toolAction,
          appId: this.account.appId,
          ownerId: fallbackUserId,
        });
      }
    }

    return this.invokeAsUser(toolAction, fn, requiredScopes, userOpenId, appScopeVerified);
  }

  /**
   * invoke() 的非抛出包装，适用于"允许失败"的子操作。
   *
   * - 成功 → `{ ok: true, data }`
   * - 用户授权错误（可通过 OAuth 恢复）→ `{ ok: false, authHint }`
   * - 应用权限缺失 / appScopeVerified=false → **仍然 throw**（需管理员操作）
   * - 其他错误 → `{ ok: false, error }`
   */
  // -------------------------------------------------------------------------
  // invokeByPath() — SDK 未覆盖的 API 调用入口
  // -------------------------------------------------------------------------

  /**
   * 对 SDK 未覆盖的飞书 API 发起 raw HTTP 请求，同时复用 invoke() 的
   * auth/scope/refresh 全链路。
   *
   * @param apiName - 逻辑 API 名称（用于日志和错误信息），如 `"im.v1.chatP2p.batchQuery"`
   * @param path - API 路径（以 `/open-apis/` 开头），如 `"/open-apis/im/v1/chat_p2p/batch_query"`
   * @param options - HTTP 方法、body、query 及 InvokeOptions（as、userOpenId 等）
   *
   * @example
   * ```typescript
   * const res = await client.invokeByPath<{ data: { items: Array<{ chat_id: string }> } }>(
   *   "im.v1.chatP2p.batchQuery",
   *   "/open-apis/im/v1/chat_p2p/batch_query",
   *   {
   *     method: "POST",
   *     body: { chatter_ids: [openId] },
   *     as: "user",
   *   },
   * );
   * ```
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async invokeByPath<T = any>(toolAction: ToolActionKey, path: string, options?: InvokeByPathOptions): Promise<T> {
    const fn: InvokeFn<T> = async (_sdk, _opts, uat) => {
      return this.rawRequest<T>(path, {
        method: options?.method,
        body: options?.body,
        query: options?.query,
        headers: options?.headers,
        accessToken: uat,
      });
    };
    return this._invokeInternal(toolAction, fn, options);
  }

  // -------------------------------------------------------------------------
  // Private: TAT path
  // -------------------------------------------------------------------------

  private async invokeAsTenant<T>(toolAction: ToolActionKey, fn: InvokeFn<T>, requiredScopes: string[]): Promise<T> {
    try {
      return await fn(this.sdk);
    } catch (err) {
      this.rethrowStructuredError(err, toolAction, requiredScopes, undefined, 'tenant');
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Private: UAT path
  // -------------------------------------------------------------------------

  private async invokeAsUser<T>(
    toolAction: ToolActionKey,
    fn: InvokeFn<T>,
    requiredScopes: string[],
    userOpenId: string | undefined,
    appScopeVerified: boolean,
  ): Promise<T> {
    if (!userOpenId) {
      throw new UserAuthRequiredError('unknown', {
        apiName: toolAction,
        scopes: requiredScopes,
        appScopeVerified,
        appId: this.account.appId,
      });
    }

    // Owner 检查：非 owner 用户直接拒绝（从 uat-client.ts 迁移至此）
    await assertOwnerAccessStrict(this.account, this.sdk, userOpenId);

    // 预检：是否有已存储的 token
    const stored = await getStoredToken(this.account.appId, userOpenId);
    if (!stored) {
      throw new UserAuthRequiredError(userOpenId, {
        apiName: toolAction,
        scopes: requiredScopes,
        appScopeVerified,
        appId: this.account.appId,
      });
    }

    // 预检：token 的 scope 是否满足 API 要求
    // ---- User Granted Scopes 检查（用户授权的权限）----
    // 仅在 App Granted Scopes 检查成功时进行本地预检。
    // 当 App Scope 检查失败时（appScopeVerified=false），跳过预检，
    // 让请求走到服务端 — 服务端会返回准确的错误码：
    //   LARK_ERROR.APP_SCOPE_MISSING (99991672) → App Granted Scopes 缺失（管理员需在开放平台开通）
    //   LARK_ERROR.USER_SCOPE_INSUFFICIENT (99991679) → User Granted Scopes 缺失（需引导用户 OAuth 授权）
    if (appScopeVerified && stored.scope && requiredScopes.length > 0) {
      // 检查用户是否授权了所有 Required Scopes
      const userGrantedScopes = new Set(stored.scope.split(/\s+/).filter(Boolean));
      const missingUserScopes = requiredScopes.filter((s) => !userGrantedScopes.has(s));
      if (missingUserScopes.length > 0) {
        throw new UserAuthRequiredError(userOpenId, {
          apiName: toolAction,
          scopes: missingUserScopes,
          appScopeVerified,
          appId: this.account.appId,
        });
      }
    }

    // 通过 callWithUAT 执行（自动 refresh + retry）
    try {
      return await callWithUAT(
        {
          userOpenId,
          appId: this.account.appId,
          appSecret: this.account.appSecret,
          domain: this.account.brand,
        },
        (accessToken) => fn(this.sdk, Lark.withUserAccessToken(accessToken), accessToken),
      );
    } catch (err) {
      if (err instanceof NeedAuthorizationError) {
        throw new UserAuthRequiredError(userOpenId, {
          apiName: toolAction,
          scopes: requiredScopes,
          appScopeVerified,
        });
      }
      this.rethrowStructuredError(err, toolAction, requiredScopes, userOpenId, 'user');
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Private: raw HTTP request
  // -------------------------------------------------------------------------

  /**
   * 发起 raw HTTP 请求到飞书 API，委托 rawLarkRequest 处理。
   */
  private async rawRequest<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      query?: Record<string, string>;
      headers?: Record<string, string>;
      accessToken?: string;
    },
  ): Promise<T> {
    return rawLarkRequest<T>({
      brand: this.account.brand,
      path,
      ...options,
    });
  }

  // -------------------------------------------------------------------------
  // Private: structured error detection
  // -------------------------------------------------------------------------

  /**
   * 识别飞书服务端错误码并转换为结构化错误。
   *
   * - LARK_ERROR.APP_SCOPE_MISSING (99991672) → AppScopeMissingError（清缓存后抛出）
   * - LARK_ERROR.USER_SCOPE_INSUFFICIENT (99991679) → UserScopeInsufficientError
   */
  private rethrowStructuredError(
    err: unknown,
    apiName: string,
    effectiveScopes: string[],
    userOpenId?: string,
    tokenType?: 'user' | 'tenant',
  ): void {
    const code =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (err as any)?.code ?? (err as any)?.response?.data?.code;

    if (code === LARK_ERROR.APP_SCOPE_MISSING) {
      // 应用 scope 不足 — 清缓存（管理员可能刚开通）
      invalidateAppScopeCache(this.account.appId);
      throw new AppScopeMissingError(
        {
          apiName,
          scopes: effectiveScopes,
          appId: this.account.appId,
        },
        'all',
        tokenType,
      );
    }

    if (code === LARK_ERROR.USER_SCOPE_INSUFFICIENT && userOpenId) {
      throw new UserScopeInsufficientError(userOpenId, {
        apiName,
        scopes: effectiveScopes,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * 从配置创建 {@link ToolClient}。
 *
 * 自动从当前 {@link LarkTicket} 解析 accountId 和 senderOpenId。
 * 如果 LarkTicket 不可用（如非消息场景），回退到 `accountIndex`
 * 指定的账号。
 *
 * @param config - OpenClaw 配置对象
 * @param accountIndex - 回退账号索引（默认 0）
 */
export function createToolClient(config: ClawdbotConfig, accountIndex = 0): ToolClient {
  const ticket = getTicket();

  // 1. 解析账号
  let account: ConfiguredLarkAccount | undefined;

  if (ticket?.accountId) {
    const resolved = getLarkAccount(config, ticket.accountId);
    if (!resolved.configured) {
      throw new Error(
        `Feishu account "${ticket.accountId}" is not configured (missing appId or appSecret). ` +
          `Please check channels.feishu.accounts.${ticket.accountId} in your config.`,
      );
    }
    if (!resolved.enabled) {
      throw new Error(
        `Feishu account "${ticket.accountId}" is disabled. ` +
          `Set channels.feishu.accounts.${ticket.accountId}.enabled to true, or remove it to use defaults.`,
      );
    }
    account = resolved;
  }

  if (!account) {
    const accounts = getEnabledLarkAccounts(config);
    if (accounts.length === 0) {
      throw new Error(
        'No enabled Feishu accounts configured. ' + 'Please add appId and appSecret in config under channels.feishu',
      );
    }
    if (accountIndex >= accounts.length) {
      throw new Error(`Requested account index ${accountIndex} but only ${accounts.length} accounts available`);
    }
    const fallback = accounts[accountIndex];
    if (!fallback.configured) {
      throw new Error(`Account at index ${accountIndex} is not fully configured (missing appId or appSecret)`);
    }
    account = fallback;
  }

  // 2. 获取 SDK 实例（复用 LarkClient 的缓存）
  const larkClient = LarkClient.fromAccount(account);

  // 3. 组装 ToolClient
  return new ToolClient({
    account,
    senderOpenId: ticket?.senderOpenId,
    sdk: larkClient.sdk,
    config,
  });
}
