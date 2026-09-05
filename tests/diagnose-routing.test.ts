import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenClawConfig } from 'openclaw/plugin-sdk';
import { resolveAgentRoute } from 'openclaw/plugin-sdk/routing';
import { runDiagnosis } from '../src/commands/diagnose';
import { probeFeishu } from '../src/channel/probe';

const { clientState } = vi.hoisted(() => ({ clientState: { globalConfig: null as OpenClawConfig | null } }));

vi.mock('openclaw/plugin-sdk/routing', () => ({ resolveAgentRoute: vi.fn() }));
vi.mock('../src/channel/probe', () => ({
  probeFeishu: vi.fn(async () => ({ ok: true, botName: 'Test bot', botOpenId: 'ou_test_bot' })),
}));
vi.mock('../src/core/lark-client', () => ({
  LarkClient: {
    get globalConfig() {
      return clientState.globalConfig;
    },
    fromAccount: () => ({ sdk: { application: { scope: { list: async () => ({ code: 0, data: { scopes: [] } }) } } } }),
  },
}));
vi.mock('node:fs/promises', () => ({
  access: async () => {},
  stat: async () => ({ size: 0 }),
  open: async () => ({ read: async () => {}, close: async () => {} }),
}));

const cfg = {
  channels: { feishu: { enabled: true, appId: 'cli_test', appSecret: 'test-not-a-real-secret' } },
} as OpenClawConfig;
const resolve = vi.mocked(resolveAgentRoute);

describe('routing in the complete diagnostic report', () => {
  beforeEach(() => {
    resolve.mockReset();
    vi.mocked(probeFeishu).mockClear();
    clientState.globalConfig = null;
  });

  it('reports degraded routing even when the Feishu API probe succeeds', async () => {
    const error = Object.assign(new Error('missing explicit owner'), { surface: 'feishu account default routing' });
    error.name = 'AgentSelectionRequiredError';
    resolve.mockImplementation(() => {
      throw error;
    });
    const report = await runDiagnosis({ config: cfg });
    expect(probeFeishu).toHaveBeenCalledOnce();
    expect(report.accounts[0].checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'API 连通性', status: 'pass' }),
        expect.objectContaining({ name: '账户默认 Agent 路由', status: 'warn' }),
      ]),
    );
    expect(report.overallStatus).toBe('degraded');
  });

  it('reports healthy after an explicit account route resolves', async () => {
    resolve.mockReturnValue({ agentId: 'main' } as ReturnType<typeof resolveAgentRoute>);
    const report = await runDiagnosis({ config: cfg });
    expect(report.accounts[0].checks).toContainEqual(
      expect.objectContaining({ name: '账户默认 Agent 路由', status: 'pass' }),
    );
    expect(report.overallStatus).toBe('healthy');
  });

  it('skips routing for disabled accounts', async () => {
    await runDiagnosis({ config: { ...cfg, channels: { feishu: { ...cfg.channels!.feishu, enabled: false } } } });
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(['added', 'removed'])('uses active routing when bindings were %s after monitor startup', async (change) => {
    const binding = { agentId: 'main', match: { channel: 'feishu', accountId: 'default' } };
    clientState.globalConfig = { ...cfg, bindings: change === 'removed' ? [binding] : [] };
    const active = { ...cfg, ...(change === 'added' ? { bindings: [binding] } : {}) };
    resolve.mockReturnValue({ agentId: 'main' } as ReturnType<typeof resolveAgentRoute>);
    await runDiagnosis({ config: active });
    const checked = resolve.mock.calls[0][0].cfg;
    expect(checked.bindings).toEqual(active.bindings);
    expect(checked.channels).toBe(clientState.globalConfig.channels);
  });
});
