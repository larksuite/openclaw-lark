import { describe, expect, it } from 'vitest';
import { createClientAssertionProvider, isKeyless, resolveAuthMethod } from '../src/core/client-assertion-provider';
import { FeishuAccountConfigSchema } from '../src/core/config-schema';

describe('auth method resolution', () => {
  it('defaults to app_secret', () => {
    expect(resolveAuthMethod({})).toBe('app_secret');
    expect(resolveAuthMethod({ authMethod: 'app_secret' })).toBe('app_secret');
    expect(isKeyless({})).toBe(false);
  });

  it('detects keyless', () => {
    expect(resolveAuthMethod({ authMethod: 'private_key_jwt' })).toBe('private_key_jwt');
    expect(isKeyless({ authMethod: 'private_key_jwt' })).toBe(true);
  });
});

describe('createClientAssertionProvider', () => {
  it('returns null for an app_secret account', () => {
    expect(createClientAssertionProvider({}, { binaryPath: '/nonexistent/lark-keyless-signer' })).toBeNull();
  });

  it('constructs lazily without probing the provider', () => {
    expect(
      createClientAssertionProvider({
        appId: 'cli_keyless',
        authMethod: 'private_key_jwt',
        keyRef: 'openclaw-lark',
      }),
    ).not.toBeNull();
  });

  it('builds a provider for a keyless account when a binary path is given', () => {
    // Construction must not throw even when the path is not a real binary;
    // failures only surface when retrieveToken() is invoked.
    const provider = createClientAssertionProvider(
      {
        appId: 'cli_keyless',
        authMethod: 'private_key_jwt',
        keyRef: 'openclaw-lark',
      },
      { binaryPath: '/nonexistent/lark-keyless-signer' },
    );
    expect(provider).not.toBeNull();
    expect(typeof provider!.retrieveToken).toBe('function');
  });

  it('returns null for keyless config without an appId', () => {
    expect(
      createClientAssertionProvider(
        { authMethod: 'private_key_jwt', keyRef: 'openclaw-lark' },
        { binaryPath: '/nonexistent/lark-keyless-signer' },
      ),
    ).toBeNull();
  });
});

describe('keyless config schema', () => {
  it('accepts authMethod and keyRef on an account', () => {
    const r = FeishuAccountConfigSchema.safeParse({
      authMethod: 'private_key_jwt',
      keyRef: 'openclaw-lark',
    });
    expect(r.success).toBe(true);
    expect(r.data!.authMethod).toBe('private_key_jwt');
    expect(r.data!.keyRef).toBe('openclaw-lark');
  });

  it('rejects an unknown authMethod', () => {
    const r = FeishuAccountConfigSchema.safeParse({ authMethod: 'oauth' });
    expect(r.success).toBe(false);
  });

  it('defaults authMethod to undefined (app_secret at runtime)', () => {
    const r = FeishuAccountConfigSchema.safeParse({});
    expect(r.success).toBe(true);
    expect(r.data!.authMethod).toBeUndefined();
  });
});
