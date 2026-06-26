/**
 * Prompt template helpers for declarative interactive card handlers.
 */

import type { ResolvedInteractiveRoute } from './interactive-route';

export interface InteractiveHandlerContextParams {
  route: ResolvedInteractiveRoute;
  accountId: string;
  dedupeId: string;
}

/**
 * Build string variables for `{{key}}` substitution in handler prompts.
 */
export function buildInteractiveHandlerContext(
  params: InteractiveHandlerContextParams,
): Record<string, string> {
  const { route, accountId, dedupeId } = params;
  const contextObject = {
    route: {
      action: route.action,
      namespace: route.namespace,
      payload: route.payload,
      openChatId: route.openChatId,
      openMessageId: route.openMessageId,
      operatorOpenId: route.senderOpenId,
      operatorUserId: route.operatorUserId,
      chatType: route.chatType,
      threadId: route.threadId,
      token: route.token,
      tenantKey: route.tenantKey,
    },
    accountId,
    dedupeId,
    value: route.rawValue ?? {},
  };
  return {
    action: route.action,
    namespace: route.namespace,
    payload: route.payload,
    openChatId: route.openChatId ?? '',
    openMessageId: route.openMessageId ?? '',
    operatorOpenId: route.senderOpenId ?? '',
    operatorUserId: route.operatorUserId ?? '',
    chatType: route.chatType ?? '',
    threadId: route.threadId ?? '',
    context: JSON.stringify(contextObject, null, 2),
    value: JSON.stringify(route.rawValue ?? {}, null, 2),
  };
}

/**
 * Replace `{{key}}` placeholders in a handler prompt template.
 */
export function renderInteractiveHandlerPrompt(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => vars[key] ?? '');
}
