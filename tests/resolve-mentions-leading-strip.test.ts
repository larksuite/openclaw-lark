/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Tests for the leading-only self-mention strip in resolveMentions.
 *
 * The previous implementation injected a "@你(本机器人)" anchor in place of
 * every self-mention; this test pins the new behavior:
 *  - Leading self-mention → dropped entirely
 *  - Mid-text self-mention → rendered as "@Name" (no anchor, no strip)
 */

import { describe, expect, it } from 'vitest';
import { resolveMentions } from '../src/messaging/converters/content-converter-helpers';
import type { ConvertContext } from '../src/messaging/converters/types';
import type { MentionInfo } from '../src/messaging/types';

function makeCtx(bot: MentionInfo, otherKey: MentionInfo[] = []): ConvertContext {
  const mentions = new Map<string, MentionInfo>();
  mentions.set(bot.key, bot);
  for (const m of otherKey) mentions.set(m.key, m);
  return {
    mentions,
    mentionsByOpenId: new Map(),
    messageId: 'om_test',
    stripBotMentions: true,
  };
}

const SELF: MentionInfo = {
  key: '@_bot_self',
  openId: 'ou_self',
  name: 'MyBot',
  isBot: true,
};

describe('resolveMentions — leading-only strip for self-mention', () => {
  it('drops the leading self-mention with placeholder key', () => {
    const ctx = makeCtx(SELF);
    expect(resolveMentions('@_bot_self  please summarize', ctx)).toBe('please summarize');
  });

  it('drops the leading self-mention written as @Name', () => {
    const ctx = makeCtx(SELF);
    expect(resolveMentions('@MyBot please summarize', ctx)).toBe('please summarize');
  });

  it('strips a leading colon/comma after the self-mention', () => {
    const ctx = makeCtx(SELF);
    expect(resolveMentions('@MyBot: do it', ctx)).toBe('do it');
    expect(resolveMentions('@MyBot, do it', ctx)).toBe('do it');
    expect(resolveMentions('@MyBot，请处理', ctx)).toBe('请处理');
  });

  it('preserves mid-text self-mention as plain @Name', () => {
    const ctx = makeCtx(SELF);
    const out = resolveMentions('hey @MyBot please take a look', ctx);
    expect(out).toContain('@MyBot');
    expect(out).not.toContain('@你(本机器人)');
  });

  it('leaves non-bot mentions rendered as @Name regardless of position', () => {
    const human: MentionInfo = {
      key: '@_user_1',
      openId: 'ou_alice',
      name: 'Alice',
      isBot: false,
    };
    const ctx = makeCtx(SELF, [human]);
    expect(resolveMentions('@_user_1 hi from @_bot_self', ctx)).toContain('@Alice');
    expect(resolveMentions('@_user_1 hi from @_bot_self', ctx)).toContain('@MyBot');
  });

  it('does not strip the anchor when stripBotMentions is false', () => {
    const ctx: ConvertContext = {
      mentions: new Map([[SELF.key, SELF]]),
      mentionsByOpenId: new Map(),
      messageId: 'om_test',
      stripBotMentions: false,
    };
    const out = resolveMentions('@_bot_self hi', ctx);
    expect(out).toContain('@MyBot');
  });
});
