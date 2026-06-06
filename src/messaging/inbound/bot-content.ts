/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Reply-routing decisions for the Feishu dispatch path.
 *
 * In bot-to-bot group scenarios, Feishu will pull thread-style replies into
 * a hidden "topic view" that group members cannot see (#32980). The peer bot
 * keeps receiving messages but humans in the chat see nothing — a silent
 * failure mode that turns bot↔bot chat into a black hole.
 *
 * This module centralizes the three signals that decide where a reply lands:
 *   1. isGroup            — DMs never have the topic-view trap
 *   2. senderIsBot        — only bot→bot triggers it
 *   3. dc.isThread        — inbound was a thread reply (also inferred from
 *                            root_id in topic groups when threadSession=true)
 *
 * Output: a routing object consumed by every outbound call site (main
 * dispatcher + i18n command card + i18n command text fallback), so the
 * three call sites never drift out of sync again.
 */

import { isThreadCapableGroup } from '../../core/chat-info-cache';
import { larkLogger } from '../../core/lark-logger';
import type { MentionInfo } from '../types';
import type { DispatchContext } from './dispatch-context';

const log = larkLogger('inbound/bot-content');

/** The peer a reply must explicitly @-mention so it actually reaches them. */
export interface BotPeerTarget {
  peerOpenId: string;
  peerName: string;
}

/**
 * Decide which peer (if any) an outbound reply must be guaranteed to
 * @-mention, so the deterministic `ensureMention` backstop can wake them up.
 *
 * Deliberately INDEPENDENT of `suppressForBotPeer` (which only governs
 * thread-vs-main routing): the addressee must be resolvable even on a
 * human-orchestrated kickoff, where the triggering sender is a person but the
 * conversation is meant to continue between bots.
 *
 *   1. Bot sender  → @ the sender back, continuing the exchange.
 *   2. Otherwise (e.g. a human kicking off a bot debate) → if the inbound
 *      message @-mentions exactly ONE party other than ourselves, treat that
 *      party as the designated peer. Zero / multiple non-self mentions are
 *      ambiguous, so we add no forced @ (avoids spamming unrelated members).
 *
 * Group-only: bot-at-bot @ delivery semantics don't apply to DMs.
 */
export function resolveBotPeerForMention(params: {
  isGroup: boolean;
  senderIsBot?: boolean;
  senderId?: string;
  senderName?: string;
  mentions: MentionInfo[];
  botOpenId?: string;
}): BotPeerTarget | undefined {
  if (!params.isGroup) return undefined;

  // 1. Bot sender → keep the ping-pong going by @-ing them back.
  if (params.senderIsBot && params.senderId) {
    return { peerOpenId: params.senderId, peerName: params.senderName ?? params.senderId };
  }

  // 2. Human-orchestrated kickoff → the single non-self @-mentioned party.
  const seen = new Set<string>();
  const others: MentionInfo[] = [];
  for (const m of params.mentions) {
    if (!m.openId || m.isBot || m.openId === params.botOpenId) continue;
    if (seen.has(m.openId)) continue;
    seen.add(m.openId);
    others.push(m);
  }
  if (others.length === 1) {
    return { peerOpenId: others[0].openId, peerName: others[0].name || others[0].openId };
  }
  return undefined;
}

export interface FeishuReplyRouting {
  /** Whether to send the reply as a thread-scoped message. */
  replyInThread: boolean;
  /** Effective thread_id when replying in-thread; undefined otherwise. */
  threadId: string | undefined;
  /** True when the peer is a bot in a group chat: suppress thread-mode reply
   *  so the message lands in the main chat (avoiding the hidden topic view,
   *  #32980). Consumers may also use this signal for additional bot-peer-
   *  specific behavior (e.g. ensureMention in outbound-mention). */
  suppressForBotPeer: boolean;
}

/**
 * Resolve reply routing for the current dispatch, performing two tasks:
 *
 *  1. **Topic-group thread inference (may mutate `dc`).** In topic groups
 *     (chat_mode=topic), reply events may carry `root_id` without
 *     `thread_id`. When `threadSession` is enabled and the chat is
 *     thread-capable, treat `root_id` as a synthetic `threadId` so replies
 *     stay inside the topic instead of creating a new top-level message.
 *     This step mutates `dc.isThread` and `dc.ctx.threadId` so subsequent
 *     code (session-key resolution, sentinel scoping, history scoping)
 *     observes the same routing decision.
 *
 *  2. **Reply routing decision (pure).** Computes `replyInThread` and
 *     `suppressForBotPeer` from the post-inference state. In bot→bot group
 *     chats `replyInThread` is forced to `false` regardless of the inbound
 *     shape, preventing the topic-view trap.
 */
export async function resolveFeishuReplyRouting(
  dc: DispatchContext,
  opts: { replyInThreadConfig?: boolean } = {},
): Promise<FeishuReplyRouting> {
  // Step 1: topic-group thread inference (async + side effects on dc)
  if (
    !dc.isThread &&
    dc.isGroup &&
    dc.ctx.rootId &&
    dc.account.config?.threadSession === true
  ) {
    const threadCapable = await isThreadCapableGroup({
      cfg: dc.accountScopedCfg,
      chatId: dc.ctx.chatId,
      accountId: dc.account.accountId,
    });
    if (threadCapable) {
      log.info(
        `inferred thread from root_id=${dc.ctx.rootId} in topic group ${dc.ctx.chatId}`,
      );
      dc.isThread = true;
      dc.ctx = { ...dc.ctx, threadId: dc.ctx.rootId };
    }
  }

  // Step 2: bot-peer suppression decision (pure read of dc state).
  //
  // We force a bot→bot reply out of the thread only when it would otherwise
  // snowball an *auto-detected* threadReply into a hidden topic view (#32980).
  // Two escape hatches keep parity with openclaw core (PR #89783):
  //   - isTopicSession: a deliberate topic session (threadSession enabled +
  //     inbound is in a thread) is human-visible by design — keep it threaded.
  //   - replyInThread config: operators can opt in per-group/account.
  const isTopicSession = dc.isThread && dc.account.config?.threadSession === true;
  const configReplyInThread = opts.replyInThreadConfig === true;
  const suppressForBotPeer =
    dc.isGroup && !!dc.ctx.senderIsBot && !isTopicSession && !configReplyInThread;
  const replyInThread = !suppressForBotPeer && dc.isThread;
  const threadId = replyInThread ? dc.ctx.threadId : undefined;

  return { replyInThread, threadId, suppressForBotPeer };
}
