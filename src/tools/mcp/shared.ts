/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * MCP 工具的共享代码（所有业务域共享）
 * 包含：MCP 客户端、类型定义、通用辅助函数
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import type { TSchema } from '@sinclair/typebox';
import { createToolContext, formatToolResult } from '../helpers';
import { handleInvokeErrorWithAutoAuth } from '../oapi/helpers';
import { getUserAgent } from '../../core/version';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export interface McpRpcSuccess {
  jsonrpc: '2.0';
  id: number | string;
  result: unknown;
}

export interface McpRpcError {
  jsonrpc: '2.0';
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

export type McpRpcResponse = McpRpcSuccess | McpRpcError;

import type { ToolActionKey } from '../../core/scope-manager';

export interface McpToolConfig<T = unknown> {
  name: string;
  mcpToolName: string;
  toolActionKey: ToolActionKey; // 新增：工具动作键
  label: string;
  description: string;
  schema: TSchema;
  validate?: (params: T) => void;
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * 从配置对象中提取 MCP endpoint URL
 */
export function extractMcpUrlFromConfig(cfg: unknown): string | undefined {
  if (!isRecord(cfg)) return undefined;
  const channels = cfg.channels;
  if (!isRecord(channels)) return undefined;
  const feishu = channels.feishu;
  if (!isRecord(feishu)) return undefined;
  const url = feishu.mcpEndpoint;
  const legacyUrl = feishu.mcp_url;
  const chosen = typeof url === 'string' ? url : typeof legacyUrl === 'string' ? legacyUrl : undefined;
  if (typeof chosen !== 'string') return undefined;
  const trimmed = chosen.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * 部分 MCP 网关/代理会在 result 内再次包一层 JSON-RPC envelope。
 * 这里做一次递归解包，确保工具最终返回的是纯 result JSON（不包含 jsonrpc/id）。
 */
export function unwrapJsonRpcResult(v: unknown): unknown {
  if (!isRecord(v)) return v;

  const hasJsonRpc = typeof v.jsonrpc === 'string';
  const hasId = 'id' in v;
  const hasResult = 'result' in v;
  const hasError = 'error' in v;

  if (hasJsonRpc && (hasResult || hasError)) {
    if (hasError) {
      const err = v.error;
      if (isRecord(err) && typeof err.message === 'string') {
        throw new Error(err.message);
      }
      throw new Error('MCP 返回 error，但无法解析 message');
    }
    return unwrapJsonRpcResult(v.result);
  }

  // 某些实现可能只包了 { result: ... } 而没有 jsonrpc 字段
  if (!hasJsonRpc && !hasId && hasResult && !hasError) {
    return unwrapJsonRpcResult(v.result);
  }

  return v;
}

// ---------------------------------------------------------------------------
// MCP 配置管理
// ---------------------------------------------------------------------------

let mcpEndpointOverride: string | undefined;

export function setMcpEndpointOverride(endpoint: string | undefined) {
  mcpEndpointOverride = endpoint;
}

function readMcpUrlFromOpenclawJson(): string | undefined {
  // 优先读取工作目录下的 `.openclaw/openclaw.json`
  // 约定：channels.feishu.mcpEndpoint（兼容旧字段 mcp_url）
  try {
    const p = path.join(process.cwd(), '.openclaw', 'openclaw.json');
    if (!fs.existsSync(p)) return undefined;

    const raw = fs.readFileSync(p, 'utf8');
    const cfg = JSON.parse(raw) as unknown;
    return extractMcpUrlFromConfig(cfg);
  } catch {
    // 配置缺失/JSON 解析失败等情况，忽略并回退到默认逻辑
    return undefined;
  }
}

function getMcpEndpoint(): string {
  // 优先级：运行时覆盖 > 配置文件 > 环境变量 > 默认值
  return (
    mcpEndpointOverride ||
    readMcpUrlFromOpenclawJson() ||
    process.env.FEISHU_MCP_ENDPOINT?.trim() ||
    'https://mcp.feishu.cn/mcp'
  );
}

function buildAuthHeader(): string | undefined {
  // 允许通过环境变量注入鉴权（若服务端要求）
  const token = process.env.FEISHU_MCP_BEARER_TOKEN?.trim() || process.env.FEISHU_MCP_TOKEN?.trim();

  if (!token) return undefined;
  return token.toLowerCase().startsWith('bearer ') ? token : `Bearer ${token}`;
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC 客户端
// ---------------------------------------------------------------------------

/**
 * 调用 MCP 工具
 * @param name MCP 工具名称
 * @param args 工具参数
 * @param toolCallId 工具调用 ID
 * @param uat 用户访问令牌(由 invoke 权限检查后传入)
 */
export async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
  toolCallId: string,
  uat: string,
): Promise<unknown> {
  const endpoint = getMcpEndpoint();
  const auth = buildAuthHeader();

  const body = {
    jsonrpc: '2.0',
    id: toolCallId,
    method: 'tools/call',
    params: {
      name,
      arguments: args,
    },
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Lark-MCP-UAT': uat,
    'X-Lark-MCP-Allowed-Tools': name,
    'User-Agent': getUserAgent(),
  };
  if (auth) headers.authorization = auth;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MCP HTTP ${res.status} ${res.statusText}: ${text.slice(0, 4000)}`);
  }

  let data: McpRpcResponse;
  try {
    data = JSON.parse(text) as McpRpcResponse;
  } catch {
    throw new Error(`MCP 返回非 JSON：${text.slice(0, 4000)}`);
  }

  if ('error' in data) {
    throw new Error(`MCP error ${data.error.code}: ${data.error.message}`);
  }

  return unwrapJsonRpcResult(data.result);
}

// ---------------------------------------------------------------------------
// Scope 管理
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 通用工具注册函数
// ---------------------------------------------------------------------------

/**
 * 注册 MCP 工具的通用函数 (使用 invoke 机制进行权限检查)
 */
export function registerMcpTool<T extends Record<string, unknown>>(
  api: OpenClawPluginApi,
  config: McpToolConfig<T>,
): void {
  const { toolClient, log } = createToolContext(api, config.name);

  api.registerTool(
    {
      name: config.name,
      label: config.label,
      description: config.description,
      parameters: config.schema,
      async execute(toolCallId, params) {
        const p = params as T;
        try {
          log.debug?.(`Calling ${config.mcpToolName} (toolCallId: ${toolCallId})`);
          const startTime = Date.now();

          // 执行参数验证
          config.validate?.(p);

          const client = toolClient();

          // 通过 invoke 进行权限检查并调用 MCP
          // 严格模式：必须拥有 toolActionKey 所需的所有 scope
          const result = await client.invoke(
            config.toolActionKey,
            async (_sdk, _opts, uat) => {
              // 权限检查已通过，直接使用 invoke 传入的 UAT
              if (!uat) {
                throw new Error('UAT not available');
              }
              return callMcpTool(config.mcpToolName, p, toolCallId, uat);
            },
            {
              as: 'user',
            },
          );

          const duration = Date.now() - startTime;
          log.debug?.(`${config.mcpToolName} succeeded in ${duration}ms`);

          // MCP tools/call 返回值已经是 { content: [{ type, text }] } 格式，
          // 直接透传 content，避免被 formatToolResult 再包一层
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (isRecord(result) && Array.isArray((result as any).content)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const mcpContent = (result as any).content as Array<{
              type: string;
              text: string;
            }>;
            let details: unknown = result;
            if (mcpContent.length === 1 && mcpContent[0]?.type === 'text') {
              try {
                details = JSON.parse(mcpContent[0].text);
              } catch {
                // text 不是 JSON，保留原始 result
              }
            }
            return {
              content: mcpContent.map((c) => ({
                type: 'text' as const,
                text: c.text,
              })),
              details,
            };
          }
          return formatToolResult(result);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.error(`${config.mcpToolName} failed: ${errMsg}`);
          return handleInvokeErrorWithAutoAuth(err, api.config);
        }
      },
    },
    { name: config.name },
  );
}
