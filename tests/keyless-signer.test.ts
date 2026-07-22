import { chmodSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_KEY_REF,
  KeylessSigner,
  type ResolvedKeylessSigner,
  keylessSignerBinaryName,
  keylessSignerPackageName,
  resolveKeylessSignerPath,
  resolvePlatformKeylessSigner,
} from '../src/core/keyless-signer.ts';

// A fake signer that speaks the IAM lark-keyless-signer protocol on stdin/stdout.
// It lets us exercise the wrapper without the real (internal) binary. keyRef
// "boom" forces an {ok:false,error} envelope so we can test error handling.
const FAKE_SIGNER = `#!${process.execPath}
let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  if (process.argv.length !== 2) { process.stdout.write(JSON.stringify({ ok: false, error: { type: 'invalid_request', message: 'unexpected argv' } })); process.exit(2); }
  let req;
  try { req = JSON.parse(data); }
  catch { process.stdout.write(JSON.stringify({ ok: false, error: { type: 'invalid_request', message: 'bad json' } })); process.exit(2); }
  const { op, keyRef, clientId, aud, nonce } = req;
  if (keyRef === 'boom') { process.stdout.write(JSON.stringify({ ok: false, error: { type: 'not_found', message: 'no such key' } })); process.exit(1); }
  if (op === 'pubkey') { process.stdout.write(JSON.stringify({ ok: true, alg: 'RS256', jwk: { kty: 'RSA', n: 'x', e: 'AQAB' }, spki: Buffer.from('spki-' + keyRef).toString('base64') })); return; }
  if (op === 'sign-attestation') { process.stdout.write(JSON.stringify({ ok: true, attestation: ['att', nonce, keyRef].join('.') })); return; }
  if (op === 'sign-assertion') {
    const clientAssertion = aud === 'report-env'
      ? JSON.stringify({ home: process.env.HOME, nodeOptions: process.env.NODE_OPTIONS, path: process.env.PATH })
      : ['assn', clientId, aud, keyRef].join('.');
    process.stdout.write(JSON.stringify({ ok: true, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: clientAssertion }));
    return;
  }
  process.stdout.write(JSON.stringify({ ok: false, error: { type: 'invalid_request', message: 'unknown op' } }));
  process.exit(2);
});
`;

function resolvedFakeSigner(binaryPath: string): ResolvedKeylessSigner {
  const info = lstatSync(binaryPath);
  return {
    binaryPath,
    cwd: dirname(binaryPath),
    env: { HOME: process.env.HOME },
    platform: process.platform,
    identity: {
      dev: info.dev,
      ino: info.ino,
      mode: info.mode,
      size: info.size,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
    },
  };
}

// Executing a shebang test fixture is a POSIX-only convenience; skip on Windows.
describe.skipIf(process.platform === 'win32')('KeylessSigner against a fake signer', () => {
  let dir: string;
  let bin: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'kl-signer-'));
    bin = join(dir, 'fake-signer.mjs');
    writeFileSync(bin, FAKE_SIGNER);
    chmodSync(bin, 0o755);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('pubkey returns alg/jwk/spki', async () => {
    const { alg, jwk, spki } = await new KeylessSigner({ binaryPath: bin }).getPublicKey();
    expect(alg).toBe('RS256');
    expect(jwk.kty).toBe('RSA');
    expect(Buffer.from(spki, 'base64').toString()).toBe(`spki-${DEFAULT_KEY_REF}`);
  });

  it('sign-assertion sends keyRef/clientId/aud and returns client_assertion', async () => {
    const signer = new KeylessSigner({ binaryPath: bin, keyRef: 'my-key' });
    const assertion = await signer.signAssertion('cli_test', 'accounts.feishu.cn');
    expect(assertion).toBe('assn.cli_test.accounts.feishu.cn.my-key');
  });

  it('sign-attestation sends keyRef/nonce and returns attestation', async () => {
    const signer = new KeylessSigner({ binaryPath: bin, keyRef: 'my-key' });
    expect(await signer.signAttestation('nonce123')).toBe('att.nonce123.my-key');
  });

  it('defaults keyRef to DEFAULT_KEY_REF', async () => {
    const assertion = await new KeylessSigner({ binaryPath: bin }).signAssertion('cli_x', 'aud');
    expect(assertion.endsWith(`.${DEFAULT_KEY_REF}`)).toBe(true);
  });

  it('rejects with the envelope error type/message on {ok:false}', async () => {
    const signer = new KeylessSigner({ binaryPath: bin, keyRef: 'boom' });
    await expect(signer.signAssertion('cli_test', 'aud')).rejects.toMatchObject({
      name: 'KeylessSignerError',
      type: 'not_found',
      message: 'no such key',
    });
  });
});

describe('resolveKeylessSignerPath', () => {
  it('uses the platform executable suffix', () => {
    expect(keylessSignerBinaryName('win32')).toBe('lark-keyless-signer.exe');
    expect(keylessSignerBinaryName('darwin')).toBe('lark-keyless-signer');
    expect(keylessSignerBinaryName('linux')).toBe('lark-keyless-signer');
  });

  it('maps only supported platform packages', () => {
    expect(keylessSignerPackageName('darwin', 'arm64')).toBe('@larksuite/lark-keyless-signer-darwin-arm64');
    expect(keylessSignerPackageName('linux', 'x64')).toBe('@larksuite/lark-keyless-signer-linux-x64');
    expect(keylessSignerPackageName('win32', 'x64')).toBe('@larksuite/lark-keyless-signer-win32-x64');
    expect(keylessSignerPackageName('linux', 'riscv64')).toBeUndefined();
  });

  it('honors a valid explicit test path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kl-explicit-'));
    const binaryPath = join(dir, 'lark-keyless-signer');
    try {
      writeFileSync(binaryPath, FAKE_SIGNER, { mode: 0o700 });
      expect(resolveKeylessSignerPath(binaryPath)).toBe(binaryPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores the legacy runtime path override', () => {
    const saved = process.env.LARK_KEYLESS_SIGNER_PATH;
    process.env.LARK_KEYLESS_SIGNER_PATH = '/env/lark-keyless-signer';
    try {
      expect(resolveKeylessSignerPath()).not.toBe('/env/lark-keyless-signer');
    } finally {
      if (saved === undefined) delete process.env.LARK_KEYLESS_SIGNER_PATH;
      else process.env.LARK_KEYLESS_SIGNER_PATH = saved;
    }
  });

  it.skipIf(!resolveKeylessSignerPath())('resolves the current platform package and uses its root as cwd', () => {
    const resolved = resolvePlatformKeylessSigner();
    expect(resolved.binaryPath).toContain(`${keylessSignerPackageName()}/bin/${keylessSignerBinaryName()}`);
    expect(resolved.cwd).toBe(dirname(dirname(resolved.binaryPath)));
  });

  it.skipIf(process.platform === 'win32')('passes only a minimal environment with the receiving HOME', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kl-env-'));
    const binaryPath = join(dir, 'lark-keyless-signer');
    writeFileSync(binaryPath, FAKE_SIGNER, { mode: 0o700 });
    const savedHome = process.env.HOME;
    const savedNodeOptions = process.env.NODE_OPTIONS;
    const savedPath = process.env.PATH;
    process.env.HOME = '/tmp/receiving-user-home';
    process.env.NODE_OPTIONS = '--require=/tmp/untrusted.js';
    process.env.PATH = '/tmp/untrusted-bin';
    try {
      const assertion = await new KeylessSigner({ binaryPath }).signAssertion('cli_app', 'report-env');
      expect(JSON.parse(assertion)).toEqual({ home: '/tmp/receiving-user-home' });
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = savedNodeOptions;
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports availability consistently with optional-package resolution', () => {
    const path = resolveKeylessSignerPath();
    expect(KeylessSigner.isAvailable()).toBe(Boolean(path));
    if (path) expect(path).toMatch(/[/\\]bin[/\\]lark-keyless-signer(?:\.exe)?$/);
  });

  it.skipIf(process.platform === 'win32')('re-resolves and rechecks the executable for every operation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kl-reresolve-'));
    const binaryPath = join(dir, 'lark-keyless-signer');
    writeFileSync(binaryPath, FAKE_SIGNER, { mode: 0o700 });
    const signerResolver = vi.fn(() => resolvedFakeSigner(binaryPath));
    const signer = new KeylessSigner({ keyRef: 'shared-key', signerResolver });
    try {
      await expect(signer.signAssertion('cli_app', 'aud-1')).resolves.toBe('assn.cli_app.aud-1.shared-key');
      await expect(signer.signAssertion('cli_app', 'aud-2')).resolves.toBe('assn.cli_app.aud-2.shared-key');
      expect(signerResolver).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('rejects a non-executable regular file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kl-nonexec-'));
    const binaryPath = join(dir, 'lark-keyless-signer');
    writeFileSync(binaryPath, FAKE_SIGNER, { mode: 0o600 });
    try {
      await expect(new KeylessSigner({ binaryPath }).signAssertion('cli_app', 'aud')).rejects.toMatchObject({
        type: 'unsafe_signer',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a non-regular signer path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kl-not-regular-'));
    try {
      await expect(new KeylessSigner({ binaryPath: dir }).signAssertion('cli_app', 'aud')).rejects.toMatchObject({
        type: 'unsafe_signer',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed if the executable identity changes after resolution', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kl-race-'));
    const binaryPath = join(dir, 'lark-keyless-signer');
    writeFileSync(binaryPath, FAKE_SIGNER, { mode: 0o700 });
    const resolved = resolvedFakeSigner(binaryPath);
    writeFileSync(binaryPath, `${FAKE_SIGNER}\n`, { mode: 0o700 });
    try {
      await expect(
        new KeylessSigner({ signerResolver: () => resolved }).signAssertion('cli_app', 'aud'),
      ).rejects.toMatchObject({ type: 'signer_raced' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
