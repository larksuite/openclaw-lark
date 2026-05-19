/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Plugin version management.
 *
 * Reads the version from package.json and builds the User-Agent string.
 *
 * IMPORTANT: this file MUST NOT contain a literal `import.meta` token.
 * Node 22+ detects ESM by scanning for ESM-only syntax (top-level
 * `import`/`export`, top-level `await`, or any `import.meta` reference). If a
 * downstream build pipeline emits this file with CommonJS-style `exports.*`
 * assignments while preserving the `import.meta` token in the source, Node
 * loads the file via the ESM loader, silently discarding every
 * `exports.*` assignment. The module then appears as an empty namespace and
 * every call site of `getUserAgent()` / `getPluginVersion()` throws
 * `TypeError: getUserAgent is not a function` at runtime.
 *
 * Strategy: inject the version string at build time via tsdown's `define`
 * (see `tsdown.config.ts`). A CJS-safe fallback reads `package.json` via
 * the CJS `__dirname` global for any compile path where the define is not
 * applied.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Build-time injected version. Undefined when the build step did not run. */
declare const __PLUGIN_VERSION__: string | undefined;

/** Cached version string. */
let cachedVersion: string | undefined;

/**
 * Return the plugin version. Build-time injection wins; otherwise read
 * `package.json` via the CJS `__dirname` global.
 *
 * @returns Version string such as "2026.5.13"; "unknown" on read failure.
 */
export function getPluginVersion(): string {
  if (cachedVersion) return cachedVersion;

  // Fast path: build-time injection (tsdown ESM output).
  // `typeof` on an undeclared identifier returns 'undefined' without throwing,
  // so this is safe under any compile target.
  if (typeof __PLUGIN_VERSION__ === 'string' && __PLUGIN_VERSION__) {
    cachedVersion = __PLUGIN_VERSION__;
    return cachedVersion;
  }

  // CJS fallback path. `__dirname` is provided by Node's CommonJS module
  // wrapper, so this branch only runs in CJS-compiled output. ESM-compiled
  // output always hits the fast path above.
  try {
    if (typeof __dirname !== 'string') {
      cachedVersion = 'unknown';
      return cachedVersion;
    }
    // Current file: src/core/version.ts → walk up two levels to repo root.
    const packageJsonPath = join(__dirname, '..', '..', 'package.json');
    const raw = readFileSync(packageJsonPath, 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    cachedVersion = pkg.version ?? 'unknown';
    return cachedVersion;
  } catch {
    cachedVersion = 'unknown';
    return cachedVersion;
  }
}

/**
 * 获取当前运行平台名称
 *
 * @returns `mac` | `linux` | `windows`
 */
export function getPlatform(): string {
  switch (process.platform) {
    case 'darwin':
      return 'mac';
    case 'win32':
      return 'windows';
    default:
      return 'linux';
  }
}

/**
 * 生成 User-Agent 字符串
 *
 * @returns User-Agent 字符串，格式：`openclaw-lark/{version}/{platform}`
 *
 * @example
 * ```typescript
 * getUserAgent() // => "openclaw-lark/2026.2.28.5/mac"
 * ```
 */
export function getUserAgent(): string {
  return `openclaw-lark/${getPluginVersion()}/${getPlatform()}`;
}
