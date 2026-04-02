/**
 * Tests for subagent-completion-handler.ts
 *
 * Mocks all infrastructure dependencies and exercises the merge logic paths.
 *
 * Key invariant: mergeIntoCard() only pushes content via streamCardContent().
 * It NEVER closes streaming mode or sends a final card.update — that is the
 * responsibility of finalizeCardAfterSubagents() in subagent-tracker.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../src/core/targets', () => ({
  normalizeFeishuTarget: (to: string) => to.replace(/^chat:/, ''),
}));

const mockStreamCardContent = vi.fn().mockResolvedValue(undefined);
const mockSetCardStreamingMode = vi.fn().mockResolvedValue(undefined);
const mockUpdateCardKitCard = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/card/cardkit', () => ({
  streamCardContent: (...args: unknown[]) => mockStreamCardContent(...args),
  setCardStreamingMode: (...args: unknown[]) => mockSetCardStreamingMode(...args),
  updateCardKitCard: (...args: unknown[]) => mockUpdateCardKitCard(...args),
}));

vi.mock('../src/card/builder', () => ({
  STREAMING_ELEMENT_ID: 'streaming_content',
  buildCardContent: (_state: string, data: { text?: string }) => ({ text: data?.text ?? '' }),
  toCardKit2: (card: unknown) => card,
}));

// Mock subagent-tracker
// Default: hasActiveRunsForDispatch returns true (subagents are active for the dispatch)
const mockHasActiveRunsForDispatch = vi.fn().mockReturnValue(true);
vi.mock('../src/card/subagent-tracker', () => ({
  hasActiveRunsForDispatch: (...args: unknown[]) => mockHasActiveRunsForDispatch(...args),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import {
  buildConversationKey,
  getCompletedCard,
  registerCompletedCard,
  removeCompletedCard,
  updateCompletedCard,
} from '../src/card/card-registry';
import { flushPendingCompletions, handleSubagentCompletion } from '../src/card/subagent-completion-handler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_CFG = {} as Parameters<typeof handleSubagentCompletion>[0]['cfg'];

let helperCounter = 0;

function registerMainCard(opts: {
  to: string;
  accountId?: string;
  threadId?: string;
  messageId?: string;
  completedText?: string;
  streamingOpen?: boolean;
  phase?: 'streaming' | 'waiting_subagents' | 'merging' | 'completed' | 'aborted';
  cardKitCardId?: string | null;
  dispatchId?: string;
}) {
  registerCompletedCard({
    context: { to: opts.to, accountId: opts.accountId, threadId: opts.threadId },
    messageId: opts.messageId ?? 'msg-001',
    cardKitCardId: opts.cardKitCardId !== undefined ? opts.cardKitCardId : 'card-001',
    cardKitSequence: 1,
    completedText: opts.completedText ?? 'Main reply',
    streamingOpen: opts.streamingOpen ?? true,
    startedAt: Date.now() - 1000,
    phase: opts.phase ?? 'waiting_subagents',
    appliedCompletionIds: [],
    dispatchId: opts.dispatchId ?? `test-dispatch-${++helperCounter}`,
  });
}

// ---------------------------------------------------------------------------
// Tests — core merge paths
// ---------------------------------------------------------------------------

describe('handleSubagentCompletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no dispatchId check (tracker returns undefined = no constraint)
    mockHasActiveRunsForDispatch.mockReturnValue(true);
  });

  it('pushes content via streamCardContent without closing streaming', async () => {
    const to = 'oc_push';
    registerMainCard({ to, streamingOpen: true, completedText: 'Main' });

    const result = await handleSubagentCompletion({ cfg: MOCK_CFG, to, text: 'Subagent result' });

    expect(result.status).toBe('merged');
    expect(mockStreamCardContent).toHaveBeenCalledOnce();
    expect(mockSetCardStreamingMode).not.toHaveBeenCalled();
    expect(mockUpdateCardKitCard).not.toHaveBeenCalled();

    const entry = getCompletedCard(buildConversationKey({ to }));
    expect(entry?.phase).toBe('waiting_subagents');
    expect(entry?.streamingOpen).toBe(true);
    expect(entry?.completedText).toContain('Subagent result');

    removeCompletedCard(buildConversationKey({ to }));
  });

  it('different threadId entries do not interfere', async () => {
    const to = 'oc_threads';
    registerMainCard({ to, threadId: 'thread-1', messageId: 'msg-t1' });
    registerMainCard({ to, threadId: 'thread-2', messageId: 'msg-t2' });

    const r1 = await handleSubagentCompletion({ cfg: MOCK_CFG, to, threadId: 'thread-1', text: 'R1' });
    const r2 = await handleSubagentCompletion({ cfg: MOCK_CFG, to, threadId: 'thread-2', text: 'R2' });

    expect(r1.status).toBe('merged');
    expect(r2.status).toBe('merged');
    if (r1.status === 'merged') expect(r1.messageId).toBe('msg-t1');
    if (r2.status === 'merged') expect(r2.messageId).toBe('msg-t2');

    removeCompletedCard(buildConversationKey({ to, threadId: 'thread-1' }));
    removeCompletedCard(buildConversationKey({ to, threadId: 'thread-2' }));
  });

  it('returns fallback when no entry exists', async () => {
    const result = await handleSubagentCompletion({ cfg: MOCK_CFG, to: 'oc_no_entry', text: 'Orphan' });
    expect(result.status).toBe('fallback');
  });

  it('deduplicates completionId', async () => {
    const to = 'oc_dedup';
    registerCompletedCard({
      context: { to },
      messageId: 'msg-001',
      cardKitCardId: 'card-001',
      cardKitSequence: 2,
      completedText: 'Already merged',
      phase: 'waiting_subagents',
      streamingOpen: true,
      appliedCompletionIds: ['comp-1'],
      dispatchId: 'dedup-test',
    });

    const result = await handleSubagentCompletion({ cfg: MOCK_CFG, to, text: 'Dup', completionId: 'comp-1' });
    expect(result.status).toBe('merged');
    expect(mockStreamCardContent).not.toHaveBeenCalled();
    removeCompletedCard(buildConversationKey({ to }));
  });

  it('returns fallback for terminal phases', async () => {
    for (const phase of ['completed', 'aborted'] as const) {
      const to = `oc_term_${phase}`;
      registerMainCard({ to, phase });
      const result = await handleSubagentCompletion({ cfg: MOCK_CFG, to, text: 'Late' });
      expect(result.status).toBe('fallback');
    }
  });

  it('updates registry text even without cardKitCardId', async () => {
    const to = 'oc_no_cardkit';
    registerMainCard({ to, cardKitCardId: null, streamingOpen: false });

    const result = await handleSubagentCompletion({ cfg: MOCK_CFG, to, text: 'Result' });
    expect(result.status).toBe('merged');
    expect(mockStreamCardContent).not.toHaveBeenCalled();
    const entry = getCompletedCard(buildConversationKey({ to }));
    expect(entry?.completedText).toContain('Result');
    removeCompletedCard(buildConversationKey({ to }));
  });

  it('returns fallback when streamCardContent throws', async () => {
    mockStreamCardContent.mockRejectedValueOnce(new Error('API error'));
    const to = 'oc_error';
    registerMainCard({ to, streamingOpen: true });

    const result = await handleSubagentCompletion({ cfg: MOCK_CFG, to, text: 'Result' });
    expect(result.status).toBe('fallback');
  });

  it('merges text with separator', async () => {
    const to = 'oc_sep';
    registerMainCard({ to, completedText: 'Main output', streamingOpen: true });

    await handleSubagentCompletion({ cfg: MOCK_CFG, to, text: 'Sub result' });
    const entry = getCompletedCard(buildConversationKey({ to }));
    expect(entry?.completedText).toBe('Main output\n\nSub result');
    removeCompletedCard(buildConversationKey({ to }));
  });
});

// ---------------------------------------------------------------------------
// Regression: P1 — early subagent buffering
// ---------------------------------------------------------------------------

describe('[P1] early subagent buffering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasActiveRunsForDispatch.mockReturnValue(true);
  });

  it('stores completion on CardEntry.pendingCompletions when phase is streaming', async () => {
    const to = 'oc_buf';
    registerMainCard({ to, phase: 'streaming' });

    const result = await handleSubagentCompletion({ cfg: MOCK_CFG, to, text: 'Early result', completionId: 'c1' });

    expect(result.status).toBe('buffered');
    expect(mockStreamCardContent).not.toHaveBeenCalled();

    // The entry's pendingCompletions should contain the buffered item
    const entry = getCompletedCard(buildConversationKey({ to }));
    expect(entry?.pendingCompletions).toHaveLength(1);
    expect(entry?.pendingCompletions[0].text).toBe('Early result');
    expect(entry?.pendingCompletions[0].completionId).toBe('c1');

    removeCompletedCard(buildConversationKey({ to }));
  });

  it('flushPendingCompletions replays buffered items after phase transition', async () => {
    const to = 'oc_flush';
    const key = buildConversationKey({ to });
    registerMainCard({ to, phase: 'streaming', completedText: 'Main' });

    // Buffer two completions
    await handleSubagentCompletion({ cfg: MOCK_CFG, to, text: 'Early-1' });
    await handleSubagentCompletion({ cfg: MOCK_CFG, to, text: 'Early-2' });

    expect(getCompletedCard(key)?.pendingCompletions).toHaveLength(2);

    // Simulate reply-dispatcher.onIdle: transition phase, then flush
    updateCompletedCard(key, { phase: 'waiting_subagents' });
    await flushPendingCompletions({ cfg: MOCK_CFG, chatId: to });

    // Both should have been merged
    const entry = getCompletedCard(key);
    expect(entry?.completedText).toContain('Early-1');
    expect(entry?.completedText).toContain('Early-2');
    expect(entry?.pendingCompletions).toHaveLength(0);
    expect(mockStreamCardContent).toHaveBeenCalledTimes(2);

    removeCompletedCard(key);
  });
});

// ---------------------------------------------------------------------------
// Regression: P1 — dispatchId verification
// ---------------------------------------------------------------------------

describe('[P1] dispatchId isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects completion when no active runs exist for the card dispatchId (stale subagent)', async () => {
    const to = 'oc_dispatch';
    registerMainCard({ to, dispatchId: 'dispatch-old' });

    // Simulate: no active runs for this dispatch (all evicted)
    mockHasActiveRunsForDispatch.mockReturnValue(false);

    const result = await handleSubagentCompletion({ cfg: MOCK_CFG, to, text: 'Stale result' });

    expect(result.status).toBe('fallback');
    expect(mockStreamCardContent).not.toHaveBeenCalled();
    removeCompletedCard(buildConversationKey({ to }));
  });

  it('allows completion when active runs exist for the card dispatchId', async () => {
    const to = 'oc_dispatch_ok';
    registerMainCard({ to, dispatchId: 'dispatch-current' });
    mockHasActiveRunsForDispatch.mockReturnValue(true);

    const result = await handleSubagentCompletion({ cfg: MOCK_CFG, to, text: 'Good result' });
    expect(result.status).toBe('merged');
    removeCompletedCard(buildConversationKey({ to }));
  });

  it('skips dispatch check when card has no dispatchId', async () => {
    const to = 'oc_dispatch_none';
    registerMainCard({ to, dispatchId: '' }); // empty = no dispatch tracking

    const result = await handleSubagentCompletion({ cfg: MOCK_CFG, to, text: 'Good result' });
    // Empty dispatchId bypasses the check, falls through to merge
    expect(result.status).toBe('merged');
    removeCompletedCard(buildConversationKey({ to }));
  });
});

// ---------------------------------------------------------------------------
// Regression: P2 — concurrent merge failure propagation
// ---------------------------------------------------------------------------

describe('[P2] concurrent merge failure propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasActiveRunsForDispatch.mockReturnValue(true);
  });

  it('returns fallback (not merged) when queued merge fails due to API error', async () => {
    const to = 'oc_conc_fail';
    registerMainCard({ to, streamingOpen: true });
    mockStreamCardContent.mockRejectedValueOnce(new Error('CardKit API error'));

    // This goes through the queue; the actual merge fails
    const result = await handleSubagentCompletion({ cfg: MOCK_CFG, to, text: 'Should fail' });

    // Must be 'fallback', NOT 'merged' — the caller needs to know so it can
    // deliver as a standalone message.
    expect(result.status).toBe('fallback');
  });

  it('returns fallback when queued merge cannot acquire lock', async () => {
    const to = 'oc_conc_lock';
    registerMainCard({ to, phase: 'completed' });

    const result = await handleSubagentCompletion({ cfg: MOCK_CFG, to, text: 'Locked out' });
    // Terminal phase → fallback
    expect(result.status).toBe('fallback');
  });
});
