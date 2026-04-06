/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Lightweight runtime status sink registry for the Feishu channel.
 *
 * The gateway owns the actual runtime snapshot, but inbound handlers,
 * outbound senders and WebSocket lifecycle callbacks run in different
 * modules. This registry provides a single place to publish per-account
 * status patches back to the gateway-managed account runtime.
 */

import { LarkClient } from '../core/lark-client';
import type { FeishuStatusPatch } from './types';

const sinks = new Map<string, (patch: FeishuStatusPatch) => void>();

export function bindFeishuStatusSink(accountId: string, sink: (patch: FeishuStatusPatch) => void): () => void {
  sinks.set(accountId, sink);
  return () => {
    if (sinks.get(accountId) === sink) {
      sinks.delete(accountId);
    }
  };
}

export function clearFeishuStatusSinks(): void {
  sinks.clear();
}

export function updateFeishuAccountStatus(accountId: string, patch: FeishuStatusPatch): void {
  sinks.get(accountId)?.(patch);
}

function recordChannelActivity(accountId: string, direction: 'inbound' | 'outbound', at: number): void {
  try {
    LarkClient.runtime.channel.activity.record({
      channel: 'feishu',
      accountId,
      direction,
      at,
    });
  } catch {
    // Runtime is optional in unit tests and one-off utility entrypoints.
  }
}

export function recordFeishuInbound(accountId: string, at = Date.now()): void {
  recordChannelActivity(accountId, 'inbound', at);
  updateFeishuAccountStatus(accountId, {
    lastEventAt: at,
    lastInboundAt: at,
  });
}

export function recordFeishuOutbound(accountId: string, at = Date.now()): void {
  recordChannelActivity(accountId, 'outbound', at);
  updateFeishuAccountStatus(accountId, {
    lastOutboundAt: at,
  });
}
