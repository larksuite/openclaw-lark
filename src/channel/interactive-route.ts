/**
 * Shared routing for Feishu `card.action.trigger` events.
 *
 * Resolves a declarative `namespace:payload` route from the button
 * `value.action` string, so card actions can be dispatched to configured
 * handlers without writing a plugin.
 */

import { resolveCardCallbackOperatorId } from '../core/card-action-operator';

export interface FeishuCardActionTriggerEvent {
  operator?: { open_id?: string; user_id?: string };
  open_chat_id?: string;
  open_message_id?: string;
  chatType?: 'p2p' | 'group';
  threadId?: string;
  token?: string;
  tenant_key?: string;
  context?: { open_chat_id?: string; open_message_id?: string };
  event?: {
    message?: {
      chat_type?: string;
      thread_id?: string;
    };
  };
  action?: {
    value?: {
      action?: string;
      [key: string]: unknown;
    };
  };
}

export interface ResolvedInteractiveRoute {
  action: string;
  namespace: string;
  payload: string;
  senderOpenId?: string;
  operatorUserId?: string;
  openChatId?: string;
  openMessageId?: string;
  chatType?: 'p2p' | 'group';
  threadId?: string;
  token?: string;
  tenantKey?: string;
  rawValue?: Record<string, unknown>;
}

function splitNamespacePayload(action: string): { namespace: string; payload: string } {
  const trimmed = action.trim();
  const colon = trimmed.indexOf(':');
  if (colon <= 0) {
    return { namespace: trimmed, payload: '' };
  }
  return {
    namespace: trimmed.slice(0, colon),
    payload: trimmed.slice(colon + 1),
  };
}

function resolveActionString(value: Record<string, unknown> | undefined): string {
  if (!value) return '';
  const direct = value.action;
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim();
  }
  return '';
}

/**
 * Resolve interactive route metadata from a `card.action.trigger` payload.
 *
 * The button `value.action` is expected to be a `namespace:payload` string
 * (e.g. `approval:approve`). Returns `null` when no action can be resolved.
 */
export function resolveInteractiveRoute(data: unknown): ResolvedInteractiveRoute | null {
  try {
    const ev = data as FeishuCardActionTriggerEvent;
    const rawValue = ev.action?.value;
    const action = resolveActionString(rawValue as Record<string, unknown> | undefined);
    if (!action) return null;
    const { namespace, payload } = splitNamespacePayload(action);
    if (!namespace) return null;
    return {
      action,
      namespace,
      payload,
      senderOpenId: resolveCardCallbackOperatorId(ev.operator),
      operatorUserId: ev.operator?.user_id,
      openChatId: ev.open_chat_id ?? ev.context?.open_chat_id,
      openMessageId: ev.open_message_id ?? ev.context?.open_message_id,
      chatType: ev.chatType ?? (ev.event?.message?.chat_type === 'group' ? 'group' : undefined),
      threadId: ev.threadId ?? ev.event?.message?.thread_id,
      token: ev.token,
      tenantKey: ev.tenant_key,
      rawValue: rawValue as Record<string, unknown> | undefined,
    };
  } catch {
    return null;
  }
}
