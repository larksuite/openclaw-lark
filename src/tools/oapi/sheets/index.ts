/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Sheets 工具集
 * 注册飞书电子表格工具
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { getEnabledLarkAccounts } from '../../../core/accounts';
import { resolveAnyEnabledToolsConfig } from '../../../core/tools-config';
import { registerFeishuSheetTool } from './sheet';

/**
 * 注册 Sheets 工具
 */
export function registerFeishuSheetsTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.('feishu_sheets: No config available, skipping');
    return;
  }

  const accounts = getEnabledLarkAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.('feishu_sheets: No Feishu accounts configured, skipping');
    return;
  }

  const toolsCfg = resolveAnyEnabledToolsConfig(accounts);
  if (!toolsCfg.sheets) {
    api.logger.debug?.('feishu_sheets: sheets tool disabled in all accounts');
    return;
  }

  if (registerFeishuSheetTool(api)) {
    api.logger.debug?.('feishu_sheets: Registered feishu_sheet');
  }
}
