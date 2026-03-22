/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Shared utilities for the reasoning display subsystem.
 */

export function normalizeToolName(name?: string): string {
  return name?.trim().toLowerCase() ?? '';
}

export function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}
