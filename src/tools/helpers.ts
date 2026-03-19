/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * 飞书工具开发的通用辅助函数
 *
 * 提供所有工具通用的模式，减少重复代码。
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import type { Client as LarkSdkClient } from '@larksuiteoapi/node-sdk';
import { getEnabledLarkAccounts, getLarkAccount } from '../core/accounts';
import { LarkClient } from '../core/lark-client';
import type { LarkAccount } from '../core/types';
import { getTicket } from '../core/lark-ticket';
import { ToolClient, createToolClient } from '../core/tool-client';
import { shouldRegisterTool } from '../core/tools-config';

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/**
 * 工具返回值的标准格式
 */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: unknown; // 必填，符合 AgentToolResult 类型要求
}

/**
 * 客户端获取器函数类型
 */
export type ClientGetter = () => LarkSdkClient;

/**
 * 工具上下文对象，包含所有常用的辅助工具
 */
export interface ToolContext {
  /** @deprecated 使用 `toolClient().sdk` 代替 */
  getClient: ClientGetter;
  /** 获取当前请求对应的 {@link ToolClient} 实例 */
  toolClient: () => ToolClient;
  /** 工具日志记录器 */
  log: ReturnType<typeof createToolLogger>;
}

// ---------------------------------------------------------------------------
// 客户端管理
// ---------------------------------------------------------------------------

/**
 * 获取飞书客户端的标准模式
 *
 * 这是所有工具通用的逻辑：
 * 1. 优先使用 LarkTicket 中的 accountId 动态解析账号
 * 2. 如果没有 LarkTicket，回退到 accountIndex 指定的账号
 * 3. 返回创建好的客户端实例
 *
 * @param config - OpenClaw 配置对象
 * @param accountIndex - 使用第几个账号（默认 0，即第一个），仅在无 LarkTicket 时使用
 * @returns 飞书 SDK 客户端实例
 * @throws 如果没有启用的账号
 *
 * @example
 * ```typescript
 * export function registerMyTool(api: OpenClawPluginApi) {
 *   const getClient = createClientGetter(api.config);
 *
 *   api.registerTool({
 *     name: "my_tool",
 *     async execute(_toolCallId, params) {
 *       const client = getClient();
 *       const res = await client.im.message.create({ ... });
 *       return formatToolResult(res.data);
 *     }
 *   });
 * }
 * ```
 */
export function createClientGetter(config: ClawdbotConfig, accountIndex = 0): ClientGetter {
  return () => {
    // 优先使用 LarkTicket 中的 accountId 进行动态账号解析
    const ticket = getTicket();
    if (ticket?.accountId) {
      const account = getLarkAccount(config, ticket.accountId);
      if (account.enabled && account.configured) {
        return LarkClient.fromAccount(account).sdk;
      }
    }

    // 回退：使用 accountIndex 指定的账号
    const accounts = getEnabledLarkAccounts(config);

    if (accounts.length === 0) {
      throw new Error(
        'No enabled Feishu accounts configured. ' + 'Please add appId and appSecret in config under channels.feishu',
      );
    }

    if (accountIndex >= accounts.length) {
      throw new Error(`Requested account index ${accountIndex} but only ${accounts.length} accounts available`);
    }

    const account = accounts[accountIndex];
    const larkClient = LarkClient.fromAccount(account);
    return larkClient.sdk;
  };
}

/**
 * 获取当前请求对应的飞书账号信息
 *
 * 优先使用 LarkTicket 中的 accountId，回退到第一个启用的账号。
 *
 * @param config - OpenClaw 配置对象
 * @returns 解析后的账号信息
 * @throws 如果没有启用的账号
 *
 * @example
 * ```typescript
 * const account = getFirstAccount(api.config);
 * const client = LarkClient.fromAccount(account);
 * ```
 */
export function getFirstAccount(config: ClawdbotConfig): LarkAccount {
  // 优先使用 LarkTicket 中的 accountId
  const ticket = getTicket();
  if (ticket?.accountId) {
    const account = getLarkAccount(config, ticket.accountId);
    if (account.enabled && account.configured) {
      return account;
    }
  }

  // 回退到第一个启用的账号
  const accounts = getEnabledLarkAccounts(config);

  if (accounts.length === 0) {
    throw new Error(
      'No enabled Feishu accounts configured. ' + 'Please add appId and appSecret in config under channels.feishu',
    );
  }

  return accounts[0];
}

/**
 * 创建工具上下文，一次性返回所有常用的辅助工具
 *
 * 这是推荐的模式，避免在每个工具中重复调用 createClientGetter 和 createToolLogger。
 *
 * @param api - OpenClaw 插件 API
 * @param toolName - 工具名称
 * @param options - 可选配置
 * @returns 工具上下文对象
 *
 * @example
 * ```typescript
 * export function registerMyTool(api: OpenClawPluginApi) {
 *   if (!api.config) return;
 *
 *   const { toolClient, log } = createToolContext(api, "my_tool");
 *
 *   api.registerTool({
 *     name: "my_tool",
 *     async execute(_toolCallId, params) {
 *       const client = getClient();
 *       log.info(`Processing action: ${params.action}`);
 *       const res = await client.im.message.create({ ... });
 *       return formatToolResult(res.data);
 *     }
 *   });
 * }
 * ```
 */
export function createToolContext(
  api: OpenClawPluginApi,
  toolName: string,
  options?: {
    /** 使用第几个账号（默认 0，即第一个） */
    accountIndex?: number;
  },
): ToolContext {
  if (!api.config) {
    throw new Error('No config available');
  }

  const config = api.config;
  const accountIndex = options?.accountIndex ?? 0;

  return {
    getClient: createClientGetter(config, accountIndex),
    toolClient: () => createToolClient(config, accountIndex),
    log: createToolLogger(api, toolName),
  };
}

// ---------------------------------------------------------------------------
// 工具注册检查
// ---------------------------------------------------------------------------

/**
 * 检查工具是否应该被注册（根据 channels.feishu.tools.deny 配置）。
 *
 * 在工具注册函数开头调用此函数，如果返回 `false` 则应该直接 return。
 *
 * @param api - OpenClaw Plugin API
 * @param toolName - 工具名称
 * @returns `true` 如果应该继续注册，`false` 如果应该跳过
 *
 * @example
 * ```typescript
 * export function registerMyTool(api: OpenClawPluginApi) {
 *   if (!checkToolRegistration(api, 'feishu_my_tool')) {
 *     return;
 *   }
 *
 *   const { toolClient, log } = createToolContext(api, 'feishu_my_tool');
 *   api.registerTool({ ... });
 * }
 * ```
 */
export function checkToolRegistration(api: OpenClawPluginApi, toolName: string): boolean {
  if (!api.config) return false;

  if (!shouldRegisterTool(api.config, toolName)) {
    api.logger.info?.(`${toolName}: Skipped registration (in deny list)`);
    return false;
  }

  return true;
}

/**
 * 包装的工具注册函数，自动检查 channels.feishu.tools.deny 配置。
 *
 * 用法：将 `api.registerTool(...)` 替换为 `registerTool(api, ...)`。
 *
 * @param api - OpenClaw Plugin API
 * @param tool - 工具配置对象或工具工厂函数
 * @param opts - 可选的工具注册选项
 *
 * @example
 * ```typescript
 * // 旧代码：
 * api.registerTool({ name: 'feishu_my_tool', ... });
 *
 * // 新代码：
 * registerTool(api, { name: 'feishu_my_tool', ... });
 * ```
 */
export function registerTool(
  api: OpenClawPluginApi,
  tool: Parameters<OpenClawPluginApi['registerTool']>[0],
  opts?: Parameters<OpenClawPluginApi['registerTool']>[1],
): boolean {
  // 提取工具名称
  const toolName = typeof tool === 'function' ? tool.name : (tool as { name?: string }).name;

  if (!toolName) {
    // 如果无法提取工具名，直接注册（不拦截）
    api.registerTool(tool, opts);
    return true;
  }

  // 检查是否应该注册
  if (!checkToolRegistration(api, toolName)) {
    return false;
  }

  // 通过检查，调用原始的 registerTool
  api.registerTool(tool, opts);
  return true;
}

// ---------------------------------------------------------------------------
// 返回值格式化
// ---------------------------------------------------------------------------

/**
 * 格式化工具返回值为 OpenClaw 期望的格式
 *
 * @param data - 要返回的数据（会被序列化为 JSON）
 * @param options - 可选配置
 * @returns OpenClaw 工具返回值格式
 *
 * @example
 * ```typescript
 * // 简单使用
 * return formatToolResult({ success: true, user_id: "ou_xxx" });
 *
 * // 自定义 JSON 格式化
 * return formatToolResult(data, { indent: 4 });
 * ```
 */
export function formatToolResult(
  data: unknown,
  options: {
    /** JSON 缩进空格数，默认 2 */
    indent?: number;
  } = {},
): ToolResult {
  const { indent = 2 } = options;

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(data, null, indent),
      },
    ],
    details: data, // 始终包含 details
  };
}

/**
 * 格式化错误为工具返回值
 *
 * @param error - 错误对象或字符串
 * @param context - 错误上下文信息（可选）
 * @returns 包含错误信息的工具返回值
 *
 * @example
 * ```typescript
 * try {
 *   const res = await client.im.message.create({ ... });
 *   return formatToolResult(res.data);
 * } catch (err) {
 *   return formatToolError(err, { action: "send_message", user_id: "ou_xxx" });
 * }
 * ```
 */
export function formatToolError(error: unknown, context?: Record<string, unknown>): ToolResult {
  const errorMsg = error instanceof Error ? error.message : String(error);

  return formatToolResult({
    error: errorMsg,
    ...context,
  });
}

// ---------------------------------------------------------------------------
// 日志辅助
// ---------------------------------------------------------------------------

/**
 * 创建带工具名前缀的日志函数
 *
 * @param api - OpenClaw 插件 API
 * @param toolName - 工具名称
 * @returns 日志函数对象
 *
 * @example
 * ```typescript
 * export function registerMyTool(api: OpenClawPluginApi) {
 *   const log = createToolLogger(api, "my_tool");
 *
 *   log.info("Tool started");
 *   log.warn("Missing optional param: user_id");
 *   log.error("API call failed");
 *   log.debug("Intermediate state", { count: 5 });
 * }
 * ```
 */
export function createToolLogger(api: OpenClawPluginApi, toolName: string) {
  const prefix = `${toolName}:`;

  return {
    info: (msg: string) => {
      if (api.logger.info) {
        api.logger.info(`${prefix} ${msg}`);
      }
    },
    warn: (msg: string) => {
      if (api.logger.warn) {
        api.logger.warn(`${prefix} ${msg}`);
      }
    },
    error: (msg: string) => {
      if (api.logger.error) {
        api.logger.error(`${prefix} ${msg}`);
      }
    },
    debug: (msg: string) => {
      if (api.logger.debug) {
        api.logger.debug(`${prefix} ${msg}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 参数校验
// ---------------------------------------------------------------------------

/**
 * 校验必填参数
 *
 * @param params - 参数对象
 * @param requiredFields - 必填字段列表
 * @returns 校验结果，如果有缺失字段则返回错误信息
 *
 * @example
 * ```typescript
 * async execute(_toolCallId, params) {
 *   const error = validateRequiredParams(params, ["action", "user_id"]);
 *   if (error) return formatToolResult(error);
 *
 *   // 继续处理...
 * }
 * ```
 */
export function validateRequiredParams(
  params: Record<string, unknown>,
  requiredFields: string[],
): { error: string; missing: string[] } | null {
  const missing = requiredFields.filter((field) => {
    const value = params[field];
    return value === undefined || value === null || value === '';
  });

  if (missing.length > 0) {
    return {
      error: `Missing required parameter(s): ${missing.join(', ')}`,
      missing,
    };
  }

  return null;
}

/**
 * 校验枚举值
 *
 * @param value - 要校验的值
 * @param allowedValues - 允许的值列表
 * @param fieldName - 字段名（用于错误提示）
 * @returns 校验结果，如果值不在允许列表中则返回错误信息
 *
 * @example
 * ```typescript
 * const error = validateEnum(params.action, ["create", "list", "delete"], "action");
 * if (error) return formatToolResult(error);
 * ```
 */
export function validateEnum(
  value: unknown,
  allowedValues: unknown[],
  fieldName: string,
): { error: string; allowed: unknown[] } | null {
  if (!allowedValues.includes(value)) {
    return {
      error: `Invalid value for ${fieldName}: ${value}`,
      allowed: allowedValues,
    };
  }

  return null;
}
