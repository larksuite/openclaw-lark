import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenClawConfig } from 'openclaw/plugin-sdk';
import { resolveAgentRoute } from 'openclaw/plugin-sdk/routing';
import { checkAccountRouting } from '../src/commands/routing-diagnostic';

vi.mock('openclaw/plugin-sdk/routing', () => ({ resolveAgentRoute: vi.fn() }));

const cfg = { channels: { feishu: { enabled: true } } } as OpenClawConfig;
const resolve = vi.mocked(resolveAgentRoute);

describe('account default routing diagnosis', () => {
  beforeEach(() => {
    resolve.mockReset();
  });

  it('uses the host resolver with the exact account and no synthetic peer', () => {
    resolve.mockReturnValue({ agentId: 'main' } as ReturnType<typeof resolveAgentRoute>);
    expect(checkAccountRouting(cfg, 'work')).toMatchObject({ status: 'pass', message: '默认路由到 Agent: main' });
    expect(resolve).toHaveBeenCalledExactlyOnceWith({ cfg, channel: 'feishu', accountId: 'work' });
  });

  it('warns about missing ownership without automatically choosing an agent', () => {
    const error = Object.assign(new Error('Multiple agents are configured'), {
      surface: 'feishu account default routing',
    });
    error.name = 'AgentSelectionRequiredError';
    resolve.mockImplementation(() => {
      throw error;
    });
    const before = JSON.stringify(cfg);
    const result = checkAccountRouting(cfg, 'default');
    expect(result.status).toBe('warn');
    expect(result.details).toContain('openclaw agents bind --agent <agent-id> --bind "feishu:default"');
    expect(result.details).toContain('若有意仅允许已绑定会话');
    expect(result.details).toContain('特定群/会话绑定仍优先');
    expect(JSON.stringify(cfg)).toBe(before);
  });

  it('does not misclassify other errors as missing ownership', () => {
    resolve.mockImplementation(() => {
      throw new Error('invalid route configuration');
    });
    expect(checkAccountRouting(cfg, 'default')).toMatchObject({
      status: 'fail',
      message: '路由检查失败: invalid route configuration',
    });
  });

  it('fails with the host explanation when a binding targets an unknown agent', () => {
    const error = Object.assign(new Error('Update the binding agentId "missing" to a configured agent.'), {
      name: 'AgentSelectionRequiredError',
      surface: 'route binding',
    });
    resolve.mockImplementation(() => {
      throw error;
    });
    expect(checkAccountRouting(cfg, 'default')).toMatchObject({
      status: 'fail',
      message: '路由检查失败: Update the binding agentId "missing" to a configured agent.',
    });
  });
});
