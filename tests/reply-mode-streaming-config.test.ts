import { describe, expect, it } from 'vitest';
import { expandAutoMode, isStreamingEnabled, resolveReplyMode } from '../src/card/reply-mode';
import type { FeishuConfig } from '../src/core/types';

function directReplyMode(streaming: FeishuConfig['streaming']): 'static' | 'streaming' {
  const feishuCfg = { streaming } as FeishuConfig;
  return expandAutoMode({
    mode: resolveReplyMode({ feishuCfg, chatType: 'p2p' }),
    streaming: isStreamingEnabled(feishuCfg.streaming),
    chatType: 'p2p',
  });
}

describe('streaming config shape', () => {
  it('streams direct replies when the host migrated streaming to { mode: "partial" }', () => {
    expect(directReplyMode({ mode: 'partial' })).toBe('streaming');
  });

  it('treats { mode: "off" } and an object without mode as off', () => {
    expect(directReplyMode({ mode: 'off' })).toBe('static');
    expect(directReplyMode({} as FeishuConfig['streaming'])).toBe('static');
  });

  it('keeps the legacy boolean working', () => {
    expect(directReplyMode(true)).toBe('streaming');
    expect(directReplyMode(false)).toBe('static');
    expect(directReplyMode(undefined)).toBe('static');
  });
});
