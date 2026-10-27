import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireSdk: vi.fn() }));
vi.mock('node:module', () => ({ createRequire: () => mocks.requireSdk }));
import { readFooterSessionMetricsFromSdk } from '../src/card/footer-session-metrics';

beforeEach(() => {
  mocks.requireSdk.mockReset();
});

describe('footer session metrics SDK lookup', () => {
  it('reads the current session row through the public SQLite accessor', () => {
    const resolveStorePath = vi.fn(() => '/sessions/agent-account.sqlite');
    const getSessionEntry = vi.fn(() => ({
      inputTokens: 120,
      outputTokens: 35,
      cacheRead: 24,
      cacheWrite: 4,
      totalTokens: 155,
      totalTokensFresh: true,
      contextTokens: 2048,
      model: 'test-model',
    }));
    mocks.requireSdk.mockReturnValue({ resolveStorePath, getSessionEntry });

    expect(
      readFooterSessionMetricsFromSdk({
        store: 'sessions/{agentId}.sqlite',
        candidates: [{ sessionKey: 'agent:account:feishu:dm:user', agentId: 'account' }],
      }),
    ).toEqual({
      supported: true,
      matchedSessionKey: 'agent:account:feishu:dm:user',
      storePath: '/sessions/agent-account.sqlite',
      metrics: {
        inputTokens: 120,
        outputTokens: 35,
        cacheRead: 24,
        cacheWrite: 4,
        totalTokens: 155,
        totalTokensFresh: true,
        contextTokens: 2048,
        model: 'test-model',
      },
    });
    expect(resolveStorePath).toHaveBeenCalledWith('sessions/{agentId}.sqlite', { agentId: 'account' });
    expect(getSessionEntry).toHaveBeenCalledWith({
      storePath: '/sessions/agent-account.sqlite',
      sessionKey: 'agent:account:feishu:dm:user',
      agentId: 'account',
      readConsistency: 'latest',
    });
  });

  it('checks candidate entries against their own agent-specific stores', () => {
    const resolveStorePath = vi.fn(
      (_store: string | undefined, options: { agentId?: string }) => `/sessions/${options.agentId}.sqlite`,
    );
    const getSessionEntry = vi.fn(({ agentId }: { agentId: string }) =>
      agentId === 'default' ? { inputTokens: 9 } : undefined,
    );
    mocks.requireSdk.mockReturnValue({ resolveStorePath, getSessionEntry });

    const result = readFooterSessionMetricsFromSdk({
      candidates: [
        { sessionKey: 'agent:account:feishu:dm:user', agentId: 'account' },
        { sessionKey: 'agent:default:feishu:dm:user', agentId: 'default' },
      ],
    });

    expect(result).toMatchObject({
      supported: true,
      matchedSessionKey: 'agent:default:feishu:dm:user',
      storePath: '/sessions/default.sqlite',
      metrics: { inputTokens: 9 },
    });
    expect(getSessionEntry).toHaveBeenNthCalledWith(1, {
      storePath: '/sessions/account.sqlite',
      sessionKey: 'agent:account:feishu:dm:user',
      agentId: 'account',
      readConsistency: 'latest',
    });
    expect(getSessionEntry).toHaveBeenNthCalledWith(2, {
      storePath: '/sessions/default.sqlite',
      sessionKey: 'agent:default:feishu:dm:user',
      agentId: 'default',
      readConsistency: 'latest',
    });
  });

  it('reports an unsupported surface only when the SDK subpath is absent', () => {
    mocks.requireSdk.mockImplementation(() => {
      throw Object.assign(new Error('missing SDK subpath'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    });
    expect(readFooterSessionMetricsFromSdk({ candidates: [] })).toEqual({ supported: false });
  });

  it('does not hide SDK initialization failures', () => {
    mocks.requireSdk.mockImplementation(() => {
      throw new Error('session database failed');
    });
    expect(() => readFooterSessionMetricsFromSdk({ candidates: [] })).toThrow('session database failed');
  });
});
