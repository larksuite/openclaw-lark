/**
 * Tests for subagent-completion-handler.ts
 *
 * Mocks all infrastructure dependencies and exercises the merge logic paths.
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

const mockUpdateCardFeishu = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/messaging/outbound/send', () => ({
  updateCardFeishu: (...args: unknown[]) => mockUpdateCardFeishu(...args),
  buildMarkdownCard: (text: string) => ({ type: 'markdown', text }),
}));

vi.mock('../src/card/builder', () => ({
  STREAMING_ELEMENT_ID: 'streaming_content',
  buildCardContent: (_state: string, data: { text?: string }) => ({ text: data?.text ?? '' }),
  toCardKit2: (card: unknown) => card,
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import {
  buildConversationKey,
  registerCompletedCard,
  removeCompletedCard,
} from '../src/card/card-registry';
import { handleSubagentCompletion } from '../src/card/subagent-completion-handler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_CFG = {} as Parameters<typeof handleSubagentCompletion>[0]['cfg'];

function registerMainCard(opts: {
  to: string;
  accountId?: string;
  threadId?: string;
  messageId?: string;
  completedText?: string;
  streamingOpen?: boolean;
  phase?: 'main_streaming' | 'main_done_waiting_subagents' | 'completed' | 'aborted' | 'error';
  cardKitCardId?: string | null;
}) {
  registerCompletedCard({
    context: { to: opts.to, accountId: opts.accountId, threadId: opts.threadId },
    messageId: opts.messageId ?? 'msg-001',
    cardKitCardId: opts.cardKitCardId !== undefined ? opts.cardKitCardId : 'card-001',
    cardKitSequence: 1,
    completedText: opts.completedText ?? 'Main reply',
    originalCompletedText: opts.completedText ?? 'Main reply',
    streamingOpen: opts.streamingOpen ?? false,
    startedAt: Date.now() - 1000,
    phase: opts.phase ?? 'main_done_waiting_subagents',
    activeSubagentCount: 1,
    bufferedCompletions: [],
    appliedCompletionIds: [],
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleSubagentCompletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Case 1: registry entry exists, non-streaming mode → merged
  it('case 1: merges into existing non-streaming card', async () => {
    const to = 'oc_case1';
    registerMainCard({ to, streamingOpen: false });

    const result = await handleSubagentCompletion({
      cfg: MOCK_CFG,
      to,
      text: 'Subagent result',
    });

    expect(result.status).toBe('merged');
    expect(result).toMatchObject({ status: 'merged', messageId: 'msg-001', chatId: 'oc_case1' });
    expect(mockUpdateCardKitCard).toHaveBeenCalledOnce();
  });

  // Case 2: early arrival (phase = main_streaming) → buffered
  it('case 2: buffers completion when main card is still streaming', async () => {
    const to = 'oc_case2';
    registerMainCard({ to, phase: 'main_streaming' });

    const result = await handleSubagentCompletion({
      cfg: MOCK_CFG,
      to,
      text: 'Early subagent result',
      completionId: 'comp-early',
    });

    expect(result.status).toBe('merged');
    // No card APIs should have been called (just buffered)
    expect(mockStreamCardContent).not.toHaveBeenCalled();
    expect(mockSetCardStreamingMode).not.toHaveBeenCalled();
    expect(mockUpdateCardKitCard).not.toHaveBeenCalled();
    expect(mockUpdateCardFeishu).not.toHaveBeenCalled();

    // Clean up
    removeCompletedCard(buildConversationKey({ to }));
  });

  // Case 3: streaming merge (streamingOpen = true)
  it('case 3: streaming merge calls stream → closeStreaming → updateCard', async () => {
    const to = 'oc_case3';
    registerMainCard({ to, streamingOpen: true, completedText: 'Main' });

    const result = await handleSubagentCompletion({
      cfg: MOCK_CFG,
      to,
      text: 'Extra info',
    });

    expect(result.status).toBe('merged');
    expect(mockStreamCardContent).toHaveBeenCalledOnce();
    expect(mockSetCardStreamingMode).toHaveBeenCalledOnce();
    expect(mockUpdateCardKitCard).toHaveBeenCalledOnce();
  });

  // Case 4: same chat, different threadId → entries are independent
  it('case 4: different threadId entries do not interfere', async () => {
    const to = 'oc_case4';
    registerMainCard({ to, threadId: 'thread-1', messageId: 'msg-t1' });
    registerMainCard({ to, threadId: 'thread-2', messageId: 'msg-t2' });

    const r1 = await handleSubagentCompletion({ cfg: MOCK_CFG, to, threadId: 'thread-1', text: 'Result 1' });
    const r2 = await handleSubagentCompletion({ cfg: MOCK_CFG, to, threadId: 'thread-2', text: 'Result 2' });

    expect(r1.status).toBe('merged');
    expect(r2.status).toBe('merged');
    if (r1.status === 'merged') expect(r1.messageId).toBe('msg-t1');
    if (r2.status === 'merged') expect(r2.messageId).toBe('msg-t2');
  });

  // Case 5: no main card → fallback
  it('case 5: returns fallback when no entry exists', async () => {
    const result = await handleSubagentCompletion({
      cfg: MOCK_CFG,
      to: 'oc_no_entry',
      text: 'Orphan result',
    });
    expect(result.status).toBe('fallback');
  });

  // Case 6: duplicate completionId → dedup, no double-append
  it('case 6: deduplicates completionId', async () => {
    const to = 'oc_case6';
    registerMainCard({ to, completedText: 'Initial' });

    // First merge
    await handleSubagentCompletion({ cfg: MOCK_CFG, to, text: 'Result A', completionId: 'comp-1' });
    vi.clearAllMocks();

    // Re-register with comp-1 already applied (simulates re-registration done inside handler)
    registerCompletedCard({
      context: { to },
      messageId: 'msg-001',
      cardKitCardId: 'card-001',
      cardKitSequence: 2,
      completedText: 'Initial\nResult A',
      phase: 'main_done_waiting_subagents',
      appliedCompletionIds: ['comp-1'],
    });

    // Second call with same completionId
    const result = await handleSubagentCompletion({
      cfg: MOCK_CFG,
      to,
      text: 'Result A',
      completionId: 'comp-1',
    });

    expect(result.status).toBe('merged');
    // No card API calls because it was deduped
    expect(mockUpdateCardKitCard).not.toHaveBeenCalled();

    // Clean up
    removeCompletedCard(buildConversationKey({ to }));
  });

  // Case 7: completed phase → fallback
  it('case 7: returns fallback for terminal completed phase', async () => {
    const to = 'oc_case7';
    registerMainCard({ to, phase: 'completed' });

    const result = await handleSubagentCompletion({ cfg: MOCK_CFG, to, text: 'Late result' });
    expect(result.status).toBe('fallback');
  });

  // Case 8: aborted phase → fallback
  it('case 8: returns fallback for aborted phase', async () => {
    const to = 'oc_case8';
    registerMainCard({ to, phase: 'aborted' });

    const result = await handleSubagentCompletion({ cfg: MOCK_CFG, to, text: 'Late result' });
    expect(result.status).toBe('fallback');
  });

  // Case 9: legacy fallback (no cardKitCardId)
  it('case 9: uses legacy IM patch when no cardKitCardId', async () => {
    const to = 'oc_case9';
    registerMainCard({ to, cardKitCardId: null });

    const result = await handleSubagentCompletion({ cfg: MOCK_CFG, to, text: 'Result' });

    expect(result.status).toBe('merged');
    expect(mockUpdateCardFeishu).toHaveBeenCalledOnce();
    expect(mockUpdateCardKitCard).not.toHaveBeenCalled();
  });

  // Case 10: card API throws → fallback
  it('case 10: returns fallback when cardkit API throws', async () => {
    mockUpdateCardKitCard.mockRejectedValueOnce(new Error('API error'));

    const to = 'oc_case10';
    registerMainCard({ to });

    const result = await handleSubagentCompletion({ cfg: MOCK_CFG, to, text: 'Result' });
    expect(result.status).toBe('fallback');
  });
});
