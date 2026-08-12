import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendMessageFeishu: vi.fn(),
  setCardStreamingMode: vi.fn(),
  updateCardKitCard: vi.fn(),
}));

vi.mock('openclaw/plugin-sdk/agent-runtime', () => ({
  resolveDefaultAgentId: () => 'main',
}));
vi.mock('openclaw/plugin-sdk/reply-runtime', () => ({ SILENT_REPLY_TOKEN: 'NO_REPLY' }));
vi.mock('../src/core/api-error', () => ({
  extractLarkApiCode: (err: unknown) =>
    err && typeof err === 'object' && 'code' in err ? (err as { code: number }).code : undefined,
}));
vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../src/core/lark-client', () => ({ LarkClient: { runtime: null } }));
vi.mock('../src/core/shutdown-hooks', () => ({ registerShutdownHook: () => () => {} }));
vi.mock('../src/messaging/outbound/send', () => ({
  sendCardFeishu: vi.fn(),
  sendMessageFeishu: mocks.sendMessageFeishu,
  updateCardFeishu: vi.fn(),
}));
vi.mock('../src/card/cardkit', () => ({
  createCardEntity: vi.fn(),
  sendCardByCardId: vi.fn(),
  setCardStreamingMode: mocks.setCardStreamingMode,
  streamCardContent: vi.fn(),
  updateCardKitCard: mocks.updateCardKitCard,
}));
vi.mock('../src/card/flush-controller', () => ({
  FlushController: class {
    cancelPendingFlush() {}
    complete() {}
    waitForFlush() {
      return Promise.resolve();
    }
    setCardMessageReady() {}
    throttledUpdate() {
      return Promise.resolve();
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
vi.mock('../src/card/tool-use-trace-store', () => ({
  clearToolUseTraceRun: vi.fn(),
  getToolUseTraceSteps: () => [],
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

import { isCardElementLimitError } from '../src/card/card-error';
import { StreamingCardController } from '../src/card/streaming-card-controller';

const elementLimitError = {
  code: 300305,
  message: 'element exceeds the limit',
};

type ControllerInternals = {
  phase: 'streaming';
  cardKit: {
    cardKitCardId: string | null;
    originalCardKitCardId: string | null;
    cardKitSequence: number;
    cardMessageId: string | null;
  };
  text: {
    accumulatedText: string;
    completedText: string;
  };
  updateToolUseStatus: () => Promise<void>;
};

function createStreamingController(): StreamingCardController {
  const controller = new StreamingCardController({
    cfg: {} as never,
    agentId: 'main',
    sessionKey: 'agent:main:feishu:group:chat-1',
    accountId: 'default',
    chatId: 'chat-1',
    replyToMessageId: 'om_source',
    replyInThread: false,
    toolUseDisplay: {
      mode: 'on',
      showToolUse: true,
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
  });
  const internals = controller as unknown as ControllerInternals;
  internals.phase = 'streaming';
  Object.assign(internals.cardKit, {
    cardKitCardId: 'card-1',
    originalCardKitCardId: 'card-1',
    cardKitSequence: 0,
    cardMessageId: 'om_card',
  });
  Object.assign(internals.text, {
    accumulatedText: 'complete answer',
    completedText: 'complete answer',
  });
  controller.markFullyComplete();
  return controller;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setCardStreamingMode.mockResolvedValue(undefined);
  mocks.updateCardKitCard.mockResolvedValue(undefined);
  mocks.sendMessageFeishu.mockResolvedValue({ messageId: 'om_fallback' });
});

describe('isCardElementLimitError', () => {
  it('recognizes CardKit v2 code 300305', () => {
    expect(isCardElementLimitError(elementLimitError)).toBe(true);
  });

  it('recognizes legacy 230099/11310 element-limit errors', () => {
    expect(
      isCardElementLimitError({
        code: 230099,
        message: 'Failed to create card content, ext=ErrCode: 11310; ErrMsg: element exceeds the limit;',
      }),
    ).toBe(true);
  });
});

describe('streaming card element-limit recovery', () => {
  it('retries the final update with an answer-only compact card', async () => {
    mocks.updateCardKitCard.mockRejectedValueOnce(elementLimitError).mockResolvedValueOnce(undefined);
    const controller = createStreamingController();

    await controller.onIdle();

    expect(mocks.updateCardKitCard).toHaveBeenCalledTimes(2);
    const fullCard = mocks.updateCardKitCard.mock.calls[0][0].card as { body: { elements: Array<{ tag: string }> } };
    const compactCard = mocks.updateCardKitCard.mock.calls[1][0].card as {
      body: { elements: Array<{ tag: string }> };
    };
    expect(fullCard.body.elements.some((element) => element.tag === 'collapsible_panel')).toBe(true);
    expect(compactCard.body.elements.some((element) => element.tag === 'collapsible_panel')).toBe(false);
    expect(compactCard.body.elements).toContainEqual(expect.objectContaining({ content: 'complete answer' }));
    expect(mocks.sendMessageFeishu).not.toHaveBeenCalled();
  });

  it('does not hide unrelated final-card failures behind the fallback', async () => {
    mocks.updateCardKitCard.mockRejectedValueOnce(new Error('permission denied'));
    const controller = createStreamingController();

    await controller.onIdle();

    expect(mocks.updateCardKitCard).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessageFeishu).not.toHaveBeenCalled();
  });

  it('sends the complete answer as a normal message if the compact update also fails', async () => {
    mocks.updateCardKitCard
      .mockRejectedValueOnce(elementLimitError)
      .mockRejectedValueOnce(new Error('compact update failed'));
    const controller = createStreamingController();

    await controller.onIdle();

    expect(mocks.sendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'chat-1',
        text: 'complete answer',
        replyToMessageId: 'om_source',
      }),
    );
  });

  it('stops further streaming updates after a tool-status frame hits the element limit', async () => {
    mocks.updateCardKitCard.mockRejectedValueOnce(elementLimitError);
    const controller = createStreamingController();
    const internals = controller as unknown as ControllerInternals;

    await internals.updateToolUseStatus();

    expect(internals.cardKit.cardKitCardId).toBeNull();
    expect(internals.cardKit.originalCardKitCardId).toBe('card-1');
  });
});
