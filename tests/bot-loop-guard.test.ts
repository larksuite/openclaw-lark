/**
 * Tests for the cross-bot loop guard (bot-loop-guard.ts).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_CONSECUTIVE_BOT_TURNS,
  BOT_LOOP_IDLE_RESET_MS,
  noteBotTurnAndCheck,
  resetBotLoop,
  resetAllBotLoops,
} from '../src/messaging/inbound/bot-loop-guard';

beforeEach(() => resetAllBotLoops());

describe('noteBotTurnAndCheck', () => {
  it('allows turns up to the cap, then suppresses', () => {
    let last = { allowed: true, count: 0, limit: 0 };
    for (let i = 1; i <= MAX_CONSECUTIVE_BOT_TURNS; i++) {
      last = noteBotTurnAndCheck('oc_a');
      expect(last.allowed).toBe(true);
      expect(last.count).toBe(i);
    }
    const over = noteBotTurnAndCheck('oc_a');
    expect(over.allowed).toBe(false);
    expect(over.count).toBe(MAX_CONSECUTIVE_BOT_TURNS + 1);
  });

  it('resets on a human turn (resetBotLoop)', () => {
    for (let i = 0; i < MAX_CONSECUTIVE_BOT_TURNS + 2; i++) noteBotTurnAndCheck('oc_b');
    resetBotLoop('oc_b');
    const after = noteBotTurnAndCheck('oc_b');
    expect(after.allowed).toBe(true);
    expect(after.count).toBe(1);
  });

  it('decays after the idle window', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < MAX_CONSECUTIVE_BOT_TURNS; i++) {
      noteBotTurnAndCheck('oc_c', undefined, t0);
    }
    // Same instant, one more → over cap
    expect(noteBotTurnAndCheck('oc_c', undefined, t0).allowed).toBe(false);
    // Far in the future (idle) → counter decays, allowed again from 1
    const later = t0 + BOT_LOOP_IDLE_RESET_MS + 1;
    const fresh = noteBotTurnAndCheck('oc_c', undefined, later);
    expect(fresh.allowed).toBe(true);
    expect(fresh.count).toBe(1);
  });

  it('tracks chat and thread independently', () => {
    for (let i = 0; i < MAX_CONSECUTIVE_BOT_TURNS + 1; i++) noteBotTurnAndCheck('oc_d');
    // A different thread in the same chat has its own budget.
    const other = noteBotTurnAndCheck('oc_d', 'thread_1');
    expect(other.allowed).toBe(true);
    expect(other.count).toBe(1);
  });
});
