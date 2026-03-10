/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * UAT (User Access Token) persistent storage with cross-platform support.
 *
 * Stores OAuth token data using OS-native credential services so that tokens
 * survive process restarts without introducing plain-text local files.
 *
 * Platform backends:
 *   macOS   – Keychain Access via `security` CLI
 *   Linux   – AES-256-GCM encrypted files (XDG_DATA_HOME)
 *   Windows – AES-256-GCM encrypted files (%LOCALAPPDATA%)
 *
 * Storage layout:
 *   Service  = "openclaw-feishu-uat"
 *   Account  = "{appId}:{userOpenId}"
 *   Password = JSON-serialised StoredUAToken
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, unlink, readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { larkLogger } from './lark-logger';

const log = larkLogger('core/token-store');

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StoredUAToken {
  userOpenId: string;
  appId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix ms – access_token expiry
  refreshExpiresAt: number; // Unix ms – refresh_token expiry
  scope: string;
  grantedAt: number; // Unix ms – original grant time
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KEYCHAIN_SERVICE = 'openclaw-feishu-uat';

/** Refresh proactively when access_token expires within this window. */
const REFRESH_AHEAD_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function accountKey(appId: string, userOpenId: string): string {
  return `${appId}:${userOpenId}`;
}

/** Mask a token for safe logging: only the last 4 chars are visible. */
export function maskToken(token: string): string {
  if (token.length <= 8) return '****';
  return `****${token.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Backend interface
// ---------------------------------------------------------------------------

interface KeychainBackend {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, data: string): Promise<void>;
  remove(service: string, account: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// macOS backend – Keychain Access via `security` CLI
// ---------------------------------------------------------------------------

const darwinBackend: KeychainBackend = {
  async get(service, account) {
    try {
      const { stdout } = await execFile('security', ['find-generic-password', '-s', service, '-a', account, '-w']);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  },

  async set(service, account, data) {
    // Delete first – `add-generic-password` fails if the item already exists.
    try {
      await execFile('security', ['delete-generic-password', '-s', service, '-a', account]);
    } catch {
      // Not found – fine.
    }
    await execFile('security', ['add-generic-password', '-s', service, '-a', account, '-w', data]);
  },

  async remove(service, account) {
    try {
      await execFile('security', ['delete-generic-password', '-s', service, '-a', account]);
    } catch {
      // Already absent – fine.
    }
  },
};

// ---------------------------------------------------------------------------
// Linux backend – AES-256-GCM encrypted files (XDG Base Directory)
//
// Headless Linux servers typically lack D-Bus / GNOME Keyring, so we store
// tokens as AES-256-GCM encrypted files instead of using `secret-tool`.
//
// Storage path: ${XDG_DATA_HOME:-~/.local/share}/openclaw-feishu-uat/
// ---------------------------------------------------------------------------

const LINUX_UAT_DIR = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'openclaw-feishu-uat');
const MASTER_KEY_PATH = join(LINUX_UAT_DIR, 'master.key');
const MASTER_KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM recommended
const TAG_BYTES = 16; // GCM auth tag

/** Convert account key to a filesystem-safe filename. */
function linuxSafeFileName(account: string): string {
  return account.replace(/[^a-zA-Z0-9._-]/g, '_') + '.enc';
}

/** Ensure the credentials directory exists with mode 0700. */
async function ensureLinuxCredDir(): Promise<void> {
  await mkdir(LINUX_UAT_DIR, { recursive: true, mode: 0o700 });
}

/**
 * Load or create the 32-byte master key.
 *
 * On first run, generates a random key and writes it to disk (mode 0600).
 * On subsequent runs, reads the existing key file.
 */
async function getMasterKey(): Promise<Buffer> {
  try {
    const key = await readFile(MASTER_KEY_PATH);
    if (key.length === MASTER_KEY_BYTES) return key;
    log.warn('master key has unexpected length, regenerating');
  } catch (err: unknown) {
    if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`failed to read master key: ${err instanceof Error ? err.message : err}`);
    }
  }

  await ensureLinuxCredDir();
  const key = randomBytes(MASTER_KEY_BYTES);
  await writeFile(MASTER_KEY_PATH, key, { mode: 0o600 });
  await chmod(MASTER_KEY_PATH, 0o600);
  log.info('generated new master key for encrypted file storage');
  return key;
}

/** AES-256-GCM encrypt. Returns [12-byte IV][16-byte tag][ciphertext]. */
function encryptData(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

/** AES-256-GCM decrypt. Returns plaintext or `null` on failure. */
function decryptData(data: Buffer, key: Buffer): string | null {
  if (data.length < IV_BYTES + TAG_BYTES) return null;
  try {
    const iv = data.subarray(0, IV_BYTES);
    const tag = data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const enc = data.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

const linuxBackend: KeychainBackend = {
  async get(_service, account) {
    try {
      const key = await getMasterKey();
      const data = await readFile(join(LINUX_UAT_DIR, linuxSafeFileName(account)));
      return decryptData(data, key);
    } catch {
      return null;
    }
  },

  async set(_service, account, data) {
    const key = await getMasterKey();
    await ensureLinuxCredDir();
    const filePath = join(LINUX_UAT_DIR, linuxSafeFileName(account));
    const encrypted = encryptData(data, key);
    await writeFile(filePath, encrypted, { mode: 0o600 });
    await chmod(filePath, 0o600);
  },

  async remove(_service, account) {
    try {
      await unlink(join(LINUX_UAT_DIR, linuxSafeFileName(account)));
    } catch {
      // Already absent – fine.
    }
  },
};

// ---------------------------------------------------------------------------
// Windows backend – AES-256-GCM encrypted files
//
// Replaces the previous DPAPI-via-PowerShell approach which was unreliable
// (PowerShell cold-start latency, execution policy restrictions, cmd.exe
// command-line length limits, and unavailability in containers).
//
// Uses the same AES-256-GCM scheme as the Linux backend with its own
// independent storage directory and master key.
//
// Storage path: %LOCALAPPDATA%\openclaw-feishu-uat\
// ---------------------------------------------------------------------------

const WIN32_UAT_DIR = join(
  process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? homedir(), 'AppData', 'Local'),
  KEYCHAIN_SERVICE,
);
const WIN32_MASTER_KEY_PATH = join(WIN32_UAT_DIR, 'master.key');

/** Convert account key to a filesystem-safe filename (whitelist approach). */
function win32SafeFileName(account: string): string {
  return account.replace(/[^a-zA-Z0-9._-]/g, '_') + '.enc';
}

async function ensureWin32CredDir(): Promise<void> {
  await mkdir(WIN32_UAT_DIR, { recursive: true });
}

async function getWin32MasterKey(): Promise<Buffer> {
  try {
    const key = await readFile(WIN32_MASTER_KEY_PATH);
    if (key.length === MASTER_KEY_BYTES) return key;
    log.warn('win32 master key has unexpected length, regenerating');
  } catch (err: unknown) {
    if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`failed to read win32 master key: ${err instanceof Error ? err.message : err}`);
    }
  }

  await ensureWin32CredDir();
  const key = randomBytes(MASTER_KEY_BYTES);
  await writeFile(WIN32_MASTER_KEY_PATH, key);
  log.info('generated new master key for win32 encrypted file storage');
  return key;
}

const win32Backend: KeychainBackend = {
  async get(_service, account) {
    try {
      const key = await getWin32MasterKey();
      const data = await readFile(join(WIN32_UAT_DIR, win32SafeFileName(account)));
      return decryptData(data, key);
    } catch {
      return null;
    }
  },

  async set(_service, account, data) {
    const key = await getWin32MasterKey();
    await ensureWin32CredDir();
    const filePath = join(WIN32_UAT_DIR, win32SafeFileName(account));
    const encrypted = encryptData(data, key);
    await writeFile(filePath, encrypted);
  },

  async remove(_service, account) {
    try {
      await unlink(join(WIN32_UAT_DIR, win32SafeFileName(account)));
    } catch {
      // Already absent – fine.
    }
  },
};

// ---------------------------------------------------------------------------
// Platform selection
// ---------------------------------------------------------------------------

function createBackend(): KeychainBackend {
  switch (process.platform) {
    case 'darwin':
      return darwinBackend;
    case 'linux':
      return linuxBackend;
    case 'win32':
      return win32Backend;
    default:
      log.warn(`unsupported platform "${process.platform}", falling back to macOS backend`);
      return darwinBackend;
  }
}

const backend = createBackend();

// ---------------------------------------------------------------------------
// Public API – Credential operations
// ---------------------------------------------------------------------------

/**
 * Read the stored UAT for a given (appId, userOpenId) pair.
 * Returns `null` when no entry exists or the payload is unparseable.
 */
export async function getStoredToken(appId: string, userOpenId: string): Promise<StoredUAToken | null> {
  try {
    const json = await backend.get(KEYCHAIN_SERVICE, accountKey(appId, userOpenId));
    if (!json) return null;
    return JSON.parse(json) as StoredUAToken;
  } catch {
    return null;
  }
}

/**
 * Persist a UAT using the platform credential store.
 *
 * Overwrites any existing entry for the same (appId, userOpenId).
 */
export async function setStoredToken(token: StoredUAToken): Promise<void> {
  const key = accountKey(token.appId, token.userOpenId);
  const payload = JSON.stringify(token);
  await backend.set(KEYCHAIN_SERVICE, key, payload);
  log.info(`saved UAT for ${token.userOpenId} (at:${maskToken(token.accessToken)})`);
}

/**
 * Remove a stored UAT from the credential store.
 */
export async function removeStoredToken(appId: string, userOpenId: string): Promise<void> {
  await backend.remove(KEYCHAIN_SERVICE, accountKey(appId, userOpenId));
  log.info(`removed UAT for ${userOpenId}`);
}

// ---------------------------------------------------------------------------
// Token validity check
// ---------------------------------------------------------------------------

/**
 * Determine the freshness of a stored token.
 *
 * - `"valid"`         – access_token is still good (expires > 5 min from now)
 * - `"needs_refresh"` – access_token expired/expiring but refresh_token is valid
 * - `"expired"`       – both tokens are expired; re-authorization required
 */
export function tokenStatus(token: StoredUAToken): 'valid' | 'needs_refresh' | 'expired' {
  const now = Date.now();
  if (now < token.expiresAt - REFRESH_AHEAD_MS) {
    return 'valid';
  }
  if (now < token.refreshExpiresAt) {
    return 'needs_refresh';
  }
  return 'expired';
}
