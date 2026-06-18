/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Outbound mention normalization + bot-peer @-mention enforcement.
 *
 * Why this exists: in Feishu groups, a bot only receives a message when
 * something explicitly @-mentions its open_id with a structured `<at>`
 * element. LLM outputs come in many "natural" @-shapes (markdown, angle
 * brackets, template syntax) but none of them satisfy the delivery rule —
 * only `<at user_id="ou_xxx">Name</at>` does. This module:
 *
 *   1. `normalizeOutboundMentions` — rewrites the six common LLM shapes
 *      into the standard `<at>` element when the name resolves via the
 *      per-chat mention-registry. Unknown names are left as plain text
 *      (a recipient who's never spoken in this chat can't be @-mentioned).
 *
 *   2. `ensureMention` — in bot→bot group scenarios, the agent reply must
 *      include an explicit @ of the peer bot or the peer never receives
 *      it. When the LLM forgets to add one, prepend it as a safety net.
 *
 * Both are idempotent: existing standard `<at>` elements are preserved,
 * and `ensureMention` is a no-op when the peer is already mentioned.
 */

import { lookupByName } from '../inbound/mention-registry';

const STANDARD_AT_RE = /<at\s+user_id="[^"]*">[^<]*<\/at>/g;

// LLM-produced mention shapes (in priority order — first match wins).
// Each pattern captures the display name; the runner consults the registry
// for an openId before rewriting, and leaves the original text untouched
// when the name doesn't resolve.
//
// Plain `@Name` is intentionally last because the more decorated variants
// embed an `@` and we want them to claim ownership of their match first.
const VARIANT_PATTERNS: { re: RegExp; group: number }[] = [
  { re: /@\[([^\]\n]+)\]/g, group: 1 },        // @[Name]
  { re: /@<([^>\n]+)>/g, group: 1 },           // @<Name>
  { re: /<@([^>\n]+)>/g, group: 1 },           // <@Name>
  { re: /<at>\s*([^<\n]+?)\s*<\/at>/g, group: 1 }, // <at>Name</at>
  { re: /\{\{\s*([^}\n]+?)\s*\}\}/g, group: 1 },   // {{Name}}
  // Plain @Name — single token, ASCII/CJK/digit/underscore. Won't match
  // mid-word (preceded by a word char), so email addresses are safe.
  { re: /(^|[^\w@])@([A-Za-z0-9_一-鿿][\w.一-鿿-]{0,30})/g, group: 2 },
];

/**
 * Rewrite LLM-emitted mention shapes into the standard `<at user_id="…">`
 * element used by Feishu for guaranteed delivery. Unknown names — those
 * whose display name isn't in the per-chat registry — are left intact as
 * plain text so the agent's wording survives even when delivery cannot
 * fire.
 */
export function normalizeOutboundMentions(text: string, chatId: string): string {
  if (!text || !chatId) return text;

  // Step 1: mask out already-standard <at> elements so the variant patterns
  //         below never re-match them.
  const protectedTokens: string[] = [];
  let masked = text.replace(STANDARD_AT_RE, (m) => {
    const idx = protectedTokens.push(m) - 1;
    return `\x00P${idx}\x00`;
  });

  // Step 2: apply variant patterns in declared priority.
  for (const { re, group } of VARIANT_PATTERNS) {
    masked = masked.replace(re, (...args: unknown[]) => {
      const match = args[0] as string;
      const groups = args.slice(1, args.length - 2) as string[];
      const name = (groups[group - 1] ?? '').trim();
      if (!name) return match;
      const openId = lookupByName(chatId, name);
      if (!openId) return match;
      const standardAt = `<at user_id="${openId}">${name}</at>`;
      // For the plain-@Name pattern we captured a leading word boundary in
      // group 1 — preserve it. Other patterns matched the @-shape exactly.
      if (group === 2) {
        const leading = groups[0] ?? '';
        return `${leading}${standardAt}`;
      }
      return standardAt;
    });
  }

  // Step 3: restore protected tokens. The \x00 sentinels are intentional
  // private-use markers that never appear in real Feishu text.
  // eslint-disable-next-line no-control-regex
  return masked.replace(/\x00P(\d+)\x00/g, (_, idx) => protectedTokens[Number(idx)]);
}

/**
 * Ensure the reply explicitly @-mentions the given peer.
 *
 * Designed for bot↔bot group flows: when the peer is another bot, Feishu
 * won't deliver the message unless an `<at user_id="ou_peer">` element is
 * present somewhere in the text. If the LLM already mentioned the peer,
 * no-op; otherwise, prepend a standard `<at>` so the peer wakes up.
 */
export function ensureMention(
  text: string,
  peerOpenId: string,
  peerName: string,
): string {
  if (!peerOpenId) return text;
  // Already-mentioned check — match any existing <at user_id="ou_peer">
  // element regardless of the rendered name to preserve idempotency.
  const escaped = peerOpenId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const existingRe = new RegExp(`<at\\s+user_id="${escaped}">[^<]*<\\/at>`);
  if (existingRe.test(text)) return text;

  const standardAt = `<at user_id="${peerOpenId}">${peerName || peerOpenId}</at>`;
  if (!text || !text.trim()) return standardAt;
  return `${standardAt} ${text}`;
}
