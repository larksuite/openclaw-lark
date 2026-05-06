import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleFeishuVcMeetingInvitedMock } = vi.hoisted(() => ({
  handleFeishuVcMeetingInvitedMock: vi.fn(),
}))

vi.mock('../src/messaging/inbound/handler', () => ({
  handleFeishuMessage: vi.fn(),
}))

vi.mock('../src/messaging/inbound/reaction-handler', () => ({
  handleFeishuReaction: vi.fn(),
  resolveReactionContext: vi.fn(),
}))

vi.mock('../src/messaging/inbound/comment-handler', () => ({
  handleFeishuCommentEvent: vi.fn(),
}))

vi.mock('../src/messaging/inbound/vc-meeting-invited-handler', () => ({
  handleFeishuVcMeetingInvited: handleFeishuVcMeetingInvitedMock,
}))

vi.mock('../src/messaging/inbound/comment-context', () => ({
  parseFeishuDriveCommentNoticeEventPayload: vi.fn(),
}))

vi.mock('../src/messaging/inbound/dedup', () => ({
  isMessageExpired: vi.fn(() => false),
}))

vi.mock('../src/core/lark-ticket', () => ({
  withTicket: vi.fn((_: unknown, fn: (...args: unknown[]) => unknown) => fn()),
}))

vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

vi.mock('../src/tools/auto-auth', () => ({
  handleCardAction: vi.fn(),
}))

vi.mock('../src/tools/ask-user-question', () => ({
  handleAskUserAction: vi.fn(),
}))

vi.mock('../src/channel/chat-queue', () => ({
  buildQueueKey: vi.fn(),
  enqueueFeishuChatTask: vi.fn(),
  getActiveDispatcher: vi.fn(),
  hasActiveTask: vi.fn(() => false),
}))

vi.mock('../src/channel/abort-detect', () => ({
  extractRawTextFromEvent: vi.fn(),
  isLikelyAbortText: vi.fn(() => false),
}))

vi.mock('../src/channel/interactive-dispatch', () => ({
  dispatchFeishuPluginInteractiveHandler: vi.fn(),
}))

import { handleVcMeetingInvitedEvent } from '../src/channel/event-handlers'

describe('handleVcMeetingInvitedEvent dedup', () => {
  const logMock = vi.fn()
  const errorMock = vi.fn()
  const tryRecordMock = vi.fn()

  const baseCtx = {
    cfg: {} as never,
    lark: {
      account: { appId: 'cli_test' },
      botOpenId: 'ou_ctx_bot',
    },
    accountId: 'default',
    chatHistories: new Map(),
    messageDedup: {
      tryRecord: tryRecordMock,
    },
    log: logMock,
    error: errorMock,
  } as never

  beforeEach(() => {
    vi.clearAllMocks()
    tryRecordMock.mockReturnValue(true)
  })

  it('prefers event_id as the dedup key when present', async () => {
    await handleVcMeetingInvitedEvent(baseCtx, {
      app_id: 'cli_test',
      event_id: 'evt_vc_123',
      meeting: { meeting_no: '123456789' },
      bot: { id: { open_id: 'ou_ctx_bot' } },
      inviter: { id: { open_id: 'ou_inviter_1' } },
      invite_time: '1712345678',
    })

    expect(errorMock).not.toHaveBeenCalled()
    expect(tryRecordMock).toHaveBeenCalledWith('vc-invited:by-event:evt_vc_123', 'default')
    expect(handleFeishuVcMeetingInvitedMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to meeting plus bot when event_id is absent', async () => {
    await handleVcMeetingInvitedEvent(baseCtx, {
      app_id: 'cli_test',
      meeting: { meeting_no: '123456789' },
      bot: { id: { open_id: 'ou_ctx_bot' } },
      inviter: { id: { open_id: 'ou_inviter_1' } },
      invite_time: '1712345678',
    })

    expect(errorMock).not.toHaveBeenCalled()
    expect(tryRecordMock).toHaveBeenCalledWith('vc-invited:by-meeting:123456789:ou_ctx_bot', 'default')
    expect(handleFeishuVcMeetingInvitedMock).toHaveBeenCalledTimes(1)
  })
})
