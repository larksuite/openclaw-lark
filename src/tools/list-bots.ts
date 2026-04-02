/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Tool: feishu_list_bots
 *
 * Lists all registered Feishu bot identities (open_id, name, account).
 * Used by the AI to discover available bots for cross-bot @mentions.
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';
import { LarkClient } from '../core/lark-client';
import { getLarkAccount } from '../core/accounts';
import { checkToolRegistration, formatToolResult } from './helpers';

export function registerListBotsTool(api: OpenClawPluginApi): void {
  const toolName = 'feishu_list_bots';
  if (!checkToolRegistration(api, toolName)) return;
  const cfg = api.config;

  api.registerTool({
    name: toolName,
    label: 'List Feishu Bots',
    description:
      'List all registered Feishu bot identities (open_id, name, account). ' +
      'You can direct another bot to work by @mentioning it in your reply using `<at user_id="open_id">name</at>`.',
    parameters: Type.Object({}),
    async execute() {
      const openIdMap = LarkClient.getAllBotOpenIds();
      const bots = [];
      for (const [accountId, openId] of openIdMap.entries()) {
        const account = getLarkAccount(cfg, accountId);
        const name = LarkClient.getBotName(accountId) ?? account.name ?? accountId;
        bots.push({ accountId, openId, name });
      }
      return formatToolResult({ bots });
    },
  });
}
