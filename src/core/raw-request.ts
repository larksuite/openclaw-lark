/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * raw-request.ts — 飞书 Open API 裸 HTTP 请求工具。
 *
 * 从 tool-client.ts 提取，提供不依赖 SDK 的直接 API 调用能力。
 * 用于 SDK 未覆盖的 API 或需要精细控制请求的场景。
 */

import type { LarkBrand } from './types';
import { feishuFetch } from './feishu-fetch';

// ---------------------------------------------------------------------------
// Domain URL resolution
// ---------------------------------------------------------------------------

/** 将 LarkBrand 映射为 API base URL。 */
export function resolveDomainUrl(brand: LarkBrand): string {
  const map: Record<string, string> = {
    feishu: 'https://open.feishu.cn',
    lark: 'https://open.larksuite.com',
  };
  return map[brand] ?? `https://${brand}`;
}

// ---------------------------------------------------------------------------
// Raw HTTP request
// ---------------------------------------------------------------------------

export interface RawLarkRequestOptions {
  brand: LarkBrand;
  path: string;
  method?: string;
  body?: unknown;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  accessToken?: string;
}

/**
 * 发起 raw HTTP 请求到飞书 API，自动处理域名解析、header 注入和错误检测。
 *
 * 飞书 API 统一错误模式：返回 JSON 中 `code !== 0` 表示失败。
 */
export async function rawLarkRequest<T>(options: RawLarkRequestOptions): Promise<T> {
  const baseUrl = resolveDomainUrl(options.brand);
  const url = new URL(options.path, baseUrl);
  if (options.query) {
    for (const [k, v] of Object.entries(options.query)) {
      url.searchParams.set(k, v);
    }
  }

  const headers: Record<string, string> = {};
  if (options.accessToken) {
    headers['Authorization'] = `Bearer ${options.accessToken}`;
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (options.headers) {
    Object.assign(headers, options.headers);
  }

  const resp = await feishuFetch(url.toString(), {
    method: options.method ?? 'GET',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (await resp.json()) as any;

  // 飞书 API 统一错误模式：code !== 0
  if (data.code !== undefined && data.code !== 0) {
    const err = new Error(data.msg ?? `Lark API error: code=${data.code}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (err as any).code = data.code;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (err as any).msg = data.msg;
    throw err;
  }

  return data as T;
}
