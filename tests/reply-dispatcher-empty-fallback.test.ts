import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import { updateCardKitCard } from '../src/card/cardkit';
import { StreamingCardController } from '../src/card/streaming-card-controller';

vi.mock('openclaw/plugin-sdk/reply-runtime', () => ({ SILENT_REPLY_TOKEN: '__silent__' }));
vi.mock('../src/core/api-error', () => ({
  extractLarkApiCode: () => undefined,
}));
vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../src/core/lark-client', () => ({ LarkClient: {} }));
vi.mock('../src/core/shutdown-hooks', () => ({ registerShutdownHook: () => () => {} }));
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
vi.mock('../src/messaging/outbound/send', () => ({
  sendCardFeishu: vi.fn(),
  updateCardFeishu: vi.fn(),
}));
vi.mock('../src/card/cardkit', () => ({
  createCardEntity: vi.fn(async () => 'card_1'),
  sendCardByCardId: vi.fn(async () => ({ messageId: 'om_1' })),
  setCardStreamingMode: vi.fn(async () => {}),
  streamCardContent: vi.fn(async () => {}),
  updateCardKitCard: vi.fn(async () => {}),
}));

describe('StreamingCardController empty reply fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the fallback when completion has no completed or accumulated text', async () => {
    const controller = new StreamingCardController({
      cfg: {} as ClawdbotConfig,
      sessionKey: 'agent:main:feishu:direct:test-empty-reply',
      accountId: undefined,
      chatId: 'oc_test',
      replyToMessageId: 'om_source',
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
    });

    await controller.ensureCardCreated();
    controller.markFullyComplete();
    await controller.onIdle();

    expect(updateCardKitCard).toHaveBeenCalledOnce();
    const renderedCard = vi.mocked(updateCardKitCard).mock.calls[0]?.[0].card;
    expect(JSON.stringify(renderedCard)).toContain('(no reply)');
  });
});
