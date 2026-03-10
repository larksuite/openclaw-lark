/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Default values and resolution logic for the Feishu card footer configuration.
 *
 * Each boolean flag controls whether a particular metadata item is displayed
 * in the card footer (e.g. elapsed time, model name).
 */

import type { FeishuFooterConfig } from './types';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * The default footer configuration.
 *
 * By default all metadata items are hidden — neither status text
 * ("已完成" / "出错" / "已停止") nor elapsed time are shown.
 */
export const DEFAULT_FOOTER_CONFIG: Required<FeishuFooterConfig> = {
  status: false,
  elapsed: false,
};

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Merge a partial footer configuration with `DEFAULT_FOOTER_CONFIG`.
 *
 * Fields present in the input take precedence; anything absent falls back
 * to the default value.
 */
export function resolveFooterConfig(cfg?: FeishuFooterConfig): Required<FeishuFooterConfig> {
  if (!cfg) return { ...DEFAULT_FOOTER_CONFIG };
  return {
    status: cfg.status ?? DEFAULT_FOOTER_CONFIG.status,
    elapsed: cfg.elapsed ?? DEFAULT_FOOTER_CONFIG.elapsed,
  };
}
