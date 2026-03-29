import { afterEach, describe, expect, it } from 'vitest';

import {
  bindFeishuStatusSink,
  clearFeishuStatusSinks,
  recordFeishuInbound,
  recordFeishuOutbound,
  updateFeishuAccountStatus,
} from '../../src/channel/status-registry';

afterEach(() => {
  clearFeishuStatusSinks();
});

describe('status-registry', () => {
  it('forwards patches to the bound sink', () => {
    const patches: Array<Record<string, unknown>> = [];

    bindFeishuStatusSink('default', (patch) => {
      patches.push(patch);
    });

    updateFeishuAccountStatus('default', {
      state: 'ready',
      connected: true,
    });

    expect(patches).toEqual([{ state: 'ready', connected: true }]);
  });

  it('records inbound timestamps and lastEventAt', () => {
    const patches: Array<Record<string, unknown>> = [];

    bindFeishuStatusSink('default', (patch) => {
      patches.push(patch);
    });

    recordFeishuInbound('default', 1234);

    expect(patches).toEqual([
      {
        lastEventAt: 1234,
        lastInboundAt: 1234,
      },
    ]);
  });

  it('records outbound timestamps', () => {
    const patches: Array<Record<string, unknown>> = [];

    bindFeishuStatusSink('default', (patch) => {
      patches.push(patch);
    });

    recordFeishuOutbound('default', 5678);

    expect(patches).toEqual([
      {
        lastOutboundAt: 5678,
      },
    ]);
  });
});
