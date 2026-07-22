// Keyless (private_key_jwt) signing for the Feishu plugin.
//
// The device private key is non-exportable and lives in the OS key facility
// (macOS Keychain / Linux+Windows TPM). It never enters this Node process. All
// signing is delegated to the `lark-keyless-signer` binary, invoked as a
// one-shot subprocess over stdin/stdout JSON. This module is a thin wrapper
// around that protocol — there is deliberately no private-key material, PEM, or
// in-process crypto here.
//
// Protocol (IAM lark-keyless-signer): request carries `keyRef`; every response
// is an envelope `{ ok, error?: { type, message } }`.
//   pubkey           { keyRef }                 -> { ok, alg, jwk, spki }
//   sign-attestation { keyRef, nonce }          -> { ok, attestation }
//   sign-assertion   { keyRef, clientId, aud }  -> { ok, client_assertion_type, client_assertion }
import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Default device-key reference for openclaw-lark. onboard (attestation) and
 * runtime (assertion) must use the same keyRef so both bind to one device key.
 */
export const DEFAULT_KEY_REF = 'openclaw-lark';

/** Signer binary basename inside each per-platform package. */
const BINARY_BASENAME = 'lark-keyless-signer';

/** Platform packages are fixed code constants, never app config or environment input. */
const SIGNER_PACKAGES: Readonly<Record<string, string>> = {
  'darwin-arm64': '@larksuite/lark-keyless-signer-darwin-arm64',
  'darwin-x64': '@larksuite/lark-keyless-signer-darwin-x64',
  'linux-arm64': '@larksuite/lark-keyless-signer-linux-arm64',
  'linux-x64': '@larksuite/lark-keyless-signer-linux-x64',
  'win32-x64': '@larksuite/lark-keyless-signer-win32-x64',
};

const requireFromPlugin = createRequire(import.meta.url);

interface SignerFileIdentity {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface ResolvedKeylessSigner {
  binaryPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  identity: SignerFileIdentity;
}

export class KeylessSignerError extends Error {
  /** Error type from the signer envelope (e.g. invalid_request), if present. */
  readonly type?: string;

  constructor(message: string, type?: string) {
    super(message);
    this.name = 'KeylessSignerError';
    this.type = type;
  }
}

/** Windows packages ship an .exe; POSIX packages use the bare basename. */
export function keylessSignerBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${BINARY_BASENAME}.exe` : BINARY_BASENAME;
}

/** Return the fixed optional package for a supported platform/architecture pair. */
export function keylessSignerPackageName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  return SIGNER_PACKAGES[`${platform}-${arch}`];
}

function minimalSignerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    // The signer must see the receiving user's key store, never a build-time or
    // plugin-owned HOME. Use the live process HOME with the OS home as fallback.
    HOME: process.env.HOME?.trim() || homedir(),
  };
  const allowed = [
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TMPDIR',
    'TMP',
    'TEMP',
    'SystemRoot',
    'WINDIR',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
  ];
  for (const name of allowed) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function inspectSignerBinary(binaryPath: string, platform: NodeJS.Platform): SignerFileIdentity {
  let info;
  try {
    info = lstatSync(binaryPath);
  } catch {
    throw new KeylessSignerError(
      `keyless signer binary is missing from its platform package: ${binaryPath}`,
      'signer_unavailable',
    );
  }
  if (!info.isFile()) {
    throw new KeylessSignerError('keyless signer binary must be a regular file', 'unsafe_signer');
  }
  if (platform !== 'win32' && (info.mode & 0o111) === 0) {
    throw new KeylessSignerError('keyless signer binary is not executable', 'unsafe_signer');
  }
  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  };
}

function resolveInjectedSigner(binaryPath: string): ResolvedKeylessSigner {
  const platform = process.platform;
  return {
    binaryPath,
    cwd: dirname(binaryPath),
    env: minimalSignerEnv(),
    platform,
    identity: inspectSignerBinary(binaryPath, platform),
  };
}

/** Resolve and inspect the current host's signer optional dependency. */
export function resolvePlatformKeylessSigner(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ResolvedKeylessSigner {
  const packageName = keylessSignerPackageName(platform, arch);
  if (!packageName) {
    throw new KeylessSignerError(`keyless signer does not support ${platform}-${arch}`, 'unsupported_platform');
  }

  let packageJsonPath: string;
  try {
    packageJsonPath = requireFromPlugin.resolve(`${packageName}/package.json`);
  } catch {
    throw new KeylessSignerError(
      `keyless signer optional dependency ${packageName} is unavailable; reinstall ` +
        '@larksuite/openclaw-lark from the configured registry',
      'signer_unavailable',
    );
  }

  const packageRoot = dirname(packageJsonPath);
  const binaryPath = join(packageRoot, 'bin', keylessSignerBinaryName(platform));
  return {
    binaryPath,
    cwd: packageRoot,
    env: minimalSignerEnv(),
    platform,
    identity: inspectSignerBinary(binaryPath, platform),
  };
}

/**
 * Resolve the signer path for diagnostics. `explicit` is a unit-test seam;
 * normal runtime calls always resolve the fixed optional dependency.
 */
export function resolveKeylessSignerPath(explicit?: string): string | undefined {
  try {
    return (explicit ? resolveInjectedSigner(explicit) : resolvePlatformKeylessSigner()).binaryPath;
  } catch {
    return undefined;
  }
}

function assertSignerBinaryUnchanged(resolved: ResolvedKeylessSigner): void {
  const current = inspectSignerBinary(resolved.binaryPath, resolved.platform);
  const expected = resolved.identity;
  if (
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.mode !== expected.mode ||
    current.size !== expected.size ||
    current.mtimeMs !== expected.mtimeMs ||
    current.ctimeMs !== expected.ctimeMs
  ) {
    throw new KeylessSignerError('keyless signer binary changed between resolution and execution', 'signer_raced');
  }
}

export interface PublicKeyResult {
  /** Signing algorithm, e.g. RS256 (macOS) or ES256 (Linux/Windows). */
  alg: string;
  /** Public key as a JWK (for registration). */
  jwk: Record<string, unknown>;
  /** Public key as base64-encoded PKIX/SPKI DER. */
  spki: string;
}

export interface KeylessSignerOptions {
  /** Unit-test executable injection; production callers must leave unset. */
  binaryPath?: string;
  /** Device-key reference; defaults to DEFAULT_KEY_REF. */
  keyRef?: string;
  /** Unit-test resolver injection; production callers must leave unset. */
  signerResolver?: () => ResolvedKeylessSigner;
}

type SignerOp = 'pubkey' | 'sign-attestation' | 'sign-assertion';

interface SignerRequest {
  op: SignerOp;
  keyRef: string;
  clientId?: string;
  aud?: string;
  nonce?: string;
}

interface SignerEnvelope {
  ok?: boolean;
  error?: { type?: string; message?: string };
  alg?: string;
  jwk?: Record<string, unknown>;
  spki?: string;
  attestation?: string;
  client_assertion?: string;
  client_assertion_type?: string;
}

export class KeylessSigner {
  private readonly keyRef: string;
  private readonly signerResolver: () => ResolvedKeylessSigner;

  constructor(opts: KeylessSignerOptions = {}) {
    this.keyRef = opts.keyRef?.trim() || DEFAULT_KEY_REF;
    this.signerResolver =
      opts.signerResolver ??
      (opts.binaryPath ? () => resolveInjectedSigner(opts.binaryPath!) : () => resolvePlatformKeylessSigner());
  }

  /** Whether the signer package and executable are currently usable. */
  static isAvailable(opts: KeylessSignerOptions = {}): boolean {
    const resolver =
      opts.signerResolver ??
      (opts.binaryPath ? () => resolveInjectedSigner(opts.binaryPath!) : () => resolvePlatformKeylessSigner());
    try {
      const resolved = resolver();
      assertSignerBinaryUnchanged(resolved);
      return true;
    } catch {
      return false;
    }
  }

  /** Ensure the device key exists and return its public half (for registration). */
  async getPublicKey(): Promise<PublicKeyResult> {
    const res = await this.call({ op: 'pubkey', keyRef: this.keyRef });
    const alg = res.alg;
    if (
      !alg ||
      !['RS256', 'ES256'].includes(alg) ||
      !res.jwk ||
      typeof res.jwk !== 'object' ||
      Array.isArray(res.jwk) ||
      typeof res.spki !== 'string' ||
      !res.spki
    ) {
      throw new KeylessSignerError('pubkey: signer returned no alg/jwk/spki');
    }
    const privateJwkMembers = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'];
    if (privateJwkMembers.some((member) => member in res.jwk!)) {
      throw new KeylessSignerError('pubkey: signer returned private JWK material');
    }
    return { alg, jwk: res.jwk, spki: res.spki };
  }

  /** Sign the onboard registration attestation binding the device key to the app. */
  async signAttestation(nonce: string): Promise<string> {
    if (!nonce.trim()) throw new KeylessSignerError('sign-attestation: nonce must be non-empty');
    const res = await this.call({ op: 'sign-attestation', keyRef: this.keyRef, nonce });
    if (typeof res.attestation !== 'string' || !res.attestation) {
      throw new KeylessSignerError('sign-attestation: empty result');
    }
    return res.attestation;
  }

  /** Mint a short-lived RFC 7523 client_assertion for the token exchange. */
  async signAssertion(clientId: string, aud: string): Promise<string> {
    if (!clientId.trim() || !aud.trim()) {
      throw new KeylessSignerError('sign-assertion: clientId and aud must be non-empty');
    }
    const res = await this.call({ op: 'sign-assertion', keyRef: this.keyRef, clientId, aud });
    if (
      res.client_assertion_type !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' ||
      typeof res.client_assertion !== 'string' ||
      !res.client_assertion
    ) {
      throw new KeylessSignerError('sign-assertion: invalid assertion response');
    }
    return res.client_assertion;
  }

  private resolveForCall(): ResolvedKeylessSigner {
    try {
      // The package and executable are resolved anew for every operation, then
      // the identity captured during inspection is checked again before spawn.
      const resolved = this.signerResolver();
      assertSignerBinaryUnchanged(resolved);
      return resolved;
    } catch (error) {
      if (error instanceof KeylessSignerError) throw error;
      throw new KeylessSignerError(
        `keyless signer unavailable: ${error instanceof Error ? error.message : String(error)}`,
        'signer_unavailable',
      );
    }
  }

  private call(req: SignerRequest): Promise<SignerEnvelope> {
    const payload = JSON.stringify(req);
    if (Buffer.byteLength(payload) > 64 * 1024) {
      return Promise.reject(new KeylessSignerError('signer request exceeds 64 KiB'));
    }
    let executable: ResolvedKeylessSigner;
    try {
      executable = this.resolveForCall();
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise<SignerEnvelope>((resolve, reject) => {
      const child = spawn(executable.binaryPath, [], {
        cwd: executable.cwd,
        env: executable.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      const finishError = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        reject(error);
      };
      const timer = setTimeout(() => finishError(new KeylessSignerError('signer timed out after 10 seconds')), 10_000);

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > 1 << 20) {
          finishError(new KeylessSignerError('signer stdout exceeds 1 MiB'));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > 64 * 1024) {
          finishError(new KeylessSignerError('signer stderr exceeds 64 KiB'));
          return;
        }
        stderr.push(chunk);
      });
      child.on('error', (error) => finishError(new KeylessSignerError(`signer transport failed: ${error.message}`)));
      child.stdin.on('error', () => {
        // The close/error handler owns the transport result. Avoid an
        // unhandled EPIPE if a malformed signer exits before reading stdin.
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const output = Buffer.concat(stdout).toString('utf8');
        if (!output) {
          reject(new KeylessSignerError(`signer transport failed (exit ${code ?? 'unknown'})`));
          return;
        }
        let res: SignerEnvelope;
        try {
          res = JSON.parse(output) as SignerEnvelope;
        } catch {
          reject(new KeylessSignerError('signer produced non-JSON output'));
          return;
        }
        if (!res || typeof res !== 'object' || Array.isArray(res)) {
          reject(new KeylessSignerError('signer response must be a JSON object'));
          return;
        }
        if (res.ok === false || res.error) {
          if (typeof res.error?.type !== 'string' || typeof res.error.message !== 'string') {
            reject(new KeylessSignerError('signer returned an invalid error envelope'));
            return;
          }
          reject(new KeylessSignerError(res.error.message, res.error.type));
          return;
        }
        if (res.ok !== true) {
          reject(new KeylessSignerError('signer response is missing ok=true'));
          return;
        }
        resolve(res);
      });
      child.stdin.end(payload);
    });
  }
}
