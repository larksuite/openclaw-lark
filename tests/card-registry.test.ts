/**
 * Tests for card-registry conversation-scoped key isolation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  buildConversationKey,
  consumeCompletedCard,
  registerCompletedCard,
  removeCompletedCard,
} from '../src/card/card-registry';

// Helper to create a minimal valid CardEntry registration
function reg(params: { to: string; accountId?: string; threadId?: string; messageId?: string }) {
  registerCompletedCard({
    context: { to: params.to, accountId: params.accountId, threadId: params.threadId },
    messageId: params.messageId ?? 'msg-001',
    cardKitCardId: 'card-001',
    cardKitSequence: 1,
    completedText: 'Hello',
    phase: 'main_done_waiting_subagents',
  });
}

describe('card-registry key isolation', () => {
  beforeEach(() => {
    // Clear registry between tests by consuming anything that was registered
    // with the keys we use in tests (no direct clear API).
  });

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

    const entryA = consumeCompletedCard(keyA);
    const entryB = consumeCompletedCard(keyB);

    expect(entryA?.messageId).toBe('msg-A');
    expect(entryB?.messageId).toBe('msg-B');
  });

  it('key not matched returns undefined (no fallback scan)', () => {
    const to = 'oc_no_match';
    reg({ to, accountId: 'acct', threadId: 'thread-X' });

    // Query with wrong threadId — should NOT find the entry
    const wrongKey = buildConversationKey({ to, accountId: 'acct', threadId: 'thread-Y' });
    const result = consumeCompletedCard(wrongKey);
    expect(result).toBeUndefined();

    // Clean up
    removeCompletedCard(buildConversationKey({ to, accountId: 'acct', threadId: 'thread-X' }));
  });

  it('removeCompletedCard deletes the entry', () => {
    const to = 'oc_remove_test';
    const key = buildConversationKey({ to, accountId: 'acct' });

    reg({ to, accountId: 'acct' });

    removeCompletedCard(key);
    const result = consumeCompletedCard(key);
    expect(result).toBeUndefined();
  });

  it('buildConversationKey includes channel prefix', () => {
    const key = buildConversationKey({ to: 'oc_abc', accountId: 'default' });
    expect(key.startsWith('feishu|')).toBe(true);
  });

  it('entry with phase and new fields is preserved through register/consume cycle', () => {
    const to = 'oc_phase_test';
    const key = buildConversationKey({ to, accountId: 'acct', threadId: 't1' });

    registerCompletedCard({
      context: { to, accountId: 'acct', threadId: 't1' },
      messageId: 'msg-phase',
      cardKitCardId: 'card-phase',
      cardKitSequence: 5,
      completedText: 'Done',
      phase: 'main_done_waiting_subagents',
      activeSubagentCount: 2,
      bufferedCompletions: [{ text: 'buffered', arrivedAt: 1000 }],
      appliedCompletionIds: ['comp-1'],
    });

    const entry = consumeCompletedCard(key);
    expect(entry).toBeDefined();
    expect(entry?.phase).toBe('main_done_waiting_subagents');
    expect(entry?.activeSubagentCount).toBe(2);
    expect(entry?.bufferedCompletions).toHaveLength(1);
    expect(entry?.appliedCompletionIds).toContain('comp-1');
    expect(entry?.threadId).toBe('t1');
  });
});
