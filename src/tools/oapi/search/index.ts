/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Search 工具集
 * 统一导出所有搜索相关工具的注册函数
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { getEnabledLarkAccounts } from '../../../core/accounts';
import { resolveAnyEnabledToolsConfig } from '../../../core/tools-config';
import { registerFeishuSearchDocWikiTool } from './doc-search';

/**
 * 注册所有 Search 工具
 */
export function registerFeishuSearchTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.('feishu_search: No config available, skipping');
    return;
  }

  const accounts = getEnabledLarkAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.('feishu_search: No Feishu accounts configured, skipping');
    return;
  }

  // search 工具使用 doc 配置项控制，因为搜索是文档相关功能
  const toolsCfg = resolveAnyEnabledToolsConfig(accounts);
  if (!toolsCfg.doc) {
    api.logger.debug?.('feishu_search: search tool disabled in all accounts (controlled by doc config)');
    return;
  }

  // 注册所有工具
  if (registerFeishuSearchDocWikiTool(api)) {
    api.logger.info?.('feishu_search: Registered feishu_search_doc_wiki');
  }
}
