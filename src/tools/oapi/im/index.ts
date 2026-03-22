/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * IM Tools Index
 *
 * 即时通讯相关工具
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { registerFeishuImUserMessageTool } from './message';
import { registerFeishuImUserFetchResourceTool } from './resource';
import { registerMessageReadTools } from './message-read';

export function registerFeishuImTools(api: OpenClawPluginApi) {
  const registered: string[] = [];
  if (registerFeishuImUserMessageTool(api)) registered.push('feishu_im_user_message');
  if (registerFeishuImUserFetchResourceTool(api)) registered.push('feishu_im_user_fetch_resource');
  registered.push(...registerMessageReadTools(api));
  if (registered.length > 0) {
    api.logger.debug?.(`feishu_im: Registered ${registered.join(', ')}`);
  }
}
