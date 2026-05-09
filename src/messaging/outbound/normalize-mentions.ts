/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Outbound mention normalizer for Feishu post messages. Rewrites <at>
 * tag variants and resolves "@Name" to the canonical
 * <at user_id="ou_xxx">Name</at> form expected by the Feishu API.
 */

import type { LarkAccount } from '../../core/types';
import { getUserNameCache, prefetchChatBots, prefetchChatMembers } from '../inbound/user-name-cache';
import type { PrincipalKind } from '../inbound/user-name-cache-store';

/**
 * Rewrites <at> tag attribute and quote variants to the canonical
 * `<at user_id="ou_xxx">` form. Idempotent; pure string transform.
 *
 * Recognized variants: `id=`, `open_id=`, `user_id=`; double-quoted,
 * single-quoted, or unquoted; `id=all` aligned to `user_id="all"` with
 * "Everyone" name fill. `<person>` picker tags are left untouched.
 */
export function normalizeOutboundMentionsTagPass(text: string): string {
  let out = text;

  // <at id=all|user_id="all"|...></at> → <at user_id="all">Everyone</at>.
  // Match an explicit closing tag so already-canonical input stays
  // idempotent: a bare opening tag would match the optional-close form
  // and corrupt the trailing "Everyone</at>" into a double close.
  out = out.replace(
    /<at\s+(?:id|user_id|open_id)\s*=\s*["']?all["']?\s*>\s*<\/at>/gi,
    '<at user_id="all">Everyone</at>',
  );

  // Generic <at attr=ou_xxx> → <at user_id="ou_xxx">.
  out = out.replace(
    /<at\s+(?:id|open_id|user_id)\s*=\s*["']?(ou_[A-Za-z0-9_-]+)["']?\s*>/gi,
    '<at user_id="$1">',
  );

  return out;
}

export type LogFn = (...args: unknown[]) => void;

export interface NormalizeContext {
  /** Chat where the message will be sent; keys lazy chat-member fetches. */
  chatId: string;
  account: LarkAccount;
  /** Optional sink for prefetch errors during normalization. */
  log?: LogFn;
}

export interface SentinelEntry {
  name: string;
  reason: 'not_found' | 'ambiguous';
  candidates?: Array<{ openId: string; kind?: PrincipalKind }>;
}

export interface NormalizeResult {
  normalizedText: string;
  sentinels: SentinelEntry[];
}

interface PendingMiss {
  start: number;
  end: number;
  name: string;
}

interface Replacement {
  start: number;
  end: number;
  text: string;
}

const noopLog: LogFn = () => {};

/** Spans excluded from the @Name scan: code, canonical tags, emails, URLs. */
const MASK_PATTERNS: RegExp[] = [
  /```[\s\S]*?```/g,
  /`[^`\n]*`/g,
  /<at\s+user_id="[^"]+">[^<]*<\/at>/g,
  /<person\s+[^>]*>[^<]*<\/person>/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /\b(?:https?|ftp|mailto):\/\/[^\s)\]<>]+/g,
];

// CJK range U+4E00–U+9FA5 covers ideographs so multibyte names match.
const CANDIDATE_RE = /@([A-Za-z0-9\u4e00-\u9fa5_]+(?:[.-][A-Za-z0-9\u4e00-\u9fa5_]+)*)/g;

/** Lazy-fetch fallbacks tried in order on cache miss. */
type Prefetch = (account: LarkAccount, chatId: string, log: LogFn) => Promise<void>;
const FALLBACK_PREFETCHES: Prefetch[] = [prefetchChatBots, prefetchChatMembers];

/**
 * Normalizes outbound text for Feishu: rewrites <at> tag variants and
 * resolves plain "@Name" against the per-account name cache.
 *
 * On cache miss, fetches the chat's bot list and retries; if still
 * unresolved, fetches the chat's member list and retries. Names that
 * match multiple cache entries become ambiguous sentinels for next-turn
 * disambiguation; remaining misses are dropped without a sentinel to
 * avoid false positives on `@` followed by non-name CJK runs.
 */
export async function normalizeOutboundMentions(
  text: string,
  ctx: NormalizeContext,
): Promise<NormalizeResult> {
  let out = normalizeOutboundMentionsTagPass(text);

  // Drop redundant `@` immediately preceding a canonical <at> tag.
  out = out.replace(/@(<at\s+user_id="ou_[A-Za-z0-9_-]+">[^<]*<\/at>)/g, '$1');

  const inMask = buildMaskPredicate(out);
  const sentinels: SentinelEntry[] = [];
  const replacements: Replacement[] = [];

  // First sweep: resolve from cache; defer misses for lazy fetch.
  let pending: PendingMiss[] = [];
  for (const m of out.matchAll(CANDIDATE_RE)) {
    const start = m.index!;
    if (inMask(start)) continue;
    const end = start + m[0].length;
    const r = resolveCandidate(m[1], ctx);
    if (r.kind === 'resolved') {
      replacements.push(makeReplacement(start, end, r));
    } else if (r.entry.reason === 'ambiguous') {
      sentinels.push(r.entry);
    } else {
      pending.push({ start, end, name: m[1] });
    }
  }

  // Retry through each fallback in turn; remaining misses are dropped.
  for (const prefetch of FALLBACK_PREFETCHES) {
    if (pending.length === 0) break;
    pending = await retryWithPrefetch(pending, prefetch, ctx, replacements, sentinels);
  }

  return { normalizedText: applyReplacements(out, replacements), sentinels };
}

function buildMaskPredicate(text: string): (idx: number) => boolean {
  const masks: Array<[number, number]> = [];
  for (const re of MASK_PATTERNS) {
    for (const m of text.matchAll(re)) {
      masks.push([m.index!, m.index! + m[0].length]);
    }
  }
  return (idx) => masks.some(([s, e]) => idx >= s && idx < e);
}

function makeReplacement(
  start: number,
  end: number,
  r: ResolvedCandidate,
): Replacement {
  return { start, end, text: `<at user_id="${r.openId}">${r.displayName}</at>` };
}

async function retryWithPrefetch(
  pending: PendingMiss[],
  prefetch: Prefetch,
  ctx: NormalizeContext,
  replacements: Replacement[],
  sentinels: SentinelEntry[],
): Promise<PendingMiss[]> {
  await prefetch(ctx.account, ctx.chatId, ctx.log ?? noopLog);
  const stillMissing: PendingMiss[] = [];
  for (const p of pending) {
    const r = resolveCandidate(p.name, ctx);
    if (r.kind === 'resolved') {
      replacements.push(makeReplacement(p.start, p.end, r));
    } else if (r.entry.reason === 'ambiguous') {
      sentinels.push(r.entry);
    } else {
      stillMissing.push(p);
    }
  }
  return stillMissing;
}

/**
 * Applies non-overlapping replacements in a single left-to-right pass.
 * Builds an array of literal chunks then joins it once — O(n + total
 * replacement length), no string-concat quadratic behavior.
 */
function applyReplacements(text: string, replacements: Replacement[]): string {
  if (replacements.length === 0) return text;
  const sorted = [...replacements].sort((a, b) => a.start - b.start);
  const out: string[] = [];
  let cursor = 0;
  for (const r of sorted) {
    if (r.start < cursor) continue; // drop overlapping replacements defensively
    out.push(text.slice(cursor, r.start), r.text);
    cursor = r.end;
  }
  out.push(text.slice(cursor));
  return out.join('');
}

interface ResolvedCandidate {
  kind: 'resolved';
  openId: string;
  displayName: string;
}

type CandidateResolution = ResolvedCandidate | { kind: 'sentinel'; entry: SentinelEntry };

/**
 * Aliases for "mention everyone" that may appear as plain text instead
 * of the canonical `<at user_id="all">` tag. Match is case-insensitive.
 */
const ALL_ALIASES = new Set(['all', 'everyone', '所有人']);

function resolveCandidate(name: string, ctx: NormalizeContext): CandidateResolution {
  // Literal @-everyone aliases map to the canonical Feishu @all tag,
  // bypassing the per-account name cache. The display name "Everyone"
  // matches what the tag-level normalizer fills in for empty <at> bodies.
  if (ALL_ALIASES.has(name.toLowerCase())) {
    return { kind: 'resolved', openId: 'all', displayName: 'Everyone' };
  }

  const cache = getUserNameCache(ctx.account.accountId);
  const matches = cache.lookupByName(name);
  if (matches.length === 1) {
    return { kind: 'resolved', openId: matches[0].openId, displayName: matches[0].name };
  }
  if (matches.length > 1) {
    return {
      kind: 'sentinel',
      entry: {
        name,
        reason: 'ambiguous',
        candidates: matches.map((m) => ({ openId: m.openId, kind: m.kind })),
      },
    };
  }
  return { kind: 'sentinel', entry: { name, reason: 'not_found' } };
}
