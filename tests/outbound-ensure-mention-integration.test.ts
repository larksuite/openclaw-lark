/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Integration test: outbound `sendText` honors the bot-peer context that
 * the dispatch layer attaches via `runWithBotPeerContext`. When set, the
 * outbound layer injects an `<at user_id="ou_peer">` element so the peer
 * bot receives the reply even if the LLM forgot to @-mention it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendTextLarkMock = vi.hoisted(() => vi.fn().mockResolvedValue({
  messageId: 'om_sent',
  chatId: 'oc_test',
}));

vi.mock('../src/messaging/outbound/deliver', () => ({
  sendTextLark: sendTextLarkMock,
  sendCardLark: vi.fn(),
  sendCommentReplyLark: vi.fn(),
  sendMediaLark: vi.fn(),
}));

vi.mock('../src/core/lark-client', () => ({
  LarkClient: {
    runtime: {
      channel: {
        text: { chunkMarkdownText: (s: string) => [s] },
      },
    },
  },
}));

vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../src/core/targets', () => ({
  parseFeishuRouteTarget: (to: string) => ({ target: to }),
}));

vi.mock('../src/core/comment-target', () => ({
  isCommentTarget: () => false,
}));

vi.mock('../src/core/synthetic-target', () => ({
  isSyntheticTarget: () => false,
}));

import { feishuOutbound } from '../src/messaging/outbound/outbound';
import { runWithBotPeerContext } from '../src/messaging/outbound/bot-peer-context';
import {
  recordMention,
  resetMentionRegistry,
} from '../src/messaging/inbound/mention-registry';

const CHAT = 'oc_test';

beforeEach(() => {
  sendTextLarkMock.mockClear();
  resetMentionRegistry();
});

afterEach(() => {
  resetMentionRegistry();
});

describe('sendText + ensureMention via AsyncLocalStorage', () => {
  it('injects an <at> element when bot-peer context is active and LLM forgot the @', async () => {
    await runWithBotPeerContext(
      { peerOpenId: 'ou_peer_bot', peerName: 'PeerBot' },
      async () => {
        await feishuOutbound.sendText!({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          cfg: {} as any,
          to: CHAT,
          text: '好的，我去查',
          accountId: 'acct1',
        });
      },
    );

    expect(sendTextLarkMock).toHaveBeenCalledTimes(1);
    const sent = sendTextLarkMock.mock.calls[0][0].text;
    // Assert the @ is PREPENDED (position + exact format), not merely present,
    // so a regression to tail-append or extra spacing is caught.
    expect(sent.startsWith('<at user_id="ou_peer_bot">PeerBot</at> ')).toBe(true);
    expect(sent).toContain('好的，我去查');
  });

  it('does NOT touch text when no bot-peer context is set (human-peer path)', async () => {
    await feishuOutbound.sendText!({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cfg: {} as any,
      to: CHAT,
      text: '普通回复',
      accountId: 'acct1',
    });

    expect(sendTextLarkMock).toHaveBeenCalledTimes(1);
    const sent = sendTextLarkMock.mock.calls[0][0].text;
    expect(sent).toBe('普通回复');
  });

  it('is a no-op when the LLM already mentioned the peer correctly', async () => {
    await runWithBotPeerContext(
      { peerOpenId: 'ou_peer_bot', peerName: 'PeerBot' },
      async () => {
        await feishuOutbound.sendText!({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          cfg: {} as any,
          to: CHAT,
          text: '收到 <at user_id="ou_peer_bot">PeerBot</at>，我去查',
          accountId: 'acct1',
        });
      },
    );

    const sent = sendTextLarkMock.mock.calls[0][0].text;
    // Standard <at> element appears exactly once.
    const matches = sent.match(/<at user_id="ou_peer_bot">/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('does not re-@ the peer on later sends in the same dispatch (cross-chunk de-dup)', async () => {
    await runWithBotPeerContext(
      { peerOpenId: 'ou_peer_bot', peerName: 'PeerBot' },
      async () => {
        // Two sends within one dispatch (e.g. a reply split into chunks).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await feishuOutbound.sendText!({ cfg: {} as any, to: CHAT, text: '第一段', accountId: 'acct1' });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await feishuOutbound.sendText!({ cfg: {} as any, to: CHAT, text: '第二段', accountId: 'acct1' });
      },
    );

    expect(sendTextLarkMock).toHaveBeenCalledTimes(2);
    const first = sendTextLarkMock.mock.calls[0][0].text;
    const second = sendTextLarkMock.mock.calls[1][0].text;
    expect(first).toContain('<at user_id="ou_peer_bot">PeerBot</at>'); // first chunk @s the peer
    expect(second).not.toContain('<at user_id="ou_peer_bot">'); // later chunk does not repeat it
    expect(second).toContain('第二段');
  });

  it('composes with normalize: LLM writes "@PeerBot", normalize rewrites, ensureMention then no-ops', async () => {
    recordMention(CHAT, 'ou_peer_bot', 'PeerBot');
    await runWithBotPeerContext(
      { peerOpenId: 'ou_peer_bot', peerName: 'PeerBot' },
      async () => {
        await feishuOutbound.sendText!({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          cfg: {} as any,
          to: CHAT,
          text: '@PeerBot 我去查',
          accountId: 'acct1',
        });
      },
    );

    const sent = sendTextLarkMock.mock.calls[0][0].text;
    const matches = sent.match(/<at user_id="ou_peer_bot">/g) ?? [];
    expect(matches.length).toBe(1); // not duplicated
    expect(sent).toContain('我去查');
  });
});
