/**
 * Tests for card-registry conversation-scoped key isolation
 * and merge lock mechanism.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  acquireMergeLock,
  buildConversationKey,
  generateDispatchId,
  getCompletedCard,
  registerCompletedCard,
  releaseMergeLock,
  removeCompletedCard,
  updateCompletedCard,
} from '../src/card/card-registry';

let regCounter = 0;

// Helper to create a minimal valid CardEntry registration
function reg(params: {
  to: string;
  accountId?: string;
  threadId?: string;
  messageId?: string;
  phase?: 'streaming' | 'waiting_subagents' | 'merging' | 'completed' | 'aborted';
  dispatchId?: string;
}) {
  registerCompletedCard({
    context: { to: params.to, accountId: params.accountId, threadId: params.threadId },
    messageId: params.messageId ?? 'msg-001',
    cardKitCardId: 'card-001',
    cardKitSequence: 1,
    completedText: 'Hello',
    phase: params.phase ?? 'waiting_subagents',
    dispatchId: params.dispatchId ?? `test-${++regCounter}`,
  });
}

describe('card-registry key isolation', () => {
  it('same chatId with different threadId produces different keys', () => {
    const key1 = buildConversationKey({ to: 'oc_abc', accountId: 'default', threadId: 'thread-1' });
    const key2 = buildConversationKey({ to: 'oc_abc', accountId: 'default', threadId: 'thread-2' });
    expect(key1).not.toBe(key2);
  });

  it('different threadId entries are tracked independently', () => {
    const to = 'oc_test_isolation';
    const accountId = 'acct';

    reg({ to, accountId, threadId: 'thread-A', messageId: 'msg-A' });
    reg({ to, accountId, threadId: 'thread-B', messageId: 'msg-B' });

    const keyA = buildConversationKey({ to, accountId, threadId: 'thread-A' });
    const keyB = buildConversationKey({ to, accountId, threadId: 'thread-B' });

    const entryA = getCompletedCard(keyA);
    const entryB = getCompletedCard(keyB);

    expect(entryA?.messageId).toBe('msg-A');
    expect(entryB?.messageId).toBe('msg-B');

    // Cleanup
    removeCompletedCard(keyA);
    removeCompletedCard(keyB);
  });

  it('key not matched returns undefined (no fallback scan)', () => {
    const to = 'oc_no_match';
    reg({ to, accountId: 'acct', threadId: 'thread-X' });

    const wrongKey = buildConversationKey({ to, accountId: 'acct', threadId: 'thread-Y' });
    const result = getCompletedCard(wrongKey);
    expect(result).toBeUndefined();

    removeCompletedCard(buildConversationKey({ to, accountId: 'acct', threadId: 'thread-X' }));
  });

  it('removeCompletedCard deletes the entry', () => {
    const to = 'oc_remove_test';
    const key = buildConversationKey({ to, accountId: 'acct' });

    reg({ to, accountId: 'acct' });

    removeCompletedCard(key);
    const result = getCompletedCard(key);
    expect(result).toBeUndefined();
  });

  it('buildConversationKey includes channel prefix', () => {
    const key = buildConversationKey({ to: 'oc_abc', accountId: 'default' });
    expect(key.startsWith('feishu|')).toBe(true);
  });

  it('returns undefined for entries older than TTL', () => {
    vi.useFakeTimers();
    const to = 'oc_ttl_test';
    const key = buildConversationKey({ to, accountId: 'acc1' });
    reg({ to, accountId: 'acc1' });
    vi.advanceTimersByTime(5 * 60 * 1000 + 1); // just past 5-minute TTL
    expect(getCompletedCard(key)).toBeUndefined();
    vi.useRealTimers();
  });
});

describe('card-registry get/update API', () => {
  it('getCompletedCard reads without removing', () => {
    const to = 'oc_get_test';
    const key = buildConversationKey({ to, accountId: 'acct' });
    reg({ to, accountId: 'acct' });

    // First read
    const first = getCompletedCard(key);
    expect(first?.messageId).toBe('msg-001');

    // Second read — still available
    const second = getCompletedCard(key);
    expect(second?.messageId).toBe('msg-001');

    removeCompletedCard(key);
  });

  it('updateCompletedCard modifies fields in place', () => {
    const to = 'oc_update_test';
    const key = buildConversationKey({ to, accountId: 'acct' });
    reg({ to, accountId: 'acct' });

    updateCompletedCard(key, { completedText: 'Updated text', phase: 'completed' });

    const entry = getCompletedCard(key);
    expect(entry?.completedText).toBe('Updated text');
    expect(entry?.phase).toBe('completed');
    expect(entry?.messageId).toBe('msg-001'); // unchanged field

    removeCompletedCard(key);
  });

  it('updateCompletedCard is no-op for missing entries', () => {
    updateCompletedCard('nonexistent-key', { completedText: 'whatever' });
    // Should not throw
  });
});

describe('card-registry merge lock', () => {
  it('acquireMergeLock succeeds from waiting_subagents phase', () => {
    const to = 'oc_lock_test';
    const key = buildConversationKey({ to, accountId: 'acct' });
    reg({ to, accountId: 'acct', phase: 'waiting_subagents' });

    const entry = acquireMergeLock(key);
    expect(entry).toBeDefined();
    // acquireMergeLock updates phase in-place, so both the returned
    // reference and the registry entry reflect 'merging'.
    expect(entry?.phase).toBe('merging');

    const current = getCompletedCard(key);
    expect(current?.phase).toBe('merging');

    releaseMergeLock(key, { phase: 'waiting_subagents' });
    removeCompletedCard(key);
  });

  it('acquireMergeLock fails from non-waiting phases', () => {
    const to = 'oc_lock_fail_test';
    const key = buildConversationKey({ to, accountId: 'acct' });

    reg({ to, accountId: 'acct', phase: 'streaming' });
    expect(acquireMergeLock(key)).toBeUndefined();

    reg({ to, accountId: 'acct', phase: 'completed' });
    expect(acquireMergeLock(key)).toBeUndefined();

    reg({ to, accountId: 'acct', phase: 'merging' });
    expect(acquireMergeLock(key)).toBeUndefined();

    removeCompletedCard(key);
  });

  it('releaseMergeLock updates entry and reverts phase', () => {
    const to = 'oc_release_test';
    const key = buildConversationKey({ to, accountId: 'acct' });
    reg({ to, accountId: 'acct', phase: 'waiting_subagents' });

    acquireMergeLock(key);

    releaseMergeLock(key, {
      completedText: 'Merged text',
      cardKitSequence: 10,
      phase: 'completed',
    });

    const entry = getCompletedCard(key);
    expect(entry?.completedText).toBe('Merged text');
    expect(entry?.cardKitSequence).toBe(10);
    expect(entry?.phase).toBe('completed');

    removeCompletedCard(key);
  });
});
