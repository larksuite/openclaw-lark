import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireSdk: vi.fn() }));
vi.mock('node:module', () => ({ createRequire: () => mocks.requireSdk }));
import { readDisplaySessionEntry } from '../src/core/session-compat';

beforeEach(() => {
  mocks.requireSdk.mockReset();
});

describe('session display SDK compatibility', () => {
  const params = { store: 'custom-store', agentId: 'account-agent', sessionKey: 'agent:account-agent:feishu:dm:user' };

  it('uses the read-only row accessor with the requested agent and store', () => {
    const getSessionEntry = vi.fn(() => ({ verboseLevel: 'full' }));
    mocks.requireSdk.mockReturnValue({ resolveStorePath: () => 'resolved-store', getSessionEntry });
    expect(readDisplaySessionEntry(params)).toEqual({ verboseLevel: 'full' });
    expect(mocks.requireSdk).toHaveBeenCalledWith('openclaw/plugin-sdk/session-store-runtime');
    expect(getSessionEntry).toHaveBeenCalledWith({
      storePath: 'resolved-store',
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    });
  });

  it.each(['ERR_PACKAGE_PATH_NOT_EXPORTED', 'MODULE_NOT_FOUND'])(
    'uses the legacy SDK only when the new surface is missing: %s',
    (code) => {
      const store = { entry: {} };
      const loadSessionStore = vi.fn(() => store);
      const resolveSessionStoreEntry = vi.fn(() => ({ existing: { verboseLevel: 'on' } }));
      mocks.requireSdk.mockImplementation((id: string) => {
        if (id.endsWith('/session-store-runtime')) throw Object.assign(new Error('missing'), { code });
        return { resolveStorePath: () => 'resolved-store', loadSessionStore, resolveSessionStoreEntry };
      });
      expect(readDisplaySessionEntry(params)).toEqual({ verboseLevel: 'on' });
      expect(loadSessionStore).toHaveBeenCalledWith('resolved-store');
      expect(resolveSessionStoreEntry).toHaveBeenCalledWith({ store, sessionKey: params.sessionKey });
    },
  );

  it('does not reinterpret an SDK initialization failure as an old host', () => {
    mocks.requireSdk.mockImplementation(() => {
      throw new Error('SDK initialization failed');
    });
    expect(() => readDisplaySessionEntry(params)).toThrow('SDK initialization failed');
    expect(mocks.requireSdk).toHaveBeenCalledTimes(1);
  });

  it('supports older session-store-runtime surfaces without a row accessor', () => {
    mocks.requireSdk.mockImplementation((id: string) =>
      id.endsWith('/session-store-runtime')
        ? { resolveStorePath: () => 'legacy-store' }
        : {
            resolveStorePath: () => 'legacy-store',
            loadSessionStore: () => ({}),
            resolveSessionStoreEntry: () => ({ existing: { verboseLevel: 'full' } }),
          },
    );
    expect(readDisplaySessionEntry(params)).toEqual({ verboseLevel: 'full' });
  });
});
