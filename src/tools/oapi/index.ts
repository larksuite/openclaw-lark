/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * OAPI Tools Index
 *
 * This module registers all tools that directly use Feishu Open API (OAPI).
 * These tools are placed here to distinguish them from MCP-based tools.
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { getEnabledLarkAccounts } from '../../core/accounts';
import { resolveAnyEnabledToolsConfig } from '../../core/tools-config';
import {
  registerFeishuCalendarCalendarTool,
  registerFeishuCalendarEventTool,
  registerFeishuCalendarEventAttendeeTool,
  registerFeishuCalendarFreebusyTool,
} from './calendar/index';
import {
  registerFeishuTaskTaskTool,
  registerFeishuTaskTasklistTool,
  registerFeishuTaskCommentTool,
  registerFeishuTaskSubtaskTool,
} from './task/index';
import {
  registerFeishuBitableAppTool,
  registerFeishuBitableAppTableTool,
  registerFeishuBitableAppTableRecordTool,
  registerFeishuBitableAppTableFieldTool,
  registerFeishuBitableAppTableViewTool,
} from './bitable/index';
import { registerGetUserTool, registerSearchUserTool } from './common/index';
// import { registerFeishuMailTools } from "./mail/index";
import { registerFeishuSearchTools } from './search/index';
import { registerFeishuDriveTools } from './drive/index';
import { registerFeishuWikiTools } from './wiki/index';

import { registerFeishuImTools as registerFeishuImBotTools } from '../tat/im/index';
import { registerFeishuSheetsTools } from './sheets/index';
// import { registerFeishuOkrTools } from "./okr/index";
import { registerFeishuChatTools } from './chat/index';
import { registerFeishuImTools as registerFeishuImUserTools } from './im/index';

export function registerOapiTools(api: OpenClawPluginApi): void {
  if (!api.config) {
    api.logger.debug?.('feishu_oapi: No config available, skipping');
    return;
  }

  const accounts = getEnabledLarkAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.('feishu_oapi: No Feishu accounts configured, skipping');
    return;
  }

  const toolsCfg = resolveAnyEnabledToolsConfig(accounts);
  const enabledGroups: string[] = [];

  // Common tools
  if (toolsCfg.chat || toolsCfg.im || toolsCfg.calendar || toolsCfg.task) {
    registerGetUserTool(api);
    registerSearchUserTool(api);
    enabledGroups.push('common');
  }

  // Chat tools
  if (toolsCfg.chat) {
    registerFeishuChatTools(api);
    enabledGroups.push('chat');
  }

  // IM tools (user identity)
  if (toolsCfg.im) {
    registerFeishuImUserTools(api);
    enabledGroups.push('im');
  }

  // Calendar tools
  if (toolsCfg.calendar) {
    registerFeishuCalendarCalendarTool(api);
    registerFeishuCalendarEventTool(api);
    registerFeishuCalendarEventAttendeeTool(api);
    registerFeishuCalendarFreebusyTool(api);
    enabledGroups.push('calendar');
  }

  // Task tools
  if (toolsCfg.task) {
    registerFeishuTaskTaskTool(api);
    registerFeishuTaskTasklistTool(api);
    registerFeishuTaskCommentTool(api);
    registerFeishuTaskSubtaskTool(api);
    enabledGroups.push('task');
  }

  // Bitable tools
  if (toolsCfg.bitable) {
    registerFeishuBitableAppTool(api);
    registerFeishuBitableAppTableTool(api);
    registerFeishuBitableAppTableRecordTool(api);
    registerFeishuBitableAppTableFieldTool(api);
    registerFeishuBitableAppTableViewTool(api);
    enabledGroups.push('bitable');
  }

  // Search tools
  if (toolsCfg.doc) {
    registerFeishuSearchTools(api);
    enabledGroups.push('search');
  }

  // Drive tools
  if (toolsCfg.drive) {
    registerFeishuDriveTools(api);
    enabledGroups.push('drive');
  }

  // Wiki tools
  if (toolsCfg.wiki) {
    registerFeishuWikiTools(api);
    enabledGroups.push('wiki');
  }

  // Sheets tools
  if (toolsCfg.sheets) {
    registerFeishuSheetsTools(api);
    enabledGroups.push('sheets');
  }

  // IM tools (bot identity)
  if (toolsCfg.im) {
    registerFeishuImBotTools(api);
  }

  api.logger.info?.(
    `Registered OAPI tool groups: ${enabledGroups.length > 0 ? enabledGroups.join(', ') : 'none'}`,
  );
}
