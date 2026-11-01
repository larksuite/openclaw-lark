import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionRows = new Map<string, { verboseLevel?: string }>();

vi.mock('openclaw/plugin-sdk/session-store-runtime', () => ({
  getSessionEntry: ({ agentId, sessionKey }: { agentId?: string; sessionKey: string }) =>
    sessionRows.get(`${agentId}|${sessionKey}`),
}));

import { resolveToolUseDisplayConfig } from '../src/card/tool-use-config';

function storeSession(agentId: string, sessionKey: string, verboseLevel: string): void {
  sessionRows.set(`${agentId}|${sessionKey}`, { verboseLevel });
}

beforeEach(() => {
  sessionRows.clear();
});

describe('resolveToolUseDisplayConfig', () => {
  it('uses session verbose override from the session store', () => {
    storeSession('main', 'agent:main:feishu:dm:user-1', 'full');

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
    storeSession('main', 'agent:main:feishu:dm:user-1', 'off');

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
    storeSession('main', 'agent:main:feishu:dm:user-1', 'full');

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

  it('stops at an existing primary session row without a verbose level', () => {
    sessionRows.set('hr|agent:hr:feishu:dm:user-1', {});
    storeSession('main', 'agent:main:feishu:dm:user-1', 'full');

    const config = resolveToolUseDisplayConfig({
      cfg: { agents: { defaults: { verboseDefault: 'on' } } } as never,
      feishuCfg: {} as never,
      agentId: 'hr',
      sessionKey: 'agent:hr:feishu:dm:user-1',
      body: 'run tests',
    });

    expect(config.mode).toBe('on');
  });
});
