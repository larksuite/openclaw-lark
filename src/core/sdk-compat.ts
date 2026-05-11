/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Local shim for readReactionParams whose SDK signature changed in
 * 2026.3.14 (now requires a channel-specific config object).
 * Re-exports jsonResult from the SDK directly.
 */

export { jsonResult } from 'openclaw/plugin-sdk/agent-runtime';

const FEISHU_REACTION_ALIASES = new Map<string, string>([
  ['👍', 'THUMBSUP'],
  ['+1', 'THUMBSUP'],
  ['thumbsup', 'THUMBSUP'],
  ['thumbs_up', 'THUMBSUP'],
  ['thumbs-up', 'THUMBSUP'],
  ['👎', 'THUMBSDOWN'],
  ['-1', 'THUMBSDOWN'],
  ['thumbsdown', 'THUMBSDOWN'],
  ['thumbs_down', 'THUMBSDOWN'],
  ['thumbs-down', 'THUMBSDOWN'],
  ['👌', 'OK'],
  ['👏', 'APPLAUSE'],
  ['clap', 'APPLAUSE'],
  ['🔥', 'FIRE'],
  ['🚀', 'ROCKET'],
  ['❤️', 'LOVE'],
  ['❤', 'LOVE'],
  ['heart', 'LOVE'],
]);

export function normalizeReactionEmoji(emoji: string): string {
  const normalized = emoji.trim();
  if (!normalized) return '';
  return FEISHU_REACTION_ALIASES.get(normalized) ?? FEISHU_REACTION_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

/**
 * Extract reaction parameters from raw action params.
 * Returns emoji, remove flag, and isEmpty indicator.
 */
export function readReactionParams(
  params: Record<string, unknown>,
  opts?: { removeErrorMessage?: string },
): { emoji: string; remove: boolean; isEmpty: boolean } {
  const raw = params.emoji ?? params.reaction ?? params.type;
  const emoji = typeof raw === 'string' ? normalizeReactionEmoji(raw) : '';
  const remove = Boolean(params.remove ?? params.unreact);
  const isEmpty = !emoji && !remove;

  if (remove && !emoji && opts?.removeErrorMessage) {
    throw new Error(opts.removeErrorMessage);
  }

  return { emoji, remove, isEmpty };
}
