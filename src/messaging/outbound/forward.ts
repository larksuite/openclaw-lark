/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Message forwarding for the Lark/Feishu channel plugin.
 *
 * Provides a function to forward an existing message to another chat
 * or user using the IM Message Forward API.
 */

import type { OpenClawConfig } from 'openclaw/plugin-sdk';
import type { FeishuSendResult } from '../types';
import { LarkClient } from '../../core/lark-client';
import { normalizeFeishuTarget, resolveReceiveIdType } from '../../core/targets';

// ---------------------------------------------------------------------------
// forwardMessageFeishu
// ---------------------------------------------------------------------------

/**
 * Forward an existing message to another chat or user.
 *
 * @param params.cfg       - Plugin configuration with Feishu credentials.
 * @param params.messageId - The message ID to forward.
 * @param params.to        - Target identifier (chat_id, open_id, or user_id).
 * @param params.accountId - Optional account identifier for multi-account setups.
 * @returns The send result containing the new forwarded message ID.
 */
export async function forwardMessageFeishu(params: {
  cfg: OpenClawConfig;
  messageId: string;
  to: string;
  accountId?: string;
}): Promise<FeishuSendResult> {
  const { cfg, messageId, to, accountId } = params;

  const client = LarkClient.fromCfg(cfg, accountId).sdk;

  const target = normalizeFeishuTarget(to);
  if (!target) {
    throw new Error(`[feishu-forward] Invalid target: "${to}"`);
  }

  const receiveIdType = resolveReceiveIdType(target);

  const response = await client.im.message.forward({
    path: {
      message_id: messageId,
    },
    params: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      receive_id_type: receiveIdType as any,
    },
    data: {
      receive_id: target,
    },
  });

  return {
    messageId: response?.data?.message_id ?? '',
    chatId: response?.data?.chat_id ?? '',
  };
}
