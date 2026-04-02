/**
 * Tests for tool registration ticket bridging.
 *
 * When a tool runs outside the Feishu inbound message pipeline (e.g. in a spawned
 * subagent gateway run), the Feishu plugin previously had no LarkTicket set in
 * AsyncLocalStorage, causing auth flows to degrade and skip sending cards.
 *
 * The helpers.registerTool wrapper should synthesize a ticket from the
 * OpenClawPluginToolContext and execute the tool under withTicket().
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetTicket = vi.fn();
const mockWithTicket = vi.fn();
const mockGetMessageFeishu = vi.fn();
const mockWithAuthResumeTarget = vi.fn();

vi.mock('../src/core/lark-ticket', () => ({
  getTicket: (...args: unknown[]) => mockGetTicket(...args),
  withTicket: (...args: unknown[]) => mockWithTicket(...args),
}));

vi.mock('../src/messaging/shared/message-lookup', () => ({
  getMessageFeishu: (...args: unknown[]) => mockGetMessageFeishu(...args),
}));

vi.mock('../src/core/auth-resume-target', () => ({
  withAuthResumeTarget: (...args: unknown[]) => mockWithAuthResumeTarget(...args),
  getAuthResumeTarget: vi.fn(),
}));

vi.mock('../src/core/tools-config', () => ({
  shouldRegisterTool: () => true,
}));

vi.mock('../src/core/lark-client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getResolvedConfig: (cfg: unknown) => cfg,
  };
});

// Import under test (after mocks)
import { registerTool } from '../src/tools/helpers';

describe('tools/helpers registerTool ticket wrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithAuthResumeTarget.mockImplementation(async (_target: unknown, fn: () => unknown) => await fn());
  });
  it('wraps tool execute with a synthetic ticket when ticket is missing', async () => {
    mockGetTicket.mockReturnValue(undefined);
    mockWithTicket.mockImplementation(async (_ticket: unknown, fn: () => unknown) => await fn());

    const originalExecute = vi.fn().mockResolvedValue({ ok: true });

    const registrations: Array<{ tool: any; opts: any }> = [];
    const api = {
      config: {},
      logger: { debug: vi.fn() },
      registerTool: (tool: any, opts: any) => {
        registrations.push({ tool, opts });
      },
    } as any;

    registerTool(api, { name: 'feishu_test', execute: originalExecute } as any);

    expect(registrations).toHaveLength(1);
    expect(typeof registrations[0]!.tool).toBe('function');
    expect(registrations[0]!.opts).toEqual({ name: 'feishu_test' });

    const wrappedTool = registrations[0]!.tool({
      deliveryContext: {
        channel: 'feishu',
        to: 'chat:oc_123',
        accountId: 'default',
        threadId: 'th_1',
      },
      agentId: 'agent_sub',
      sessionKey: 'session_sub',
      sessionId: 'session-1',
      requesterSenderId: 'ou_owner',
      messageChannel: 'feishu',
      agentAccountId: 'default',
    });

    await wrappedTool.execute('call-1', { foo: 'bar' });

    expect(mockWithAuthResumeTarget).toHaveBeenCalledTimes(1);
    expect(mockWithAuthResumeTarget.mock.calls[0]![0]).toMatchObject({
      agentId: 'agent_sub',
      sessionKey: 'session_sub',
      accountId: 'default',
      chatId: 'oc_123',
      chatType: 'group',
      threadId: 'th_1',
    });

    expect(mockWithTicket).toHaveBeenCalledTimes(1);
    expect(mockWithTicket.mock.calls[0]![0]).toMatchObject({
      messageId: 'session:session-1',
      chatId: 'oc_123',
      accountId: 'default',
      senderOpenId: 'ou_owner',
      chatType: 'group',
      threadId: 'th_1',
    });
    expect(originalExecute).toHaveBeenCalledWith('call-1', { foo: 'bar' });
  });

  it('backfills senderOpenId from replyTo message when missing', async () => {
    mockGetTicket.mockReturnValue(undefined);
    mockWithTicket.mockImplementation(async (_ticket: unknown, fn: () => unknown) => await fn());
    mockGetMessageFeishu.mockResolvedValue({
      senderId: 'ou_backfilled',
      chatId: 'oc_123',
      threadId: 'omt_1',
    });

    const originalExecute = vi.fn().mockResolvedValue({ ok: true });

    const registrations: Array<{ tool: any; opts: any }> = [];
    const api = {
      config: { any: 'cfg' },
      logger: { debug: vi.fn() },
      registerTool: (tool: any, opts: any) => {
        registrations.push({ tool, opts });
      },
    } as any;

    registerTool(api, { name: 'feishu_test_backfill', execute: originalExecute } as any);

    const wrappedTool = registrations[0]!.tool({
      deliveryContext: {
        channel: 'feishu',
        to: 'chat:oc_123#__feishu_reply_to=om_abc&__feishu_thread_id=omt_1',
        accountId: 'default',
      },
      sessionId: 'session-ignored',
      requesterSenderId: '',
      messageChannel: 'feishu',
      agentAccountId: 'default',
    });

    await wrappedTool.execute('call-3', { a: 1 });

    expect(mockGetMessageFeishu).toHaveBeenCalledTimes(1);
    expect(mockGetMessageFeishu.mock.calls[0]![0]).toMatchObject({
      messageId: 'om_abc',
      accountId: 'default',
    });

    expect(mockWithTicket).toHaveBeenCalledTimes(1);
    expect(mockWithTicket.mock.calls[0]![0]).toMatchObject({
      messageId: 'om_abc',
      chatId: 'oc_123',
      accountId: 'default',
      senderOpenId: 'ou_backfilled',
      chatType: 'group',
      threadId: 'omt_1',
    });
    expect(originalExecute).toHaveBeenCalledWith('call-3', { a: 1 });
  });

  it('does not synthesize a ticket when deliveryContext.to is missing', async () => {
    mockGetTicket.mockReturnValue(undefined);
    mockWithTicket.mockImplementation(async (_ticket: unknown, fn: () => unknown) => await fn());

    const originalExecute = vi.fn().mockResolvedValue({ ok: true });

    const registrations: Array<{ tool: any; opts: any }> = [];
    const api = {
      config: {},
      logger: { debug: vi.fn() },
      registerTool: (tool: any, opts: any) => {
        registrations.push({ tool, opts });
      },
    } as any;

    registerTool(api, { name: 'feishu_test_missing_to', execute: originalExecute } as any);

    const wrappedTool = registrations[0]!.tool({
      deliveryContext: { channel: 'feishu', accountId: 'default' },
      sessionId: 'session-4',
      requesterSenderId: 'ou_owner',
      messageChannel: 'feishu',
      agentAccountId: 'default',
    });

    await wrappedTool.execute('call-4', { b: 2 });

    expect(mockWithAuthResumeTarget).not.toHaveBeenCalled();
    expect(mockWithTicket).not.toHaveBeenCalled();
    expect(originalExecute).toHaveBeenCalledWith('call-4', { b: 2 });
  });

  it('wraps tools returned from a factory array', async () => {
    mockGetTicket.mockReturnValue(undefined);
    mockWithTicket.mockImplementation(async (_ticket: unknown, fn: () => unknown) => await fn());

    const exec1 = vi.fn().mockResolvedValue({ ok: 1 });
    const exec2 = vi.fn().mockResolvedValue({ ok: 2 });

    function toolFactory(_ctx: any) {
      return [
        { name: 'feishu_test_factory_1', execute: exec1 },
        { name: 'feishu_test_factory_2', execute: exec2 },
      ];
    }

    const registrations: Array<{ tool: any; opts: any }> = [];
    const api = {
      config: {},
      logger: { debug: vi.fn() },
      registerTool: (tool: any, opts: any) => {
        registrations.push({ tool, opts });
      },
    } as any;

    registerTool(api, toolFactory as any);

    const wrappedTools = registrations[0]!.tool({
      deliveryContext: { channel: 'feishu', to: 'chat:oc_123', accountId: 'default' },
      sessionId: 'session-5',
      requesterSenderId: 'ou_owner',
      messageChannel: 'feishu',
      agentAccountId: 'default',
    });

    expect(Array.isArray(wrappedTools)).toBe(true);

    await wrappedTools[0].execute('call-5', { x: 1 });
    await wrappedTools[1].execute('call-6', { y: 2 });

    expect(mockWithTicket).toHaveBeenCalledTimes(2);
    expect(exec1).toHaveBeenCalledWith('call-5', { x: 1 });
    expect(exec2).toHaveBeenCalledWith('call-6', { y: 2 });
  });

  it('does not wrap when ticket already exists', async () => {
    mockGetTicket.mockReturnValue({ messageId: 'om_existing' });

    const originalExecute = vi.fn().mockResolvedValue({ ok: true });

    const registrations: Array<{ tool: any; opts: any }> = [];
    const api = {
      config: {},
      logger: { debug: vi.fn() },
      registerTool: (tool: any, opts: any) => {
        registrations.push({ tool, opts });
      },
    } as any;

    registerTool(api, { name: 'feishu_test2', execute: originalExecute } as any);

    const wrappedTool = registrations[0]!.tool({
      deliveryContext: {
        channel: 'feishu',
        to: 'chat:oc_123',
        accountId: 'default',
      },
      sessionId: 'session-2',
      requesterSenderId: 'ou_owner',
      messageChannel: 'feishu',
      agentAccountId: 'default',
    });

    await wrappedTool.execute('call-2', { baz: 1 });

    expect(mockWithTicket).not.toHaveBeenCalled();
    expect(originalExecute).toHaveBeenCalledWith('call-2', { baz: 1 });
  });
});
