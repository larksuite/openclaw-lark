/**
 * Default synchronous ack for declarative interactive card handlers (≤3s Feishu callback).
 */

import type { FeishuInteractiveDefaultAckConfig } from '../core/config-schema';

export interface FeishuInteractiveAckResponse {
  toast?: {
    type: 'info' | 'success' | 'warning' | 'error';
    content: string;
    i18n?: Record<string, string>;
  };
  card?: {
    type: 'raw';
    data: Record<string, unknown>;
  };
}

function buildProcessingCard(): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: 'Processing' },
      subtitle: { tag: 'plain_text', content: 'Please wait…' },
      template: 'blue',
    },
    body: {
      direction: 'vertical',
      elements: [
        {
          tag: 'markdown',
          content: 'Your action is being processed; this card will update automatically when it completes.',
        },
      ],
    },
  };
}

/**
 * Build the synchronous Feishu callback response before async script work starts.
 */
export function buildDefaultInteractiveAck(
  config?: FeishuInteractiveDefaultAckConfig,
): FeishuInteractiveAckResponse | undefined {
  if (config?.enabled === false) return undefined;
  const toastContent = config?.toast?.content?.trim() || 'Received, processing…';
  const toastType = config?.toast?.type ?? 'info';
  const response: FeishuInteractiveAckResponse = {
    toast: {
      type: toastType,
      content: toastContent,
      ...(config?.toast?.i18n ? { i18n: config.toast.i18n } : {}),
    },
  };
  const cardPatch = config?.cardPatch ?? 'processing';
  if (cardPatch === 'processing') {
    response.card = {
      type: 'raw',
      data: buildProcessingCard(),
    };
  }
  return response;
}
