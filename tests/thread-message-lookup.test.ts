/**
 * Tests for getLatestThreadMessageIdFeishu — the live thread lookup used as a
 * reply anchor so subagent/delayed deliveries (which arrive with only a
 * threadId) reply into the original topic instead of opening a new one.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks (hoisted)
// ---------------------------------------------------------------------------

const mockRequest = vi.fn();

vi.mock('../src/core/lark-client', () => ({
  LarkClient: {
    fromCfg: () => ({ sdk: { request: mockRequest } }),
  },
}));

import { getLatestThreadMessageIdFeishu } from '../src/messaging/shared/message-lookup';

describe('getLatestThreadMessageIdFeishu', () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it('returns the latest message id and queries the thread container newest-first', async () => {
    mockRequest.mockResolvedValue({ data: { items: [{ message_id: 'om_latest' }] } });

    await expect(
      getLatestThreadMessageIdFeishu({ cfg: {} as never, threadId: 'omt_a', accountId: 'acct' }),
    ).resolves.toBe('om_latest');
    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      url: '/open-apis/im/v1/messages',
      params: {
        container_id_type: 'thread',
        container_id: 'omt_a',
        sort_type: 'ByCreateTimeDesc',
        page_size: 1,
      },
    });
  });

  it('returns undefined for an empty thread', async () => {
    mockRequest.mockResolvedValue({ data: { items: [] } });
    await expect(getLatestThreadMessageIdFeishu({ cfg: {} as never, threadId: 'omt_a' })).resolves.toBeUndefined();
  });

  it('swallows errors and returns undefined so the caller falls back to create()', async () => {
    mockRequest.mockRejectedValue(new Error('missing message:readonly scope'));
    await expect(getLatestThreadMessageIdFeishu({ cfg: {} as never, threadId: 'omt_a' })).resolves.toBeUndefined();
  });
});
