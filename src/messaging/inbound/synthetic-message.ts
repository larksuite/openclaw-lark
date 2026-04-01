/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Shared helper for dispatching synthetic inbound text messages.
 *
 * Synthetic messages are used to resume the normal inbound pipeline after
 * card actions or OAuth flows complete.
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import { enqueueFeishuChatTask } from '../../channel/chat-queue';
import type { AuthResumeTarget } from '../../core/auth-resume-target';
import { withTicket } from '../../core/lark-ticket';
import { getInboundHandler } from './handler-registry';

export async function dispatchSyntheticTextMessage(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  chatId: string;
  senderOpenId: string;
  text: string;
  syntheticMessageId: string;
  replyToMessageId: string;
  chatType?: 'p2p' | 'group';
  threadId?: string;
  sessionRouteOverride?: AuthResumeTarget;
  runtime?: {
    log?: (msg: string) => void;
    error?: (msg: string) => void;
  };
  forceMention?: boolean;
}): Promise<string> {
  const handleFeishuMessage = getInboundHandler();
  const {
    cfg,
    accountId,
    chatId,
    senderOpenId,
    text,
    syntheticMessageId,
    replyToMessageId,
    chatType,
    threadId,
    sessionRouteOverride,
    runtime,
    forceMention = true,
  } = params;

  const syntheticEvent = {
    sender: {
      sender_id: { open_id: senderOpenId },
    },
    message: {
      message_id: syntheticMessageId,
      chat_id: chatId,
      chat_type: chatType ?? ('p2p' as const),
      message_type: 'text',
      content: JSON.stringify({ text }),
      thread_id: threadId,
    },
  };

  const { status, promise } = enqueueFeishuChatTask({
    accountId,
    chatId,
    threadId,
    task: async () => {
      await withTicket(
        {
          messageId: syntheticMessageId,
          chatId,
          accountId,
          startTime: Date.now(),
          senderOpenId,
          chatType,
          threadId,
        },
        () =>
          handleFeishuMessage({
            cfg,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            event: syntheticEvent as any,
            accountId,
            forceMention,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            runtime: runtime as any,
            replyToMessageId,
            sessionRouteOverride,
          }),
      );
    },
  });

  await promise;
  return status;
}
