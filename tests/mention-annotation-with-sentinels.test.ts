import { describe, expect, it } from 'vitest';
import { buildMentionAnnotation } from '../src/messaging/inbound/dispatch-builders';
import type { MessageContext } from '../src/messaging/types';
import type { SentinelEntry } from '../src/messaging/inbound/sentinel-store';

function makeCtx(overrides: Partial<MessageContext> = {}): MessageContext {
  return {
    chatId: 'oc_x',
    messageId: 'om_x',
    senderId: 'ou_user1',
    chatType: 'group',
    content: 'hi',
    contentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    rawMessage: {} as any,
    rawSender: {} as any,
    ...overrides,
  };
}

describe('buildMentionAnnotation with sentinels', () => {
  it('returns undefined when no mentions and no sentinels', () => {
    expect(buildMentionAnnotation(makeCtx())).toBeUndefined();
    expect(buildMentionAnnotation(makeCtx(), [])).toBeUndefined();
  });

  it('returns annotation with mentions only (PR #477 behavior preserved)', () => {
    const ctx = makeCtx({
      mentions: [{ key: '@_1', openId: 'ou_a', name: 'Alice', isBot: false }],
    });
    const out = buildMentionAnnotation(ctx);
    expect(out).toContain('Alice');
    expect(out).toContain('open_id: ou_a');
    expect(out).not.toContain('Previous reply');
  });

  it('appends sentinel feedback for not_found', () => {
    const sentinels: SentinelEntry[] = [{ name: 'Charlie', reason: 'not_found' }];
    const out = buildMentionAnnotation(makeCtx(), sentinels);
    expect(out).toContain('Previous reply had unresolved mentions');
    expect(out).toContain('"@Charlie"');
    expect(out).toContain('not recognized');
  });

  it('appends sentinel feedback for ambiguous with candidates', () => {
    const sentinels: SentinelEntry[] = [
      { name: 'Zhang', reason: 'ambiguous', candidates: [{ openId: 'ou_a' }, { openId: 'ou_b' }] },
    ];
    const out = buildMentionAnnotation(makeCtx(), sentinels);
    expect(out).toContain('"@Zhang"');
    expect(out).toContain('matched multiple');
    expect(out).toContain('ou_a');
    expect(out).toContain('ou_b');
  });

  it('combines mentions and sentinels in same annotation', () => {
    const ctx = makeCtx({
      mentions: [{ key: '@_1', openId: 'ou_a', name: 'Alice', isBot: false }],
    });
    const sentinels: SentinelEntry[] = [{ name: 'Charlie', reason: 'not_found' }];
    const out = buildMentionAnnotation(ctx, sentinels);
    expect(out).toContain('Alice');
    expect(out).toContain('Charlie');
  });
});
