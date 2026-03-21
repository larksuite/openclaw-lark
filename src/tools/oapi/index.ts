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

export function registerOapiTools(api: OpenClawPluginApi) {
  // Common tools
  registerGetUserTool(api);
  registerSearchUserTool(api);

  // Chat tools
  registerFeishuChatTools(api);

  // IM tools (user identity)
  registerFeishuImUserTools(api);

  // Calendar tools
  registerFeishuCalendarCalendarTool(api);
  registerFeishuCalendarEventTool(api);
  registerFeishuCalendarEventAttendeeTool(api);
  registerFeishuCalendarFreebusyTool(api);

  // Task tools
  registerFeishuTaskTaskTool(api);
  registerFeishuTaskTasklistTool(api);
  registerFeishuTaskCommentTool(api);
  registerFeishuTaskSubtaskTool(api);

  // Bitable tools
  registerFeishuBitableAppTool(api);
  registerFeishuBitableAppTableTool(api);
  registerFeishuBitableAppTableRecordTool(api);
  registerFeishuBitableAppTableFieldTool(api);
  registerFeishuBitableAppTableViewTool(api);

  // Search tools
  registerFeishuSearchTools(api);

  // Drive tools
  registerFeishuDriveTools(api);

  // Wiki tools
  registerFeishuWikiTools(api);

  // Sheets tools
  registerFeishuSheetsTools(api);

  // IM tools (bot identity)
  registerFeishuImBotTools(api);

  api.logger.debug?.('Registered all OAPI tools (calendar, task, bitable, search, drive, wiki, sheets, im)');
}
