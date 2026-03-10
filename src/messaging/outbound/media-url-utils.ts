/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export function normalizeMediaUrlInput(value: string): string {
  let raw = value.trim();

  // Common wrappers from markdown/chat payloads.
  if (raw.startsWith('<') && raw.endsWith('>') && raw.length >= 2) {
    raw = raw.slice(1, -1).trim();
  }

  // Strip matching surrounding quotes/backticks.
  const first = raw[0];
  const last = raw[raw.length - 1];
  if (
    raw.length >= 2 &&
    ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === '`' && last === '`'))
  ) {
    raw = raw.slice(1, -1).trim();
  }

  return raw;
}

function stripQueryAndHash(value: string): string {
  return value.split(/[?#]/, 1)[0] ?? value;
}

export function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

export function isLocalMediaPath(value: string): boolean {
  const raw = normalizeMediaUrlInput(value);
  return raw.startsWith('file://') || path.isAbsolute(raw) || isWindowsAbsolutePath(raw);
}

export function safeFileUrlToPath(fileUrl: string): string {
  const raw = normalizeMediaUrlInput(fileUrl);
  try {
    return fileURLToPath(raw);
  } catch {
    return new URL(raw).pathname;
  }
}

/**
 * Validate that a resolved local file path falls under one of the
 * allowed root directories.  Prevents path-traversal attacks when
 * the AI or an external payload supplies a local media path.
 *
 * Semantics:
 * - **`undefined`** — caller has not opted in to restriction; the
 *   function is a no-op so existing behaviour is preserved.  The
 *   caller should log a warning independently.
 * - **`[]` (empty array)** — explicitly configured with no allowed
 *   roots → all local access is denied.
 * - **Non-empty array** — standard allowlist check.
 *
 * @param filePath   - Resolved absolute path to validate.
 * @param localRoots - Allowed root directories.
 * @throws {Error} When the path is not under any allowed root, or
 *                 when `localRoots` is an empty array.
 */
export function validateLocalMediaRoots(filePath: string, localRoots: readonly string[] | undefined): void {
  // Not configured — skip validation (backwards-compatible).
  if (localRoots === undefined) return;

  if (localRoots.length === 0) {
    throw new Error(
      `[feishu-media] Local file access denied for "${filePath}": ` +
        `mediaLocalRoots is configured as an empty array, which blocks all local access. ` +
        `Add allowed directories to mediaLocalRoots or use a remote URL instead.`,
    );
  }

  // Resolve symlinks to prevent traversal via symlinked paths.
  // Fall back to path.resolve when the file does not exist yet — the
  // subsequent readFileSync will report a clear "file not found" error.
  let resolved: string;
  try {
    resolved = fs.realpathSync(path.resolve(filePath));
  } catch {
    resolved = path.resolve(filePath);
  }

  const isAllowed = localRoots.some((root) => {
    let resolvedRoot: string;
    try {
      resolvedRoot = fs.realpathSync(path.resolve(root));
    } catch {
      resolvedRoot = path.resolve(root);
    }
    // Must be exactly the root or strictly inside it (with separator).
    return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
  });

  if (!isAllowed) {
    throw new Error(
      `[feishu-media] Local file access denied for "${filePath}": ` +
        `path is not under any allowed mediaLocalRoots (${localRoots.join(', ')}). ` +
        `Move the file to an allowed directory or use a remote URL instead.`,
    );
  }
}

export function resolveBaseNameFromPath(value: string): string | undefined {
  const raw = normalizeMediaUrlInput(value);
  const cleanPath = stripQueryAndHash(raw);
  const fileName = isWindowsAbsolutePath(cleanPath) ? path.win32.basename(cleanPath) : path.basename(cleanPath);
  if (fileName && fileName !== '/' && fileName !== '.' && fileName !== '\\') {
    return fileName;
  }
  return undefined;
}

export function resolveFileNameFromMediaUrl(mediaUrl: string): string | undefined {
  const raw = normalizeMediaUrlInput(mediaUrl);
  if (!raw) return undefined;

  if (isLocalMediaPath(raw)) {
    if (raw.startsWith('file://')) {
      const fromFileUrlPath = safeFileUrlToPath(raw);
      const fromFileUrlName = resolveBaseNameFromPath(fromFileUrlPath);
      if (fromFileUrlName) return fromFileUrlName;
    }
    return resolveBaseNameFromPath(raw);
  }

  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      const fromUrlPath = path.posix.basename(parsed.pathname);
      if (fromUrlPath && fromUrlPath !== '/') return fromUrlPath;
    }
  } catch {
    // Not a valid URL. Continue with file path fallback.
  }

  return resolveBaseNameFromPath(raw);
}
