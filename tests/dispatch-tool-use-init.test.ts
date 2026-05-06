import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  buildDispatchContextMock,
  buildMessageBodyMock,
  buildEnvelopeWithHistoryMock,
  buildBodyForAgentMock,
  buildInboundPayloadMock,
  resolveToolUseDisplayConfigMock,
  startToolUseTraceRunMock,
  clearToolUseTraceRunMock,
  createFeishuReplyDispatcherMock,
  dispatchReplyFromConfigMock,
} = vi.hoisted(() => ({
  buildDispatchContextMock: vi.fn(),
  buildMessageBodyMock: vi.fn(() => 'message-body'),
  buildEnvelopeWithHistoryMock: vi.fn(() => ({ combinedBody: 'combined-body', historyKey: undefined })),
  buildBodyForAgentMock: vi.fn(() => 'body-for-agent'),
  buildInboundPayloadMock: vi.fn(() => ({ kind: 'ctx-payload' })),
  resolveToolUseDisplayConfigMock: vi.fn(),
  startToolUseTraceRunMock: vi.fn(),
  clearToolUseTraceRunMock: vi.fn(),
  createFeishuReplyDispatcherMock: vi.fn(),
  dispatchReplyFromConfigMock: vi.fn(),
}));

vi.mock('../src/messaging/inbound/dispatch-context', () => ({
  buildDispatchContext: buildDispatchContextMock,
  resolveThreadSessionKey: vi.fn(),
}));

vi.mock('../src/messaging/inbound/dispatch-builders', () => ({
  buildMessageBody: buildMessageBodyMock,
  buildEnvelopeWithHistory: buildEnvelopeWithHistoryMock,
  buildBodyForAgent: buildBodyForAgentMock,
  buildInboundPayload: buildInboundPayloadMock,
}));

vi.mock('../src/card/tool-use-config', () => ({
  resolveToolUseDisplayConfig: resolveToolUseDisplayConfigMock,
}));

vi.mock('../src/card/tool-use-trace-store', () => ({
  startToolUseTraceRun: startToolUseTraceRunMock,
  clearToolUseTraceRun: clearToolUseTraceRunMock,
}));

vi.mock('../src/card/reply-dispatcher', () => ({
  createFeishuReplyDispatcher: createFeishuReplyDispatcherMock,
}));

vi.mock('../src/channel/chat-queue', () => ({
  buildQueueKey: vi.fn(() => 'queue-key'),
  registerActiveDispatcher: vi.fn(),
  threadScopedKey: vi.fn(() => 'thread-key'),
  unregisterActiveDispatcher: vi.fn(),
}));

vi.mock('../src/messaging/inbound/dispatch-commands', () => ({
  dispatchPermissionNotification: vi.fn(),
  dispatchSystemCommand: vi.fn(),
}));

vi.mock('../src/core/chat-info-cache', () => ({
  isThreadCapableGroup: vi.fn(),
  injectLarkClient: vi.fn(),
}));

vi.mock('../src/core/targets', () => ({
  encodeFeishuRouteTarget: vi.fn(),
}));

vi.mock('../src/messaging/outbound/send', () => ({
  buildI18nMarkdownCard: vi.fn(),
  sendCardFeishu: vi.fn(),
  sendMessageFeishu: vi.fn(),
}));

vi.mock('../src/commands/doctor', () => ({
  runFeishuDoctorI18n: vi.fn(),
}));

vi.mock('../src/commands/auth', () => ({
  runFeishuAuthI18n: vi.fn(),
}));

vi.mock('../src/commands/index', () => ({
  getFeishuHelpI18n: vi.fn(),
  runFeishuStartI18n: vi.fn(),
}));

vi.mock('../src/messaging/inbound/mention', () => ({
  mentionedBot: vi.fn(() => false),
}));

vi.mock('../src/messaging/inbound/gate', () => ({
  resolveRespondToMentionAll: vi.fn(() => false),
}));

vi.mock('../src/channel/abort-detect', () => ({
  isLikelyAbortText: vi.fn(() => false),
}));

vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../src/core/lark-ticket', () => ({
  ticketElapsed: () => 1,
}));

import { dispatchToAgent } from '../src/messaging/inbound/dispatch';

function createDispatchContext() {
  return {
    ctx: {
      chatId: 'chat-1',
      messageId: 'om_msg_1',
      senderId: 'ou_sender_1',
      senderName: 'Alice',
      content: 'hello',
      chatType: 'p2p',
      mentions: [],
      resources: [],
      contentType: 'text',
      mentionAll: false,
      rawMessage: {},
      rawSender: {},
    },
    accountScopedCfg: {},
    account: {
      accountId: 'default',
      enabled: true,
      brand: 'feishu',
      config: {},
    },
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    },
    log: vi.fn(),
    error: vi.fn(),
    core: {
      channel: {
        commands: {
          isControlCommandMessage: vi.fn(() => false),
        },
        reply: {
          dispatchReplyFromConfig: dispatchReplyFromConfigMock,
        },
      },
    },
    isGroup: false,
    isThread: false,
    feishuFrom: 'feishu:ou_sender_1',
    feishuTo: 'user:ou_sender_1',
    envelopeFrom: 'ou_sender_1',
    envelopeOptions: {},
    route: {
      sessionKey: 'session-1',
      agentId: 'default',
      channel: 'feishu',
      accountId: 'default',
    },
    threadSessionKey: undefined,
    commandAuthorized: true,
  };
}

function createDispatcher() {
  return {
    waitForIdle: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  buildDispatchContextMock.mockReturnValue(createDispatchContext());
  resolveToolUseDisplayConfigMock.mockReturnValue({ showToolUse: true, showToolResultDetail: false, showFullPaths: false });
  createFeishuReplyDispatcherMock.mockReturnValue({
    dispatcher: createDispatcher(),
    replyOptions: {},
    markDispatchIdle: vi.fn(),
    markFullyComplete: vi.fn(),
    abortCard: vi.fn(),
  });
  dispatchReplyFromConfigMock.mockResolvedValue({
    queuedFinal: false,
    counts: { final: 0 },
  });
});

describe('dispatchToAgent tool_use trace initialization', () => {
  it('starts the trace run exactly once when tool_use is enabled', async () => {
    const dc = createDispatchContext();

    await dispatchToAgent({
      ctx: dc.ctx as never,
      mediaPayload: {},
      account: dc.account as never,
      accountScopedCfg: {} as never,
      historyLimit: 0,
    });

    expect(startToolUseTraceRunMock).toHaveBeenCalledTimes(1);
    expect(startToolUseTraceRunMock).toHaveBeenCalledWith('session-1');
    expect(clearToolUseTraceRunMock).not.toHaveBeenCalled();
  });

  it('clears the trace run without initializing it when tool_use is disabled', async () => {
    const dc = createDispatchContext();

    resolveToolUseDisplayConfigMock.mockReturnValueOnce({
      showToolUse: false,
      showToolResultDetail: false,
      showFullPaths: false,
    });

    await dispatchToAgent({
      ctx: dc.ctx as never,
      mediaPayload: {},
      account: dc.account as never,
      accountScopedCfg: {} as never,
      historyLimit: 0,
    });

    expect(startToolUseTraceRunMock).not.toHaveBeenCalled();
    expect(clearToolUseTraceRunMock).toHaveBeenCalledTimes(1);
    expect(clearToolUseTraceRunMock).toHaveBeenCalledWith('session-1');
  });

  it('forwards extra inbound fields into the finalized payload', async () => {
    const dc = createDispatchContext();

    await dispatchToAgent({
      ctx: dc.ctx as never,
      mediaPayload: {},
      extraInboundFields: {
        SyntheticEventType: 'vc.bot.meeting_invited_v1',
        VcMeetingNo: '123456789',
      },
      account: dc.account as never,
      accountScopedCfg: {} as never,
      historyLimit: 0,
    });

    expect(buildInboundPayloadMock).toHaveBeenCalledTimes(1);
    const buildInboundPayloadArgs =
      buildInboundPayloadMock.mock.calls[0] as unknown as [unknown, { extraFields?: unknown }];
    expect(buildInboundPayloadArgs[1]).toMatchObject({
      extraFields: {
        SyntheticEventType: 'vc.bot.meeting_invited_v1',
        VcMeetingNo: '123456789',
      },
    });
  });

});
