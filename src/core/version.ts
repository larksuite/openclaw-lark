/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * 插件版本号管理
 *
 * 从 package.json 读取版本号并生成 User-Agent 字符串。
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

/** 缓存的版本号 */
let cachedVersion: string | undefined;

/**
 * 获取插件版本号（从 package.json 读取）
 *
 * @returns 版本号字符串，如 "2026.2.28.5"；读取失败返回 "unknown"
 */
export function getPluginVersion(): string {
  if (cachedVersion) return cachedVersion;

  try {
    // Source: src/core/version.ts → ../../package.json; tsdown bundle: dist/*.mjs → ../package.json
    const here = dirname(fileURLToPath(import.meta.url));
    for (const rel of [['..'], ['..', '..']]) {
      try {
        const pkg = JSON.parse(readFileSync(join(here, ...rel, 'package.json'), 'utf8')) as {
          name?: string;
          version?: string;
        };
        if (pkg.name !== '@larksuite/openclaw-lark' || !pkg.version) continue;
        cachedVersion = pkg.version;
        return cachedVersion;
      } catch {
        // try next candidate
      }
    }
    cachedVersion = 'unknown';
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
