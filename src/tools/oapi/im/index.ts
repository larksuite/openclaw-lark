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
  registerFeishuImUserMessageTool(api);
  registerFeishuImUserFetchResourceTool(api);
  registerMessageReadTools(api);

  api.logger.info?.(
    'feishu_im: Registered feishu_im_user_message, feishu_im_user_fetch_resource, feishu_im_user_get_messages, feishu_im_user_get_thread_messages, feishu_im_user_search_messages',
  );
}
