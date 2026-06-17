import { describe, expect, it } from 'vitest';

import { resolveInteractiveRoute } from '../src/channel/interactive-route';

describe('resolveInteractiveRoute', () => {
  it('routes explicit action strings', () => {
    const route = resolveInteractiveRoute({
      operator: { open_id: 'ou_1' },
      open_chat_id: 'oc_1',
      open_message_id: 'om_1',
      action: {
        value: {
          action: 'approval:approve',
          approval: { action: 'approve', payload: { requestId: 'req-1' } },
        },
      },
    });
    expect(route).toEqual({
      action: 'approval:approve',
      namespace: 'approval',
      payload: 'approve',
      senderOpenId: 'ou_1',
      operatorUserId: undefined,
      openChatId: 'oc_1',
      openMessageId: 'om_1',
      token: undefined,
      tenantKey: undefined,
      rawValue: {
        action: 'approval:approve',
        approval: { action: 'approve', payload: { requestId: 'req-1' } },
      },
    });
  });

  it('uses context fields when top-level ids are missing', () => {
    const route = resolveInteractiveRoute({
      operator: { open_id: 'ou_2' },
      context: { open_chat_id: 'oc_2', open_message_id: 'om_2' },
      action: {
        value: {
          action: 'approval:reject',
        },
      },
    });
    expect(route?.action).toBe('approval:reject');
    expect(route?.namespace).toBe('approval');
    expect(route?.payload).toBe('reject');
    expect(route?.openChatId).toBe('oc_2');
    expect(route?.openMessageId).toBe('om_2');
  });

  it('returns null when no route can be derived', () => {
    expect(resolveInteractiveRoute({ action: { value: { foo: 'bar' } } })).toBeNull();
  });
});
