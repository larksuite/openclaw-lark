/**
 * Tests for the restored bot-at-bot identity & guidance builders in
 * dispatch-builders.ts:
 *  - buildFeishuIdentityFields  → SenderIsBot / BotOpenId injection
 *  - buildFeishuGroupSystemPrompt → self-identity + @ rule + loop hygiene
 */

import { describe, expect, it } from 'vitest';
import {
  buildFeishuGroupSystemPrompt,
  buildFeishuIdentityFields,
} from '../src/messaging/inbound/dispatch-builders';
import type { MessageContext } from '../src/messaging/types';

function makeCtx(overrides: Partial<MessageContext> = {}): MessageContext {
  return {
    chatId: 'oc_chat',
    messageId: 'om_test',
    senderId: 'ou_sender',
    chatType: 'group',
    content: 'hi',
    contentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    ...overrides,
  } as MessageContext;
}

describe('buildFeishuIdentityFields', () => {
  it('marks SenderIsBot true and includes BotOpenId', () => {
    const fields = buildFeishuIdentityFields(makeCtx({ senderIsBot: true }), 'ou_self');
    expect(fields.SenderIsBot).toBe(true);
    expect(fields.BotOpenId).toBe('ou_self');
  });

  it('defaults SenderIsBot to false when unset', () => {
    const fields = buildFeishuIdentityFields(makeCtx({ senderIsBot: undefined }), 'ou_self');
    expect(fields.SenderIsBot).toBe(false);
  });

  it('omits BotOpenId when the bot open_id is unknown', () => {
    const fields = buildFeishuIdentityFields(makeCtx({ senderIsBot: false }), undefined);
    expect(fields.SenderIsBot).toBe(false);
    expect('BotOpenId' in fields).toBe(false);
  });
});

describe('buildFeishuGroupSystemPrompt', () => {
  it('injects self open_id, the @-delivery rule, and loop hygiene', () => {
    const prompt = buildFeishuGroupSystemPrompt(undefined, 'ou_self') ?? '';
    expect(prompt).toContain('ou_self');
    expect(prompt).toMatch(/@-mention/i);
    expect(prompt).toMatch(/loop/i);
    expect(prompt).toMatch(/stop|do not reply/i);
  });

  it('appends the operator-configured group prompt after the guidance', () => {
    const prompt = buildFeishuGroupSystemPrompt('Be concise.', 'ou_self') ?? '';
    expect(prompt).toContain('Be concise.');
    expect(prompt.indexOf('ou_self')).toBeLessThan(prompt.indexOf('Be concise.'));
  });

  it('still injects guidance with no configured prompt and no open_id', () => {
    const prompt = buildFeishuGroupSystemPrompt(undefined, undefined);
    expect(prompt).toBeTruthy();
    expect(prompt).toMatch(/@-mention/i);
  });
});
