/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Integration test: handleFeishuMessage drops self-echo messages.
 *
 * Mirrors the channel-layer filter in event-handlers.ts so that synthetic
 * messages, replays, or alternate entrypoints into handleFeishuMessage
 * cannot trigger bot-to-bot self loops once include_bot scope is enabled.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { handleFeishuMessage } from '../src/messaging/inbound/handler';
import { setLarkRuntime } from '../src/core/runtime-store';

beforeAll(() => {
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

function makeBotEvent(senderOpenId: string, messageId = 'om_test') {
  return {
    sender: {
      sender_id: { open_id: senderOpenId },
      sender_type: 'bot' as const,
    },
    message: {
      message_id: messageId,
      chat_id: 'oc_test',
      chat_type: 'group' as const,
      message_type: 'text',
      content: JSON.stringify({ text: 'hi' }),
      create_time: String(Date.now()),
    },
  };
}

const cfg = {
  channels: {
    feishu: {
      appId: 'cli_x',
      appSecret: 'secret',
      allowBots: false as const,
      accounts: {
        acct1: { appId: 'cli_x', appSecret: 'secret', allowBots: false as const },
      },
    },
  },
} as never;

describe('handleFeishuMessage self-echo filter', () => {
  it('drops the message when senderOpenId === botOpenId', async () => {
    const logs: string[] = [];
    const log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };

    await handleFeishuMessage({
      cfg,
      event: makeBotEvent('ou_self', 'om_echo'),
      botOpenId: 'ou_self',
      accountId: 'acct1',
      runtime: { log, error: vi.fn(), exit: vi.fn() } as never,
    });

    expect(
      logs.some((l) => l.includes('drop self-echo') && l.includes('om_echo')),
    ).toBe(true);
  });

  it('does not filter when botOpenId is not yet populated (startup race)', async () => {
    const logs: string[] = [];
    const log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };

    await handleFeishuMessage({
      cfg,
      event: makeBotEvent('ou_other_bot', 'om_user_msg'),
      botOpenId: undefined,
      accountId: 'acct1',
      runtime: { log, error: vi.fn(), exit: vi.fn() } as never,
    });

    expect(logs.some((l) => l.includes('drop self-echo'))).toBe(false);
  });

  it('does not filter when sender differs from bot', async () => {
    const logs: string[] = [];
    const log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };

    await handleFeishuMessage({
      cfg,
      event: makeBotEvent('ou_other_bot', 'om_other_msg'),
      botOpenId: 'ou_self',
      accountId: 'acct1',
      runtime: { log, error: vi.fn(), exit: vi.fn() } as never,
    });

    expect(logs.some((l) => l.includes('drop self-echo'))).toBe(false);
  });
});
