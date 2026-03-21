/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * MCP Doc 工具集
 * 统一导出所有 doc 相关工具的注册函数
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { getEnabledLarkAccounts } from '../../../core/accounts';
import { resolveAnyEnabledToolsConfig } from '../../../core/tools-config';
import { extractMcpUrlFromConfig, setMcpEndpointOverride } from '../shared';
import { registerFetchDocTool } from './fetch';
import { registerCreateDocTool } from './create';
import { registerUpdateDocTool } from './update';

/**
 * 注册 MCP Doc 工具（仅保留 create/fetch/update，search/list 已由 OAPI 替代）
 */
export function registerFeishuMcpDocTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.('feishu_doc: No config available, skipping');
    return;
  }

  const accounts = getEnabledLarkAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.('feishu_doc: No Feishu accounts configured, skipping');
    return;
  }

  // 沿用现有 doc 开关：若所有账户都关闭 doc 工具，则 MCP doc 工具也不注册
  const toolsCfg = resolveAnyEnabledToolsConfig(accounts);
  if (!toolsCfg.doc) {
    api.logger.debug?.('feishu_doc: doc tool disabled in all accounts');
    return;
  }

  // 将 mcp_url（若配置）缓存为全局 override，供后续工具调用使用
  const mcpEndpoint = extractMcpUrlFromConfig(api.config);
  setMcpEndpointOverride(mcpEndpoint);

  // 注册工具（search/list 已由 OAPI 版本替代，不再注册）
  const registered: string[] = [];
  if (registerFetchDocTool(api)) registered.push('feishu_fetch_doc');
  if (registerCreateDocTool(api)) registered.push('feishu_create_doc');
  if (registerUpdateDocTool(api)) registered.push('feishu_update_doc');
  if (registered.length > 0) {
    api.logger.debug?.(`feishu_doc: Registered ${registered.join(', ')}`);
  }
}
