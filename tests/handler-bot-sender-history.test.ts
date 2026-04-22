/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Integration test: bot sender rejection does not write to chatHistories.
 *
 * Spec requirement: bot messages must never pollute chat history.
 * The checkBotSenderGate path intentionally produces no historyEntry,
 * so handler.ts must not write anything to the chatHistories map.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { HistoryEntry } from 'openclaw/plugin-sdk/reply-history';
import { handleFeishuMessage } from '../src/messaging/inbound/handler';
import { setLarkRuntime } from '../src/core/runtime-store';

beforeAll(() => {
  // Minimal runtime — gate.ts touches channel.groups; the bot path is rejected
  // before commandAuthorized resolution, so commands API isn't needed here.
  setLarkRuntime({
    channel: {
      groups: {
        resolveGroupPolicy: () => ({ allowed: true, allowlistEnabled: false }),
        resolveRequireMention: () => true,
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBotEvent(overrides: { messageId?: string } = {}) {
  return {
    sender: {
      sender_id: { open_id: 'ou_other_bot' },
      sender_type: 'bot' as const,
    },
    message: {
      message_id: overrides.messageId ?? 'msg_bot_1',
      chat_id: 'oc_test',
      chat_type: 'group' as const,
      message_type: 'text',
      content: JSON.stringify({ text: 'hi' }),
      create_time: String(Date.now()),
    },
  };
}

/**
 * Minimal cfg that provides a valid account with allowBots=false (or 'mentions').
 * The top-level channels.feishu and the per-account entry must both carry the
 * same allowBots value so that getLarkAccount + accountScopedCfg construction
 * in handler.ts sees consistent config.
 */
function makeCfg(allowBots: false | 'mentions') {
  return {
    channels: {
      feishu: {
        appId: 'cli_x',
        appSecret: 'secret',
        allowBots,
        accounts: {
          acct1: { appId: 'cli_x', appSecret: 'secret', allowBots },
        },
      },
    },
  } as never;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleFeishuMessage bot sender rejection does not touch chatHistories', () => {
  it('allowBots=false → no history entry written', async () => {
    const chatHistories = new Map<string, HistoryEntry[]>();

    await handleFeishuMessage({
      cfg: makeCfg(false),
      event: makeBotEvent(),
      botOpenId: 'ou_me',
      accountId: 'acct1',
      chatHistories,
    });

    expect(chatHistories.size).toBe(0);
  });

  it('allowBots="mentions" + not mentioned → no history entry', async () => {
    const chatHistories = new Map<string, HistoryEntry[]>();

    await handleFeishuMessage({
      cfg: makeCfg('mentions'),
      event: makeBotEvent({ messageId: 'msg_bot_2' }),
      botOpenId: 'ou_me',
      accountId: 'acct1',
      chatHistories,
    });

    expect(chatHistories.size).toBe(0);
  });
});
