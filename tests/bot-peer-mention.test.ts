/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Tests for resolveBotPeerForMention — picking the peer that an outbound
 * reply must @-mention (the ensureMention backstop), decoupled from thread
 * routing. Covers the human-orchestrated debate kickoff.
 */

import { describe, expect, it } from 'vitest';
import { resolveBotPeerForMention } from '../src/messaging/inbound/bot-content';
import type { MentionInfo } from '../src/messaging/types';

function m(openId: string, name: string, isBot = false): MentionInfo {
  return { key: `@_${openId}`, openId, name, isBot };
}

const SELF = 'ou_self';

describe('resolveBotPeerForMention', () => {
  it('bot sender in a group → @ the sender back', () => {
    const peer = resolveBotPeerForMention({
      isGroup: true,
      senderIsBot: true,
      senderId: 'ou_peer_bot',
      senderName: 'PeerBot',
      mentions: [],
      botOpenId: SELF,
    });
    expect(peer).toEqual({ peerOpenId: 'ou_peer_bot', peerName: 'PeerBot' });
  });

  it('human kickoff @-mentioning self + one opponent → @ the opponent', () => {
    // Mirrors "you two debate, @ZJ start": human @s the opponent (twice) and self.
    const peer = resolveBotPeerForMention({
      isGroup: true,
      senderIsBot: false,
      senderId: 'ou_human',
      senderName: 'Human',
      mentions: [m('ou_opponent', '云端Openclaw'), m('ou_opponent', '云端Openclaw'), m(SELF, 'ZJ', true)],
      botOpenId: SELF,
    });
    expect(peer).toEqual({ peerOpenId: 'ou_opponent', peerName: '云端Openclaw' });
  });

  it('human sender, no non-self mention → no forced peer', () => {
    const peer = resolveBotPeerForMention({
      isGroup: true,
      senderIsBot: false,
      senderId: 'ou_human',
      mentions: [m(SELF, 'ZJ', true)],
      botOpenId: SELF,
    });
    expect(peer).toBeUndefined();
  });

  it('human sender, multiple distinct non-self mentions → ambiguous, no forced peer', () => {
    const peer = resolveBotPeerForMention({
      isGroup: true,
      senderIsBot: false,
      senderId: 'ou_human',
      mentions: [m('ou_a', 'A'), m('ou_b', 'B')],
      botOpenId: SELF,
    });
    expect(peer).toBeUndefined();
  });

  it('DM → never forces a peer', () => {
    const peer = resolveBotPeerForMention({
      isGroup: false,
      senderIsBot: true,
      senderId: 'ou_peer_bot',
      mentions: [m('ou_opponent', 'Opp')],
      botOpenId: SELF,
    });
    expect(peer).toBeUndefined();
  });

  it('excludes self even when botOpenId is the only signal', () => {
    const peer = resolveBotPeerForMention({
      isGroup: true,
      senderIsBot: false,
      senderId: 'ou_human',
      mentions: [m(SELF, 'ZJ', false), m('ou_opponent', 'Opp')],
      botOpenId: SELF,
    });
    expect(peer).toEqual({ peerOpenId: 'ou_opponent', peerName: 'Opp' });
  });
});
