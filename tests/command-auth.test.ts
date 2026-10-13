import { describe, expect, it, vi } from 'vitest';
import { isNormalizedSenderAllowed } from 'openclaw/plugin-sdk/allow-from';
import { resolveSenderCommandAuthorization } from '../src/messaging/inbound/command-auth';

function makeParams(overrides: Partial<Parameters<typeof resolveSenderCommandAuthorization>[0]> = {}) {
  return {
    cfg: {},
    rawBody: '/status',
    isGroup: false,
    dmPolicy: 'pairing',
    configuredAllowFrom: ['ou_owner'],
    configuredGroupAllowFrom: [],
    senderId: 'ou_sender',
    isSenderAllowed: (senderId: string, allowFrom: string[]) => isNormalizedSenderAllowed({ senderId, allowFrom }),
    readAllowFromStore: vi.fn(async () => ['ou_sender']),
    shouldComputeCommandAuthorized: vi.fn(() => true),
    resolveCommandAuthorizedFromAuthorizers: vi.fn(
      (p: { useAccessGroups: boolean; authorizers: Array<{ configured: boolean; allowed: boolean }> }) =>
        !p.useAccessGroups || p.authorizers.some((a) => a.configured && a.allowed),
    ),
    ...overrides,
  };
}

describe('sender command authorization compatibility', () => {
  it('accepts a paired DM sender', async () => {
    const p = makeParams();
    expect((await resolveSenderCommandAuthorization(p)).commandAuthorized).toBe(true);
    expect(p.readAllowFromStore).toHaveBeenCalledOnce();
  });

  it.each(['allowlist', 'open'])('does not use pairing approvals with dmPolicy=%s', async (dmPolicy) => {
    const p = makeParams({ dmPolicy });
    expect((await resolveSenderCommandAuthorization(p)).commandAuthorized).toBe(false);
    expect(p.readAllowFromStore).not.toHaveBeenCalled();
  });

  it('fails closed when the pairing store is unavailable', async () => {
    const p = makeParams({
      readAllowFromStore: vi.fn(async () => {
        throw new Error('unavailable');
      }),
    });
    expect((await resolveSenderCommandAuthorization(p)).commandAuthorized).toBe(false);
  });

  it('never grants group commands from DM pairing approvals', async () => {
    const p = makeParams({ isGroup: true });
    expect((await resolveSenderCommandAuthorization(p)).commandAuthorized).toBe(false);
    expect(p.readAllowFromStore).not.toHaveBeenCalled();
  });

  it.each([
    { senderId: 'ou_owner', configuredGroupAllowFrom: [], expected: true },
    { senderId: 'ou_sender', configuredGroupAllowFrom: ['ou_sender'], expected: true },
    { senderId: 'ou_other', configuredGroupAllowFrom: ['ou_sender'], expected: false },
    { senderId: 'ou_sender', configuredGroupAllowFrom: ['*'], expected: true },
    { senderId: 'ou_sender', configuredGroupAllowFrom: [], expected: false },
  ])('preserves owner/group authorizers: $senderId $configuredGroupAllowFrom', async ({ expected, ...overrides }) => {
    expect(
      (await resolveSenderCommandAuthorization(makeParams({ isGroup: true, ...overrides }))).commandAuthorized,
    ).toBe(expected);
  });

  it('delegates useAccessGroups=false to the host without changing admission policy', async () => {
    const p = makeParams({ cfg: { commands: { useAccessGroups: false } }, isGroup: true });
    expect((await resolveSenderCommandAuthorization(p)).commandAuthorized).toBe(true);
    expect(p.resolveCommandAuthorizedFromAuthorizers).toHaveBeenCalledWith(
      expect.objectContaining({ useAccessGroups: false }),
    );
  });

  it('leaves non-command authorization undefined', async () => {
    const p = makeParams({ shouldComputeCommandAuthorized: vi.fn(() => false) });
    expect((await resolveSenderCommandAuthorization(p)).commandAuthorized).toBeUndefined();
    expect(p.resolveCommandAuthorizedFromAuthorizers).not.toHaveBeenCalled();
  });

  it('does not share pairing approvals between accounts', async () => {
    const accountA = makeParams({ configuredAllowFrom: [], readAllowFromStore: vi.fn(async () => ['ou_sender']) });
    const accountB = makeParams({ configuredAllowFrom: [], readAllowFromStore: vi.fn(async () => ['ou_other']) });
    const [a, b] = await Promise.all([
      resolveSenderCommandAuthorization(accountA),
      resolveSenderCommandAuthorization(accountB),
    ]);
    expect(a.commandAuthorized).toBe(true);
    expect(b.commandAuthorized).toBe(false);
    expect(accountA.readAllowFromStore).toHaveBeenCalledOnce();
    expect(accountB.readAllowFromStore).toHaveBeenCalledOnce();
  });
});
