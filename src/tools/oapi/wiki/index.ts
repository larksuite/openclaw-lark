/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Wiki 工具集
 * 统一导出所有知识库相关工具的注册函数
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { getEnabledLarkAccounts } from '../../../core/accounts';
import { resolveAnyEnabledToolsConfig } from '../../../core/tools-config';
import { registerFeishuWikiSpaceTool } from './space';
import { registerFeishuWikiSpaceNodeTool } from './space-node';

/**
 * 注册所有 Wiki 工具
 */
export function registerFeishuWikiTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.('feishu_wiki: No config available, skipping');
    return;
  }

  const accounts = getEnabledLarkAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.('feishu_wiki: No Feishu accounts configured, skipping');
    return;
  }

  const toolsCfg = resolveAnyEnabledToolsConfig(accounts);
  if (!toolsCfg.wiki) {
    api.logger.debug?.('feishu_wiki: wiki tool disabled in all accounts');
    return;
  }

  // 注册所有工具
  const registered: string[] = [];
  if (registerFeishuWikiSpaceTool(api)) registered.push('feishu_wiki_space');
  if (registerFeishuWikiSpaceNodeTool(api)) registered.push('feishu_wiki_space_node');
  if (registered.length > 0) {
    api.logger.info?.(`feishu_wiki: Registered ${registered.join(', ')}`);
  }
}
