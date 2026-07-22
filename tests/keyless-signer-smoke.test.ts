import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KeylessSigner } from '../src/core/keyless-signer.ts';
import { createClientAssertionProvider } from '../src/core/client-assertion-provider';

// End-to-end smoke through an explicitly injected fake executable. Production
// code never accepts a runtime path override and instead resolves the fixed
// optional dependency for the current platform.
const FAKE_SIGNER = `#!${process.execPath}
let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  const { op, keyRef, clientId, aud } = JSON.parse(data);
  if (op === 'pubkey') {
    process.stdout.write(JSON.stringify({ ok: true, alg: 'ES256', jwk: { kty: 'EC', crv: 'P-256' }, spki: Buffer.from('spki:' + keyRef).toString('base64') }));
    return;
  }
  if (op === 'sign-assertion') {
    process.stdout.write(JSON.stringify({ ok: true, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: ['jwt', clientId, aud, keyRef].join('.') }));
    return;
  }
  process.stdout.write(JSON.stringify({ ok: false, error: { type: 'invalid_request', message: 'unknown op' } }));
  process.exit(2);
});
`;

describe.skipIf(process.platform === 'win32')('keyless signer subprocess smoke', () => {
  let dir: string;
  let bin: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'kl-smoke-'));
    bin = join(dir, 'fake-signer.mjs');
    writeFileSync(bin, FAKE_SIGNER);
    chmodSync(bin, 0o755);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('getPublicKey parses the subprocess envelope', async () => {
    const { alg, jwk, spki } = await new KeylessSigner({
      binaryPath: bin,
      keyRef: 'openclaw-lark',
    }).getPublicKey();
    expect(alg).toBe('ES256');
    expect(jwk.kty).toBe('EC');
    expect(Buffer.from(spki, 'base64').toString()).toBe('spki:openclaw-lark');
  });

  it('signAssertion returns the subprocess result', async () => {
    const assertion = await new KeylessSigner({ binaryPath: bin, keyRef: 'openclaw-lark' }).signAssertion(
      'cli_app',
      'open.feishu.cn',
    );
    expect(assertion).toBe('jwt.cli_app.open.feishu.cn.openclaw-lark');
  });

  it('createClientAssertionProvider.retrieveToken() drives the injected subprocess', async () => {
    const provider = createClientAssertionProvider(
      {
        appId: 'cli_app',
        authMethod: 'private_key_jwt',
        keyRef: 'openclaw-lark',
      },
      { binaryPath: bin },
    );
    expect(provider).not.toBeNull();
    const token = await provider!.retrieveToken('open.feishu.cn');
    expect(token).toEqual({ value: 'jwt.cli_app.open.feishu.cn.openclaw-lark' });
  });
});
