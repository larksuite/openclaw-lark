/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for the per-chat name→openId registry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  lookupByName,
  purgeStaleEntries,
  recordMention,
  recordSender,
  resetMentionRegistry,
} from '../src/messaging/inbound/mention-registry';

beforeEach(() => {
  resetMentionRegistry();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('mention-registry', () => {
  it('records and looks up by exact name', () => {
    recordMention('oc_chat', 'ou_alice', 'Alice');
    expect(lookupByName('oc_chat', 'Alice')).toBe('ou_alice');
  });

  it('lookup is case-insensitive and ignores surrounding whitespace', () => {
    recordSender('oc_chat', 'ou_bob', 'Bob');
    expect(lookupByName('oc_chat', 'BOB')).toBe('ou_bob');
    expect(lookupByName('oc_chat', '  bob  ')).toBe('ou_bob');
  });

  it('scopes per chatId', () => {
    recordMention('oc_chat_a', 'ou_alice_a', 'Alice');
    recordMention('oc_chat_b', 'ou_alice_b', 'Alice');
    expect(lookupByName('oc_chat_a', 'Alice')).toBe('ou_alice_a');
    expect(lookupByName('oc_chat_b', 'Alice')).toBe('ou_alice_b');
  });

  it('returns undefined for unknown name', () => {
    recordMention('oc_chat', 'ou_alice', 'Alice');
    expect(lookupByName('oc_chat', 'Charlie')).toBeUndefined();
  });

  it('returns undefined for unknown chat', () => {
    recordMention('oc_chat_a', 'ou_alice', 'Alice');
    expect(lookupByName('oc_other', 'Alice')).toBeUndefined();
  });

  it('newer record overwrites older entry for the same name', () => {
    recordMention('oc_chat', 'ou_old', 'Dana');
    recordMention('oc_chat', 'ou_new', 'Dana');
    expect(lookupByName('oc_chat', 'Dana')).toBe('ou_new');
  });

  it('ignores empty/falsy inputs', () => {
    recordMention('', 'ou_x', 'X');
    recordMention('oc_chat', '', 'X');
    recordMention('oc_chat', 'ou_x', '');
    expect(lookupByName('oc_chat', 'X')).toBeUndefined();
  });

  it('TTL eviction on read', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    recordMention('oc_chat', 'ou_eve', 'Eve');
    expect(lookupByName('oc_chat', 'Eve', { ttlMs: 1000 })).toBe('ou_eve');
    vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
    expect(lookupByName('oc_chat', 'Eve', { ttlMs: 1000 })).toBeUndefined();
  });

  it('purgeStaleEntries drops aged entries and empties chats', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    recordMention('oc_chat', 'ou_eve', 'Eve');
    vi.setSystemTime(new Date('2026-01-01T00:00:05Z'));
    purgeStaleEntries(1000);
    expect(lookupByName('oc_chat', 'Eve')).toBeUndefined();
  });
});
