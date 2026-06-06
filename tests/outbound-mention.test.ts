/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Tests for outbound mention normalization + ensureMention safety net.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  ensureMention,
  normalizeOutboundMentions,
} from '../src/messaging/outbound/outbound-mention';
import {
  recordMention,
  resetMentionRegistry,
} from '../src/messaging/inbound/mention-registry';

const CHAT = 'oc_test';

beforeEach(() => {
  resetMentionRegistry();
  recordMention(CHAT, 'ou_alice', 'Alice');
  recordMention(CHAT, 'ou_zhang', '张三');
  recordMention(CHAT, 'ou_peer', 'PeerBot');
});

describe('normalizeOutboundMentions — six LLM variants', () => {
  it('@Name → standard <at>', () => {
    expect(normalizeOutboundMentions('hi @Alice', CHAT)).toBe(
      'hi <at user_id="ou_alice">Alice</at>',
    );
  });

  it('@[Name] → standard <at>', () => {
    expect(normalizeOutboundMentions('hi @[Alice] there', CHAT)).toBe(
      'hi <at user_id="ou_alice">Alice</at> there',
    );
  });

  it('@<Name> → standard <at>', () => {
    expect(normalizeOutboundMentions('hi @<Alice>', CHAT)).toBe(
      'hi <at user_id="ou_alice">Alice</at>',
    );
  });

  it('<@Name> → standard <at>', () => {
    expect(normalizeOutboundMentions('hi <@Alice>!', CHAT)).toBe(
      'hi <at user_id="ou_alice">Alice</at>!',
    );
  });

  it('<at>Name</at> (no user_id) → standard <at>', () => {
    expect(normalizeOutboundMentions('hi <at>Alice</at>', CHAT)).toBe(
      'hi <at user_id="ou_alice">Alice</at>',
    );
  });

  it('{{Name}} → standard <at>', () => {
    expect(normalizeOutboundMentions('hi {{Alice}}', CHAT)).toBe(
      'hi <at user_id="ou_alice">Alice</at>',
    );
  });

  it('CJK name', () => {
    expect(normalizeOutboundMentions('请 @张三 看看', CHAT)).toBe(
      '请 <at user_id="ou_zhang">张三</at> 看看',
    );
  });
});

describe('normalizeOutboundMentions — boundary behavior', () => {
  it('preserves an already-standard <at> element verbatim', () => {
    const text = 'hi <at user_id="ou_alice">Alice</at> there';
    expect(normalizeOutboundMentions(text, CHAT)).toBe(text);
  });

  it('does not double-rewrite a mention that points to the same user', () => {
    const text = '<at user_id="ou_alice">Alice</at>';
    expect(normalizeOutboundMentions(text, CHAT)).toBe(text);
  });

  it('leaves unknown names as plain text', () => {
    expect(normalizeOutboundMentions('hi @Stranger', CHAT)).toBe('hi @Stranger');
  });

  it('does not touch @ inside email addresses', () => {
    expect(normalizeOutboundMentions('contact me@example.com', CHAT)).toBe(
      'contact me@example.com',
    );
  });

  it('returns input unchanged when chatId is empty', () => {
    expect(normalizeOutboundMentions('hi @Alice', '')).toBe('hi @Alice');
  });

  it('returns input unchanged when text is empty', () => {
    expect(normalizeOutboundMentions('', CHAT)).toBe('');
  });
});

describe('ensureMention — bot-peer safety net', () => {
  it('prepends a standard <at> when peer is not already mentioned', () => {
    const out = ensureMention('reply body', 'ou_peer', 'PeerBot');
    expect(out).toBe('<at user_id="ou_peer">PeerBot</at> reply body');
  });

  it('no-op when peer is already mentioned via standard <at>', () => {
    const input = 'hey <at user_id="ou_peer">PeerBot</at>, sounds good';
    expect(ensureMention(input, 'ou_peer', 'PeerBot')).toBe(input);
  });

  it('no-op for empty peerOpenId (caller did not resolve the peer)', () => {
    expect(ensureMention('reply body', '', 'PeerBot')).toBe('reply body');
  });

  it('falls back to openId when peerName is missing', () => {
    expect(ensureMention('reply', 'ou_peer', '')).toBe(
      '<at user_id="ou_peer">ou_peer</at> reply',
    );
  });

  it('returns just the @ element when reply text is empty', () => {
    expect(ensureMention('', 'ou_peer', 'PeerBot')).toBe(
      '<at user_id="ou_peer">PeerBot</at>',
    );
  });
});
