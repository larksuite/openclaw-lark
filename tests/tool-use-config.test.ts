import { beforeEach, describe, expect, it, vi } from 'vitest';

// OpenClaw >=2026.8 keeps sessions in SQLite; mock the row-level reader.
const sessions = new Map<string, Record<string, unknown>>();
vi.mock('openclaw/plugin-sdk/session-store-runtime', () => ({
  resolveStorePath: (store?: string) => store ?? '/tmp/sessions',
  getSessionEntry: ({ sessionKey }: { sessionKey: string }) => sessions.get(sessionKey),
}));

const { resolveToolUseDisplayConfig } = await import('../src/card/tool-use-config');

beforeEach(() => {
  sessions.clear();
});

describe('resolveToolUseDisplayConfig', () => {
  it('uses session verbose override from the session store', () => {
    sessions.set('agent:main:feishu:dm:user-1', { sessionId: 's1', updatedAt: 1, verboseLevel: 'full' });

    const config = resolveToolUseDisplayConfig({
      cfg: { agents: { defaults: { verboseDefault: 'off' } } } as never,
      feishuCfg: { toolUseDisplay: { showFullPaths: true } } as never,
      agentId: 'main',
      sessionKey: 'agent:main:feishu:dm:user-1',
      body: 'run tests',
    });

    expect(config.mode).toBe('full');
    expect(config.showToolUse).toBe(true);
    expect(config.showToolResultDetails).toBe(true);
    expect(config.showFullPaths).toBe(true);
  });

  it('lets inline /verbose override the stored session level for this message', () => {
    sessions.set('agent:main:feishu:dm:user-1', { sessionId: 's1', updatedAt: 1, verboseLevel: 'off' });

    const config = resolveToolUseDisplayConfig({
      cfg: { agents: { defaults: { verboseDefault: 'off' } } } as never,
      feishuCfg: {} as never,
      agentId: 'main',
      sessionKey: 'agent:main:feishu:dm:user-1',
      body: 'please inspect this /verbose full',
    });

    expect(config.mode).toBe('full');
    expect(config.showToolUse).toBe(true);
  });

  it('falls back to agents.defaults.verboseDefault when no override exists', () => {
    const config = resolveToolUseDisplayConfig({
      cfg: { agents: { defaults: { verboseDefault: 'on' } } } as never,
      feishuCfg: {} as never,
      agentId: 'main',
      sessionKey: 'agent:main:feishu:dm:user-1',
      body: 'run tests',
    });

    expect(config.mode).toBe('on');
    expect(config.showToolUse).toBe(true);
    expect(config.showToolResultDetails).toBe(false);
  });

  it('defaults to off when no inline, session, or config value is present', () => {
    const config = resolveToolUseDisplayConfig({
      cfg: {} as never,
      feishuCfg: {} as never,
      agentId: 'main',
      sessionKey: 'agent:main:feishu:dm:user-1',
      body: 'run tests',
    });

    expect(config.mode).toBe('off');
    expect(config.showToolUse).toBe(false);
  });

  it('falls back to the default-agent session key for non-default agents', () => {
    sessions.set('agent:main:feishu:dm:user-1', { sessionId: 's1', updatedAt: 1, verboseLevel: 'full' });

    const config = resolveToolUseDisplayConfig({
      cfg: { agents: { defaults: { verboseDefault: 'off' } } } as never,
      feishuCfg: {} as never,
      agentId: 'hr',
      sessionKey: 'agent:hr:feishu:dm:user-1',
      body: 'run tests',
    });

    expect(config.mode).toBe('full');
    expect(config.showToolUse).toBe(true);
    expect(config.showToolResultDetails).toBe(true);
  });
});
