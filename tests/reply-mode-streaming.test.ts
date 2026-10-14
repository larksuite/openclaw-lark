import { describe, expect, it } from 'vitest';
import { expandAutoMode, resolveReplyMode, resolveStreamingFlags } from '../src/card/reply-mode';

const cfg = (v: unknown) => v as never;

describe('resolveStreamingFlags', () => {
  it('accepts the legacy boolean shape', () => {
    expect(resolveStreamingFlags(cfg({ streaming: true, blockStreaming: true }))).toEqual({
      streaming: true,
      blockStreaming: true,
    });
  });

  it('accepts the OpenClaw >=2026.8 nested shape written by doctor migration', () => {
    const feishuCfg = cfg({ streaming: { mode: 'partial', block: { enabled: true } } });
    expect(resolveStreamingFlags(feishuCfg)).toEqual({ streaming: true, blockStreaming: true });
    expect(
      expandAutoMode({ mode: resolveReplyMode({ feishuCfg, chatType: 'p2p' }), streaming: true, chatType: 'p2p' }),
    ).toBe('streaming');
  });

  it('treats mode "off", missing mode, or unset as disabled', () => {
    expect(resolveStreamingFlags(cfg({ streaming: { mode: 'off' } })).streaming).toBe(false);
    expect(resolveStreamingFlags(cfg({}))).toEqual({ streaming: false, blockStreaming: false });
    expect(resolveReplyMode({ feishuCfg: cfg({ streaming: { mode: 'off' } }) })).toBe('static');
  });

  it('treats a doctor-migrated block-only shape as streaming enabled (v2)', () => {
    expect(resolveStreamingFlags(cfg({ streaming: { block: { enabled: true } } }))).toEqual({
      streaming: true,
      blockStreaming: true,
    });
  });
});
