/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * IM 工具集
 * 统一导出所有即时通讯相关工具的注册函数
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { registerFeishuImBotImageTool } from './resource';
import { registerFeishuImBotSendImageTool } from './send-image';

/**
 * 注册所有 IM 工具
 *
 * Note: feishu_im_message_reaction 和 feishu_im_message_recall 已移除，
 * 其功能由 ChannelMessageActionAdapter (actions.ts) 的 react/delete action 统一覆盖。
 */
export function registerFeishuImTools(api: OpenClawPluginApi): void {
  if (registerFeishuImBotImageTool(api)) {
    api.logger.debug?.('feishu_im: Registered feishu_im_bot_image');
  }
  if (registerFeishuImBotSendImageTool(api)) {
    api.logger.debug?.('feishu_im: Registered feishu_im_bot_send_image');
  }
}
