import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveToolUseDisplayConfig } from '../src/card/tool-use-config';

vi.mock('openclaw/plugin-sdk/config-runtime', () => ({
  getSessionEntry: vi.fn(),
  resolveStorePath: vi.fn((storePath: string) => storePath),
}));

import { getSessionEntry } from 'openclaw/plugin-sdk/config-runtime';

const mockedGetSessionEntry = vi.mocked(getSessionEntry);

/**
 * Seed the mocked 9.4 session store lookup.
 * Keys follow the legacy shape written by the 6.x session store:
 * `agent:<agentId>:<channel>:<scope>:<id>`.
 */
function seedSessionStore(entries: Record<string, { sessionId?: string; verboseLevel?: string }>): void {
  mockedGetSessionEntry.mockImplementation(({ sessionKey }) => {
    const entry = entries[sessionKey as string];
    return entry ? (entry as never) : undefined;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('resolveToolUseDisplayConfig', () => {
  it('uses session verbose override from the session store', () => {
    seedSessionStore({
      'agent:main:feishu:dm:user-1': { sessionId: 's1', verboseLevel: 'full' },
    });

    const config = resolveToolUseDisplayConfig({
      cfg: {
        session: { store: '/tmp/unused.json' },
        agents: { defaults: { verboseDefault: 'off' } },
      } as never,
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
    seedSessionStore({
      'agent:main:feishu:dm:user-1': { sessionId: 's1', verboseLevel: 'off' },
    });

    const config = resolveToolUseDisplayConfig({
      cfg: {
        session: { store: '/tmp/unused.json' },
        agents: { defaults: { verboseDefault: 'off' } },
      } as never,
      feishuCfg: {} as never,
      agentId: 'main',
      sessionKey: 'agent:main:feishu:dm:user-1',
      body: 'please inspect this /verbose full',
    });

    expect(config.mode).toBe('full');
    expect(config.showToolUse).toBe(true);
  });

  it('falls back to agents.defaults.verboseDefault when no override exists', () => {
    seedSessionStore({});

    const config = resolveToolUseDisplayConfig({
      cfg: {
        session: { store: '/tmp/unused.json' },
        agents: { defaults: { verboseDefault: 'on' } },
      } as never,
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
    seedSessionStore({});

    const config = resolveToolUseDisplayConfig({
      cfg: { session: { store: '/tmp/unused.json' } } as never,
      feishuCfg: {} as never,
      agentId: 'main',
      sessionKey: 'agent:main:feishu:dm:user-1',
      body: 'run tests',
    });

    expect(config.mode).toBe('off');
    expect(config.showToolUse).toBe(false);
  });

  it('falls back to the default-agent session key for non-default agents', () => {
    seedSessionStore({
      'agent:main:feishu:dm:user-1': { sessionId: 's1', verboseLevel: 'full' },
    });

    const config = resolveToolUseDisplayConfig({
      cfg: {
        session: { store: '/tmp/unused.json' },
        agents: { defaults: { verboseDefault: 'off' } },
      } as never,
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
