import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  dispatchReplyWithBufferedBlockDispatcherMock,
  sendMessageFeishuMock,
  isThreadCapableGroupMock,
  resolveAgentRouteMock,
  enqueueSystemEventMock,
  resolveEnvelopeFormatOptionsMock,
} = vi.hoisted(() => ({
  dispatchReplyWithBufferedBlockDispatcherMock: vi.fn(),
  sendMessageFeishuMock: vi.fn().mockResolvedValue({ messageId: 'om_sent_1', chatId: 'oc_sent_1' }),
  isThreadCapableGroupMock: vi.fn().mockResolvedValue(false),
  resolveAgentRouteMock: vi.fn(() => ({ agentId: 'main', sessionKey: 'agent:main:feishu:direct:ou_inviter_1' })),
  enqueueSystemEventMock: vi.fn(),
  resolveEnvelopeFormatOptionsMock: vi.fn(() => ({})),
}))

vi.mock('../src/core/lark-client', () => ({
  LarkClient: {
    runtime: {
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: dispatchReplyWithBufferedBlockDispatcherMock,
          finalizeInboundContext: vi.fn((ctx: unknown) => ctx),
          resolveEnvelopeFormatOptions: resolveEnvelopeFormatOptionsMock,
        },
        commands: {
          isControlCommandMessage: vi.fn(() => false),
        },
        routing: {
          resolveAgentRoute: resolveAgentRouteMock,
        },
      },
      system: {
        enqueueSystemEvent: enqueueSystemEventMock,
      },
    },
  },
}))

vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

vi.mock('../src/core/lark-ticket', () => ({
  ticketElapsed: () => 1,
}))

vi.mock('../src/core/chat-info-cache', () => ({
  isThreadCapableGroup: isThreadCapableGroupMock,
}))

vi.mock('../src/channel/chat-queue', () => ({
  buildQueueKey: vi.fn(() => 'queue-1'),
  registerActiveDispatcher: vi.fn(),
  unregisterActiveDispatcher: vi.fn(),
  threadScopedKey: vi.fn(() => 'thread-key'),
}))

vi.mock('../src/card/tool-use-config', () => ({
  resolveToolUseDisplayConfig: vi.fn(() => ({ showToolUse: false })),
}))

vi.mock('../src/card/tool-use-trace-store', () => ({
  clearToolUseTraceRun: vi.fn(),
  startToolUseTraceRun: vi.fn(),
}))

vi.mock('../src/channel/abort-detect', () => ({
  isLikelyAbortText: vi.fn(() => false),
}))

vi.mock('../src/messaging/outbound/deliver', () => ({
  sendCommentReplyLark: vi.fn(),
}))

vi.mock('../src/messaging/outbound/send', () => ({
  buildI18nMarkdownCard: vi.fn(),
  sendCardFeishu: vi.fn(),
  sendMessageFeishu: sendMessageFeishuMock,
}))

vi.mock('../src/messaging/inbound/dispatch-commands', () => ({
  dispatchPermissionNotification: vi.fn(),
  dispatchSystemCommand: vi.fn(),
}))

vi.mock('../src/messaging/inbound/dispatch-builders', () => ({
  buildMessageBody: vi.fn(() => 'body'),
  buildEnvelopeWithHistory: vi.fn(() => ({ combinedBody: 'body', historyKey: undefined })),
  buildBodyForAgent: vi.fn(() => 'body-for-agent'),
  buildInboundPayload: vi.fn(() => ({ inbound: true })),
}))

import { dispatchToAgent } from '../src/messaging/inbound/dispatch'
import { SYNTHETIC_VC_CHAT_ID } from '../src/core/synthetic-target'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('dispatchToAgent synthetic VC notification', () => {
  it('delivers the final VC synthetic reply explicitly to the inviter', async () => {
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(async (params: {
      dispatcherOptions: {
        deliver: (
          payload: { text?: string },
          info: { kind: 'tool' | 'final' | 'block' },
        ) => Promise<void>
      }
    }) => {
      await params.dispatcherOptions.deliver({ text: 'Tool step' }, { kind: 'tool' })
      await params.dispatcherOptions.deliver({ text: '已成功入会' }, { kind: 'final' })
    })

    await dispatchToAgent({
      ctx: {
        chatId: SYNTHETIC_VC_CHAT_ID,
        messageId: 'vc-invited:879900967',
        senderId: 'ou_inviter_1',
        senderName: 'Alice',
        chatType: 'p2p',
        content: 'Join the meeting with meeting number 879900967.',
        contentType: 'text',
        resources: [],
        mentions: [],
        mentionAll: false,
      } as never,
      mediaPayload: {},
      account: { accountId: 'default', config: {} } as never,
      accountScopedCfg: {} as never,
      historyLimit: 0,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as never,
    })

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1)
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ou_inviter_1',
        text: '已成功入会',
        accountId: 'default',
      }),
    )
  })
})
