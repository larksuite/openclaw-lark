import { describe, expect, it } from 'vitest';

import {
  buildInteractiveHandlerContext,
  renderInteractiveHandlerPrompt,
} from '../src/channel/interactive-prompt';

describe('interactive prompt helpers', () => {
  it('renders template placeholders', () => {
    const vars = buildInteractiveHandlerContext({
      accountId: 'default',
      dedupeId: 'dedupe-1',
      route: {
        action: 'approval:approve',
        namespace: 'approval',
        payload: 'approve',
        senderOpenId: 'ou_1',
        openChatId: 'oc_1',
        openMessageId: 'om_1',
        rawValue: { action: 'approval:approve', requestId: 'req-1' },
      },
    });
    const text = renderInteractiveHandlerPrompt(
      'Handle {{namespace}}:{{payload}} for message {{openMessageId}}\n{{context}}',
      vars,
    );
    expect(text).toContain('Handle approval:approve for message om_1');
    expect(text).toContain('"requestId": "req-1"');
  });
});
