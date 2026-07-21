/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { getGlobalHookRunner } from 'openclaw/plugin-sdk/plugin-runtime';
import { larkLogger } from '../../core/lark-logger';

const log = larkLogger('messaging/outbound/hooks');
const CHANNEL_ID = 'feishu';

/** Return whether any shared message_sending hooks are registered. */
export function hasFeishuMessageSendingHooks(): boolean {
  return getGlobalHookRunner()?.hasHooks('message_sending') ?? false;
}

/** Run the shared message_sending hook before a Feishu reply is delivered. */
export async function applyFeishuMessageSendingHook(params: {
  to: string;
  text: string;
  accountId?: string;
  mediaUrls?: string[];
}): Promise<{ cancelled: boolean; text: string }> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks('message_sending')) {
    return { cancelled: false, text: params.text };
  }

  try {
    const hookResult = await hookRunner.runMessageSending(
      {
        to: params.to,
        content: params.text,
        metadata: {
          channel: CHANNEL_ID,
          accountId: params.accountId,
          ...(params.mediaUrls?.length ? { mediaUrls: params.mediaUrls } : {}),
        },
      },
      {
        channelId: CHANNEL_ID,
        accountId: params.accountId,
        conversationId: params.to,
      },
    );

    if (hookResult?.cancel) {
      return { cancelled: true, text: params.text };
    }
    return {
      cancelled: false,
      text: hookResult?.content ?? params.text,
    };
  } catch (err) {
    log.warn('message_sending hook failed; proceeding with original content', {
      error: String(err),
    });
    return { cancelled: false, text: params.text };
  }
}
