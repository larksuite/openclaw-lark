/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * @mention utilities for the Lark/Feishu channel plugin.
 *
 * All logic is based on `MentionInfo[]` from `MessageContext.mentions`.
 * Provides:
 * - Derive helpers: `mentionedBot()`, `nonBotMentions()`
 * - Format helpers for outbound text and card messages.
 */

import type { MentionInfo, MessageContext } from '../types';
import { escapeRegExp } from '../converters/utils';

export type { MentionInfo } from '../types';

// ---------------------------------------------------------------------------
// Derive helpers (work on MentionInfo[])
// ---------------------------------------------------------------------------

/**
 * Detect whether a raw mention entry represents @all / @所有人.
 *
 * Feishu @all mentions have `key: "@_all"` and empty ID fields.
 * We match on `key` as the primary signal (most stable across locales).
 */
export function isMentionAll(mention: { key: string }): boolean {
  return mention.key === '@_all';
}

/** Whether the receiving bot itself was @-mentioned. */
export function mentionedBot(ctx: MessageContext): boolean {
  return ctx.mentions.some((m) => m.isBot);
}

/** All mentions excluding the receiving bot itself. */
export function nonBotMentions(ctx: MessageContext): MentionInfo[] {
  return ctx.mentions.filter((m) => !m.isBot);
}

// ---------------------------------------------------------------------------
// extractMessageBody
// ---------------------------------------------------------------------------

/**
 * Remove all @mention placeholder keys from the message text.
 */
export function extractMessageBody(text: string, allMentionKeys: string[]): string {
  let result = text;
  for (const key of allMentionKeys) {
    result = result.replace(new RegExp(escapeRegExp(key) + '\\s*', 'g'), '');
  }
  return result.trim();
}

// ---------------------------------------------------------------------------
// Format helpers -- text messages
// ---------------------------------------------------------------------------

/**
 * Format a mention for a Feishu text / post message.
 * @returns e.g. `<at user_id="ou_xxx">Alice</at>`
 */
export function formatMentionForText(target: MentionInfo): string {
  return `<at user_id="${target.openId}">${target.name}</at>`;
}

/** Format an @everyone mention for text / post. */
export function formatMentionAllForText(): string {
  return `<at user_id="all">Everyone</at>`;
}

// ---------------------------------------------------------------------------
// Format helpers -- interactive card messages
// ---------------------------------------------------------------------------

/**
 * Format a mention for a Feishu Interactive Card.
 * @returns e.g. `<at id=ou_xxx></at>`
 */
export function formatMentionForCard(target: MentionInfo): string {
  return `<at id=${target.openId}></at>`;
}

/** Format an @everyone mention for card. */
export function formatMentionAllForCard(): string {
  return `<at id=all></at>`;
}

// ---------------------------------------------------------------------------
// Build helpers (prepend mentions to message body)
// ---------------------------------------------------------------------------

/** Prepend @mention tags (text format) to a message body. */
export function buildMentionedMessage(targets: MentionInfo[], message: string): string {
  if (targets.length === 0) return message;
  const mentionTags = targets.map(formatMentionForText).join(' ');
  return `${mentionTags}\n${message}`;
}

/** Prepend @mention tags (card format) to card markdown content. */
export function buildMentionedCardContent(targets: MentionInfo[], message: string): string {
  if (targets.length === 0) return message;
  const mentionTags = targets.map(formatMentionForCard).join(' ');
  return `${mentionTags}\n${message}`;
}

