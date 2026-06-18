/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Tests for isConversationStopIntent — the predicate that suppresses the
 * deterministic peer-@ backstop when a human asks the bots to stop. A false
 * negative re-wakes the peer bot and defeats the interruption (the "@对手"
 * loop seen when a user sends "中断对话"); a false positive only skips a
 * forced @ for that turn.
 */

import { describe, expect, it } from 'vitest';
import { isConversationStopIntent } from '../src/channel/abort-detect';

describe('isConversationStopIntent', () => {
  it('matches the conversational stop phrases that defeated the interruption', () => {
    expect(isConversationStopIntent('中断对话')).toBe(true);
    expect(isConversationStopIntent('@_user_1 @_user_2 中断对话')).toBe(true); // with mention placeholders
    expect(isConversationStopIntent('你们先停一下')).toBe(true);
    expect(isConversationStopIntent('别聊了')).toBe(true);
    expect(isConversationStopIntent('结束对话吧')).toBe(true);
    expect(isConversationStopIntent('请暂停')).toBe(true);
  });

  it('matches the broader zh stop vocabulary (终止 / 打住 / 别继续 / …)', () => {
    expect(isConversationStopIntent('终止')).toBe(true);
    expect(isConversationStopIntent('@_user_1 @_user_2 终止辩论')).toBe(true);
    expect(isConversationStopIntent('打住')).toBe(true);
    expect(isConversationStopIntent('你们别继续了')).toBe(true);
    expect(isConversationStopIntent('别再聊了')).toBe(true);
    expect(isConversationStopIntent('不要继续了')).toBe(true);
    expect(isConversationStopIntent('到此为止吧')).toBe(true);
    expect(isConversationStopIntent('都别吵了')).toBe(true);
    expect(isConversationStopIntent('结束辩论')).toBe(true);
  });

  it('matches English conversational stops', () => {
    expect(isConversationStopIntent('stop talking')).toBe(true);
    expect(isConversationStopIntent('@_user_1 please stop the conversation')).toBe(true);
    expect(isConversationStopIntent('OK you two, knock it off')).toBe(true);
    expect(isConversationStopIntent('stop debating please')).toBe(true);
    expect(isConversationStopIntent('alright, stand down')).toBe(true);
    expect(isConversationStopIntent('stop responding to each other')).toBe(true);
  });

  it('still matches the exact abort triggers (superset of isLikelyAbortText)', () => {
    expect(isConversationStopIntent('停止')).toBe(true);
    expect(isConversationStopIntent('stop')).toBe(true);
    expect(isConversationStopIntent('/stop')).toBe(true);
  });

  it('does NOT fire on a debate kickoff or normal chatter', () => {
    expect(isConversationStopIntent('你们分别充当正反方辩手，辩论下无斑马线的路口是否要礼让行人')).toBe(false);
    expect(isConversationStopIntent('@_user_1 @_user_2 讨论下今天杭州的天气')).toBe(false);
    expect(isConversationStopIntent('继续')).toBe(false);
    expect(isConversationStopIntent('请继续辩论')).toBe(false); // continue, not stop
    expect(isConversationStopIntent('我们停车场见面吧')).toBe(false); // "停车" must not match (no bare 停)
    expect(isConversationStopIntent('讨论继续进行')).toBe(false);
    expect(isConversationStopIntent('收到！测试成功')).toBe(false);
    expect(isConversationStopIntent('')).toBe(false);
    expect(isConversationStopIntent('   ')).toBe(false);
  });
});
