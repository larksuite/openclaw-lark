import { beforeEach, describe, expect, it, vi } from 'vitest';

const cardKitMocks = vi.hoisted(() => ({
  createCardEntity: vi.fn(),
  sendCardByCardId: vi.fn(),
  setCardStreamingMode: vi.fn(),
  streamCardContent: vi.fn(),
  updateCardKitCard: vi.fn(),
}));

vi.mock('openclaw/plugin-sdk/agent-runtime', () => ({
  resolveDefaultAgentId: () => 'main',
}));
vi.mock('openclaw/plugin-sdk/reply-runtime', () => ({
  SILENT_REPLY_TOKEN: 'NO_REPLY',
}));
vi.mock('../src/core/api-error', () => ({
  extractLarkApiCode: () => undefined,
}));
vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../src/core/lark-client', () => ({ LarkClient: {} }));
vi.mock('../src/core/shutdown-hooks', () => ({ registerShutdownHook: () => () => {} }));
vi.mock('../src/messaging/outbound/send', () => ({
  sendCardFeishu: vi.fn(),
  updateCardFeishu: vi.fn(),
}));
vi.mock('../src/card/cardkit', () => cardKitMocks);
vi.mock('../src/card/flush-controller', () => ({
  FlushController: class {
    private readonly flush: () => Promise<void>;

    constructor(flush: () => Promise<void>) {
      this.flush = flush;
    }

    cancelPendingFlush() {}
    complete() {}
    waitForFlush() {
      return Promise.resolve();
    }
    setCardMessageReady() {}
    throttledUpdate() {
      return this.flush();
    }
  },
}));
vi.mock('../src/card/image-resolver', () => ({
  ImageResolver: class {
    resolveImages(text: string) {
      return text;
    }
    resolveImagesAwait(text: string) {
      return Promise.resolve(text);
    }
  },
}));
vi.mock('../src/card/unavailable-guard', () => ({
  UnavailableGuard: class {
    shouldSkip() {
      return false;
    }
    terminate() {
      return false;
    }
    get isTerminated() {
      return false;
    }
  },
}));
vi.mock('../src/card/tool-use-trace-store', () => ({
  getToolUseTraceSteps: vi.fn(() => []),
  clearToolUseTraceRun: vi.fn(),
}));

import type { StreamingCardDeps } from '../src/card/reply-dispatcher-types';
import { StreamingCardController } from '../src/card/streaming-card-controller';

const deps: StreamingCardDeps = {
  cfg: {} as never,
  agentId: 'main',
  sessionKey: 'agent:main:feishu:direct:visible-text-test',
  accountId: 'default',
  chatId: 'oc_visible_text_test',
  replyToMessageId: undefined,
  replyInThread: false,
  toolUseDisplay: {
    mode: 'off',
    showToolUse: false,
    showToolResultDetails: false,
    showFullPaths: false,
  },
  resolvedFooter: {
    status: false,
    elapsed: false,
    tokens: false,
    cache: false,
    context: false,
    model: false,
  },
};

function lastTerminalMarkdown(): string {
  const call = cardKitMocks.updateCardKitCard.mock.calls.at(-1)?.[0] as
    | {
        card?: {
          body?: {
            elements?: Array<{ tag?: string; content?: string }>;
          };
        };
      }
    | undefined;

  return call?.card?.body?.elements?.find((element) => element.tag === 'markdown')?.content ?? '';
}

function lastStreamedMarkdown(): string {
  const call = cardKitMocks.streamCardContent.mock.calls.at(-1)?.[0] as { content?: string } | undefined;
  return call?.content ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  cardKitMocks.createCardEntity.mockResolvedValue('card_visible_text_test');
  cardKitMocks.sendCardByCardId.mockResolvedValue({ messageId: 'om_visible_text_test' });
  cardKitMocks.setCardStreamingMode.mockResolvedValue(undefined);
  cardKitMocks.streamCardContent.mockResolvedValue(undefined);
  cardKitMocks.updateCardKitCard.mockResolvedValue(undefined);
});

describe('StreamingCardController visible text', () => {
  it('keeps text from both sides of a tool boundary in the normal terminal card', async () => {
    const controller = new StreamingCardController(deps);

    controller.onAssistantMessageStart();
    await controller.onPartialReply({ text: 'I will check.' });
    controller.onAssistantMessageStart();
    await controller.onPartialReply({
      text: 'The lookup is complete, and this second segment is much longer.',
    });

    expect(lastStreamedMarkdown()).toBe(
      'I will check.\n\nThe lookup is complete, and this second segment is much longer.',
    );

    await controller.onDeliver(
      { text: 'The lookup is complete, and this second segment is much longer.' },
      { kind: 'final' },
    );

    controller.markFullyComplete();
    await controller.onIdle();

    expect(lastTerminalMarkdown()).toBe(
      'I will check.\n\nThe lookup is complete, and this second segment is much longer.',
    );
  });

  it('commits pre-tool text even when tool-use display is disabled', async () => {
    const controller = new StreamingCardController(deps);

    await controller.onPartialReply({ text: 'I will check.' });
    await controller.onToolStart({ name: 'search', phase: 'start' });
    await controller.onPartialReply({
      text: 'The lookup is complete, and this second segment is much longer.',
    });

    controller.markFullyComplete();
    await controller.onIdle();

    expect(lastTerminalMarkdown()).toBe(
      'I will check.\n\nThe lookup is complete, and this second segment is much longer.',
    );
  });

  it('keeps a delivered update together with a later unfinished stream on error', async () => {
    const controller = new StreamingCardController(deps);

    await controller.onDeliver({ text: 'Search timed out; using cached knowledge.' }, { kind: 'block' });
    controller.onAssistantMessageStart();
    await controller.onPartialReply({ text: 'The best available answer is...' });
    await controller.onError(new Error('synthetic failure'), { kind: 'final' });

    expect(lastTerminalMarkdown()).toContain(
      'Search timed out; using cached knowledge.\n\nThe best available answer is...',
    );
    expect(lastTerminalMarkdown()).toContain('**Error**: An error occurred while generating the response.');
  });

  it('keeps the complete visible ledger when a card is aborted', async () => {
    const controller = new StreamingCardController(deps);

    await controller.onDeliver({ text: 'First visible update.' }, { kind: 'block' });
    controller.onAssistantMessageStart();
    await controller.onPartialReply({ text: 'Second unfinished update.' });
    await controller.abortCard();

    expect(lastTerminalMarkdown()).toBe('First visible update.\n\nSecond unfinished update.');
  });

  it('never writes a delivered NO_REPLY token into the terminal card', async () => {
    const controller = new StreamingCardController(deps);

    await controller.onDeliver({ text: 'Already visible.' }, { kind: 'block' });
    await controller.onDeliver({ text: 'NO_REPLY' }, { kind: 'final' });

    controller.markFullyComplete();
    await controller.onIdle();

    expect(lastTerminalMarkdown()).toBe('Already visible.');
    expect(lastTerminalMarkdown()).not.toContain('NO_REPLY');
  });

  it('keeps earlier text when the next streamed message resolves to NO_REPLY', async () => {
    const controller = new StreamingCardController(deps);

    await controller.onPartialReply({ text: 'Already visible.' });
    controller.onAssistantMessageStart();
    await controller.onPartialReply({ text: 'NO_REPLY' });

    controller.markFullyComplete();
    await controller.onIdle();

    expect(lastTerminalMarkdown()).toBe('Already visible.');
    expect(lastTerminalMarkdown()).not.toContain('NO_REPLY');
  });

  it('treats a delivery without kind metadata as non-authoritative', async () => {
    const controller = new StreamingCardController(deps);

    await controller.onPartialReply({ text: 'The streamed answer is still in progress.' });
    await controller.onDeliver({ text: 'A separately delivered update.' });

    controller.markFullyComplete();
    await controller.onIdle();

    expect(lastTerminalMarkdown()).toBe('The streamed answer is still in progress.\n\nA separately delivered update.');
  });

  it('does not merge two real messages merely because the second starts with the first', async () => {
    const controller = new StreamingCardController(deps);

    await controller.onPartialReply({ text: 'I will check.' });
    controller.onAssistantMessageStart();
    await controller.onDeliver({ text: 'I will check. The answer is 42.' }, { kind: 'final' });

    controller.markFullyComplete();
    await controller.onIdle();

    expect(lastTerminalMarkdown()).toBe('I will check.\n\nI will check. The answer is 42.');
  });

  it('keeps a block when the final answer starts by quoting it', async () => {
    const controller = new StreamingCardController(deps);

    await controller.onDeliver({ text: 'Status: complete.' }, { kind: 'block' });
    await controller.onDeliver({ text: 'Status: complete. Here is the final recommendation.' }, { kind: 'final' });

    controller.markFullyComplete();
    await controller.onIdle();

    expect(lastTerminalMarkdown()).toBe('Status: complete.\n\nStatus: complete. Here is the final recommendation.');
  });

  it('keeps identical final-only messages when explicit starts mark two real messages', async () => {
    const controller = new StreamingCardController(deps);

    controller.onAssistantMessageStart();
    await controller.onDeliver({ text: 'The same final answer.' }, { kind: 'final', assistantMessageIndex: 3 });
    controller.onAssistantMessageStart();
    await controller.onDeliver({ text: 'The same final answer.' }, { kind: 'final', assistantMessageIndex: 4 });

    controller.markFullyComplete();
    await controller.onIdle();

    expect(lastTerminalMarkdown()).toBe('The same final answer.\n\nThe same final answer.');
  });

  it('updates one final in place when the runtime repeats the same delivery identity', async () => {
    const controller = new StreamingCardController(deps);

    await controller.onDeliver({ text: 'Draft final.' }, { kind: 'final', assistantMessageIndex: 3 });
    await controller.onDeliver({ text: 'Corrected final.' }, { kind: 'final', assistantMessageIndex: 3 });

    controller.markFullyComplete();
    await controller.onIdle();

    expect(lastTerminalMarkdown()).toBe('Corrected final.');
  });

  it('keeps identical finals with different delivery identities as two messages', async () => {
    const controller = new StreamingCardController(deps);

    await controller.onDeliver({ text: 'Same words.' }, { kind: 'final', assistantMessageIndex: 3 });
    await controller.onDeliver({ text: 'Same words.' }, { kind: 'final', assistantMessageIndex: 4 });

    controller.markFullyComplete();
    await controller.onIdle();

    expect(lastTerminalMarkdown()).toBe('Same words.\n\nSame words.');
  });

  it('keeps the post-tool partial active when assistant-message start arrives late', async () => {
    const controller = new StreamingCardController(deps);

    await controller.onPartialReply({ text: 'Before the tool.' });
    await controller.onToolStart({ name: 'search', phase: 'start' });
    await controller.onPartialReply({ text: 'After the tool.' });
    controller.onAssistantMessageStart();
    await controller.onDeliver({ text: 'After the tool.' }, { kind: 'final' });

    controller.markFullyComplete();
    await controller.onIdle();

    expect(lastTerminalMarkdown()).toBe('Before the tool.\n\nAfter the tool.');
  });

  it('preserves callback start order when the runtime does not await each callback', async () => {
    const controller = new StreamingCardController(deps);

    const before = controller.onPartialReply({ text: 'Async before the tool.' });
    const tool = controller.onToolStart({ name: 'search', phase: 'start' });
    const after = controller.onPartialReply({ text: 'Async after the tool.' });
    controller.onAssistantMessageStart();
    const final = controller.onDeliver({ text: 'Async after the tool.' }, { kind: 'final' });

    await Promise.all([before, tool, after, final]);
    controller.markFullyComplete();
    await controller.onIdle();

    expect(lastTerminalMarkdown()).toBe('Async before the tool.\n\nAsync after the tool.');
  });

  it('keeps the same result when the post-tool message-start acknowledgement arrives after final delivery', async () => {
    const controller = new StreamingCardController(deps);

    await controller.onPartialReply({ text: 'Before the tool.' });
    await controller.onToolStart({ name: 'search', phase: 'start' });
    await controller.onPartialReply({ text: 'After the tool.' });
    await controller.onDeliver({ text: 'After the tool.' }, { kind: 'final' });
    controller.onAssistantMessageStart();

    controller.markFullyComplete();
    await controller.onIdle();

    expect(lastTerminalMarkdown()).toBe('Before the tool.\n\nAfter the tool.');
  });

  it('does not multiply post-tool boundaries for repeated lifecycle callbacks', async () => {
    const controller = new StreamingCardController(deps);

    await controller.onPartialReply({ text: 'Before the tool.' });
    await controller.onToolStart({ name: 'search', phase: 'start' });
    await controller.onToolStart({ name: 'search', phase: 'update' });
    await controller.onToolStart({ name: 'search', phase: 'end' });
    await controller.onToolStart({ name: 'search', phase: 'start' });
    controller.onAssistantMessageStart();
    await controller.onPartialReply({ text: 'After the tool.' });
    await controller.onDeliver({ text: 'After the tool.' }, { kind: 'final' });

    controller.markFullyComplete();
    await controller.onIdle();

    expect(lastTerminalMarkdown()).toBe('Before the tool.\n\nAfter the tool.');
  });

  it('uses cumulative text when text and delta are both supplied', async () => {
    const controller = new StreamingCardController(deps);

    await controller.onPartialReply({ text: 'First', delta: 'First' });
    await controller.onPartialReply({ text: 'First second', delta: ' second' });
    await controller.onPartialReply({ text: 'Corrected', delta: '', replace: true });

    expect(cardKitMocks.streamCardContent.mock.calls.map((call) => call[0].content)).toEqual([
      'First',
      'First second',
      'Corrected',
    ]);

    controller.markFullyComplete();
    await controller.onIdle();

    expect(lastTerminalMarkdown()).toBe('Corrected');
  });

  it('supports delta-only append and replace updates for newer runtimes', async () => {
    const controller = new StreamingCardController(deps);

    await controller.onPartialReply({ delta: 'First' });
    await controller.onPartialReply({ delta: ' second' });
    await controller.onPartialReply({ delta: 'Replacement', replace: true });

    controller.markFullyComplete();
    await controller.onIdle();

    expect(lastTerminalMarkdown()).toBe('Replacement');
  });
});
