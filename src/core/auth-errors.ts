/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * auth-errors.ts — 统一错误类型定义。
 *
 * 所有与认证/授权/scope 相关的错误类型集中在此文件，
 * 解除 tool-client ↔ app-scope-checker 循环依赖。
 *
 * 其他模块应直接 import 此文件，或通过 tool-client / uat-client 的 re-export 使用。
 */

// ---------------------------------------------------------------------------
// Feishu error code constants
// ---------------------------------------------------------------------------

/** 飞书 OAPI 错误码常量，替代各处硬编码的 magic number。 */
export const LARK_ERROR = {
  /** 应用 scope 不足（租户维度） */
  APP_SCOPE_MISSING: 99991672,
  /** 用户 token scope 不足 */
  USER_SCOPE_INSUFFICIENT: 99991679,
  /** access_token 无效 */
  TOKEN_INVALID: 99991668,
  /** access_token 已过期 */
  TOKEN_EXPIRED: 99991677,
  /** refresh_token 本身无效（格式非法或来自 v1 API） */
  REFRESH_TOKEN_INVALID: 20026,
  /** refresh_token 已过期（超过 365 天） */
  REFRESH_TOKEN_EXPIRED: 20037,
  /** refresh_token 已被吊销 */
  REFRESH_TOKEN_REVOKED: 20064,
  /** refresh_token 已被使用（单次消费，rotation 场景） */
  REFRESH_TOKEN_ALREADY_USED: 20073,
  /** refresh token 端点服务端内部错误，可重试 */
  REFRESH_SERVER_ERROR: 20050,
  /** 消息已被撤回 */
  MESSAGE_RECALLED: 230011,
  /** 消息已被删除 */
  MESSAGE_DELETED: 231003,
} as const;

/** refresh token 端点可重试的错误码集合（服务端瞬时故障）。遇到后重试一次，仍失败则清 token。 */
export const REFRESH_TOKEN_RETRYABLE: ReadonlySet<number> = new Set([
  LARK_ERROR.REFRESH_SERVER_ERROR,
]);

/** 消息终止错误码集合（撤回/删除），遇到后应停止对该消息的后续操作。 */
export const MESSAGE_TERMINAL_CODES: ReadonlySet<number> = new Set([
  LARK_ERROR.MESSAGE_RECALLED,
  LARK_ERROR.MESSAGE_DELETED,
]);

/** access_token 失效相关的错误码集合，遇到后可尝试刷新重试。 */
export const TOKEN_RETRY_CODES: ReadonlySet<number> = new Set([LARK_ERROR.TOKEN_INVALID, LARK_ERROR.TOKEN_EXPIRED]);

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** invoke() 错误共享的 scope 信息。 */
export interface ScopeErrorInfo {
  apiName: string;
  scopes: string[];
  /** 应用 scope 是否已验证通过。false 表示 app scope 检查失败，scope 信息可能不准确。 */
  appScopeVerified?: boolean;
  /** 应用 ID，用于生成开放平台权限管理链接。 */
  appId?: string;
}

/** OAuth 授权提示信息，与 handleInvokeError 返回的结构一致。 */
export interface AuthHint {
  error: string;
  api: string;
  required_scope: string;
  user_open_id: string;
  message: string;
  next_tool_call: {
    tool: 'feishu_oauth';
    params: { action: 'authorize'; scope: string };
  };
}

/** tryInvoke 返回值的判别联合体。 */
export type TryInvokeResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; authHint: AuthHint }
  | { ok: false; error: string; authHint?: undefined };

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/**
 * Thrown when no valid UAT exists and the user needs to (re-)authorise.
 * Callers should catch this and trigger the OAuth flow.
 */
export class NeedAuthorizationError extends Error {
  readonly userOpenId: string;
  constructor(userOpenId: string) {
    super('need_user_authorization');
    this.name = 'NeedAuthorizationError';
    this.userOpenId = userOpenId;
  }
}

/**
 * 应用缺少 application:application:self_manage 权限，无法查询应用权限配置。
 *
 * 需要管理员在飞书开放平台开通 application:application:self_manage 权限。
 */
export class AppScopeCheckFailedError extends Error {
  /** 应用 ID，用于生成开放平台权限管理链接。 */
  readonly appId?: string;

  constructor(appId?: string) {
    super('应用缺少 application:application:self_manage 权限，无法查询应用权限配置。请管理员在开放平台开通该权限。');
    this.name = 'AppScopeCheckFailedError';
    this.appId = appId;
  }
}

/**
 * 应用未开通 OAPI 所需 scope。
 *
 * 需要管理员在飞书开放平台开通权限。
 */
export class AppScopeMissingError extends Error {
  readonly apiName: string;
  /** OAPI 需要但 APP 未开通的 scope 列表。 */
  readonly missingScopes: string[];
  /** 工具的全部所需 scope（含已开通的），用于应用权限完成后一次性发起用户授权。 */
  readonly allRequiredScopes?: string[];
  /** 应用 ID，用于生成开放平台权限管理链接。 */
  readonly appId?: string;
  readonly scopeNeedType?: 'one' | 'all';
  /** 触发此错误时使用的 token 类型，用于保持 card action 二次校验一致。 */
  readonly tokenType?: 'user' | 'tenant';

  constructor(
    info: ScopeErrorInfo,
    scopeNeedType?: 'one' | 'all',
    tokenType?: 'user' | 'tenant',
    allRequiredScopes?: string[],
  ) {
    if (scopeNeedType === 'one') {
      super(`应用缺少权限 [${info.scopes.join(', ')}](开启任一权限即可)，请管理员在开放平台开通。`);
    } else {
      super(`应用缺少权限 [${info.scopes.join(', ')}]，请管理员在开放平台开通。`);
    }
    this.name = 'AppScopeMissingError';
    this.apiName = info.apiName;
    this.missingScopes = info.scopes;
    this.allRequiredScopes = allRequiredScopes;
    this.appId = info.appId;
    this.scopeNeedType = scopeNeedType;
    this.tokenType = tokenType;
  }
}

/**
 * 用户未授权或 scope 不足，需要发起 OAuth 授权。
 *
 * `requiredScopes` 为 APP∩OAPI 的有效 scope，可直接传给
 * `feishu_oauth authorize --scope`。
 */
export class UserAuthRequiredError extends Error {
  readonly userOpenId: string;
  readonly apiName: string;
  /** APP∩OAPI 交集 scope，传给 OAuth authorize。 */
  readonly requiredScopes: string[];
  /** 应用 scope 是否已验证通过。false 时 requiredScopes 可能不准确。 */
  readonly appScopeVerified: boolean;

  /** 应用 ID，用于生成开放平台权限管理链接。 */
  readonly appId?: string;

  constructor(userOpenId: string, info: ScopeErrorInfo) {
    super('need_user_authorization');
    this.name = 'UserAuthRequiredError';
    this.userOpenId = userOpenId;
    this.apiName = info.apiName;
    this.requiredScopes = info.scopes;
    this.appId = info.appId;
    this.appScopeVerified = info.appScopeVerified ?? true;
  }
}

/**
 * 服务端报 99991679 — 用户 token 的 scope 不足。
 *
 * 需要增量授权：用缺失的 scope 发起新 Device Flow。
 */
export class UserScopeInsufficientError extends Error {
  readonly userOpenId: string;
  readonly apiName: string;
  /** 缺失的 scope 列表。 */
  readonly missingScopes: string[];

  constructor(userOpenId: string, info: ScopeErrorInfo) {
    super('user_scope_insufficient');
    this.name = 'UserScopeInsufficientError';
    this.userOpenId = userOpenId;
    this.apiName = info.apiName;
    this.missingScopes = info.scopes;
  }
}
