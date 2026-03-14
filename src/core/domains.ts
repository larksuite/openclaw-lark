/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Centralized domain helpers for Feishu / Lark brand-aware URL generation.
 *
 * All runtime code that needs to construct platform URLs should use these
 * helpers instead of hardcoding domain strings.
 */

import type { LarkBrand } from './types';

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

/** 开放平台域名 (API & 权限管理页面) */
export function openPlatformDomain(brand?: LarkBrand): string {
  return brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
}

/** Applink 域名 */
export function applinkDomain(brand?: LarkBrand): string {
  return brand === 'lark' ? 'https://applink.larksuite.com' : 'https://applink.feishu.cn';
}

/** 主站域名 (文档、表格等用户可见链接) */
export function wwwDomain(brand?: LarkBrand): string {
  return brand === 'lark' ? 'https://www.larksuite.com' : 'https://www.feishu.cn';
}

/** MCP 服务域名 */
export function mcpDomain(brand?: LarkBrand): string {
  return brand === 'lark' ? 'https://mcp.larksuite.com' : 'https://mcp.feishu.cn';
}
