/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Chat Tools Index
 *
 * 群组相关工具
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { registerChatSearchTool } from './chat';
import { registerChatMembersTool } from './members';

export function registerFeishuChatTools(api: OpenClawPluginApi) {
  const registered: string[] = [];
  if (registerChatSearchTool(api)) registered.push('feishu_chat');
  if (registerChatMembersTool(api)) registered.push('feishu_chat_members');
  if (registered.length > 0) {
    api.logger.info?.(`feishu_chat: Registered ${registered.join(', ')}`);
  }
}
