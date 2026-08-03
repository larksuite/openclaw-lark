import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClawdbotConfig, OpenClawConfig, RuntimeEnv } from 'openclaw/plugin-sdk';
import { __testing as sessionBindingTesting, getSessionBindingService } from 'openclaw/plugin-sdk/conversation-runtime';
import type { LarkAccount } from '../src/core/types';
import { LarkClient } from '../src/core/lark-client';
import { __testing as threadBindingTesting, createFeishuThreadBindingManager } from '../src/channel/thread-bindings';
import { buildDispatchContext } from '../src/messaging/inbound/dispatch-context';
import type { MessageContext } from '../src/messaging/types';

const TARGET_SESSION_KEY = 'agent:main:acp:codex:thread-binding-test';

function createConfig(): OpenClawConfig {
  return {} as OpenClawConfig;
}

function createAccount(): LarkAccount {
  return {
    accountId: 'default',
    enabled: true,
    configured: true,
    appId: 'cli_test',
    appSecret: 'test-secret',
    brand: 'feishu',
    config: {},
  } as LarkAccount;
}

function createMessageContext(overrides: Partial<MessageContext> = {}): MessageContext {
  return {
    chatId: 'oc_test',
    messageId: 'om_test',
    senderId: 'ou_test',
    chatType: 'p2p',
    content: 'test',
    contentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    rawMessage: {} as MessageContext['rawMessage'],
    rawSender: {} as MessageContext['rawSender'],
    ...overrides,
  };
}

afterEach(() => {
  threadBindingTesting.resetFeishuThreadBindingsForTests();
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
});

describe('飞书 ACP 会话绑定', () => {
  it('注册规范化后的默认账号适配器并解析当前会话绑定', async () => {
    const manager = createFeishuThreadBindingManager({
      accountId: 'DEFAULT',
      cfg: createConfig(),
    });
    const bindings = getSessionBindingService();

    expect(bindings.getCapabilities({ channel: 'feishu', accountId: 'default' })).toEqual({
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ['current'],
    });

    await bindings.bind({
      targetSessionKey: TARGET_SESSION_KEY,
      targetKind: 'session',
      placement: 'current',
      conversation: {
        channel: 'feishu',
        accountId: 'default',
        conversationId: 'omt_test_thread',
        parentConversationId: 'chat:oc_test',
      },
    });

    expect(
      bindings.resolveByConversation({
        channel: 'feishu',
        accountId: 'DEFAULT',
        conversationId: 'omt_test_thread',
        parentConversationId: 'chat:oc_test',
      }),
    ).toMatchObject({
      targetSessionKey: TARGET_SESSION_KEY,
      targetKind: 'session',
      conversation: {
        channel: 'feishu',
        accountId: 'default',
        conversationId: 'omt_test_thread',
      },
    });

    manager.stop();
    expect(bindings.getCapabilities({ channel: 'feishu', accountId: 'default' }).adapterAvailable).toBe(false);
  });

  it('将入站原生线程路由到已绑定的 ACP session', async () => {
    const enqueueSystemEvent = vi.fn();
    LarkClient.setRuntime({
      channel: {
        reply: {
          resolveEnvelopeFormatOptions: vi.fn(() => ({})),
        },
        routing: {
          resolveAgentRoute: vi.fn(() => ({
            agentId: 'main',
            channel: 'feishu',
            accountId: 'default',
            sessionKey: 'agent:main:feishu:group:oc_test',
            mainSessionKey: 'agent:main:main',
            lastRoutePolicy: 'session',
            matchedBy: 'default',
          })),
        },
      },
      system: { enqueueSystemEvent },
    } as unknown as Parameters<typeof LarkClient.setRuntime>[0]);

    createFeishuThreadBindingManager({ accountId: 'default', cfg: createConfig() });
    await getSessionBindingService().bind({
      targetSessionKey: TARGET_SESSION_KEY,
      targetKind: 'session',
      placement: 'current',
      conversation: {
        channel: 'feishu',
        accountId: 'default',
        conversationId: 'omt_test_thread',
        parentConversationId: 'chat:oc_test',
      },
    });

    const dispatchContext = buildDispatchContext({
      ctx: createMessageContext({
        chatType: 'group',
        threadId: 'omt_test_thread',
      }),
      account: createAccount(),
      accountScopedCfg: createConfig() as ClawdbotConfig,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      } as unknown as RuntimeEnv,
    });

    expect(dispatchContext.route).toMatchObject({
      sessionKey: TARGET_SESSION_KEY,
      matchedBy: 'binding.channel',
    });
    expect(dispatchContext.runtimeBindingId).toBe('default:omt_test_thread');
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ sessionKey: TARGET_SESSION_KEY }),
    );
  });

  it('使用 ACP 规范化 user 会话 ID 路由入站私聊', async () => {
    LarkClient.setRuntime({
      channel: {
        reply: {
          resolveEnvelopeFormatOptions: vi.fn(() => ({})),
        },
        routing: {
          resolveAgentRoute: vi.fn(() => ({
            agentId: 'main',
            channel: 'feishu',
            accountId: 'default',
            sessionKey: 'agent:main:feishu:direct:ou_test',
            mainSessionKey: 'agent:main:main',
            lastRoutePolicy: 'session',
            matchedBy: 'default',
          })),
        },
      },
      system: { enqueueSystemEvent: vi.fn() },
    } as unknown as Parameters<typeof LarkClient.setRuntime>[0]);

    createFeishuThreadBindingManager({ accountId: 'default', cfg: createConfig() });
    await getSessionBindingService().bind({
      targetSessionKey: TARGET_SESSION_KEY,
      targetKind: 'session',
      placement: 'current',
      conversation: {
        channel: 'feishu',
        accountId: 'default',
        conversationId: 'user:ou_test',
      },
    });

    const dispatchContext = buildDispatchContext({
      ctx: createMessageContext(),
      account: createAccount(),
      accountScopedCfg: createConfig() as ClawdbotConfig,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      } as unknown as RuntimeEnv,
    });

    expect(dispatchContext.route).toMatchObject({
      sessionKey: TARGET_SESSION_KEY,
      matchedBy: 'binding.channel',
    });
  });
});
