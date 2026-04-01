/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Shared registry for the inbound message handler.
 *
 * Synthetic message helpers depend on this registry instead of importing
 * `handler.ts` directly, which keeps the static import graph acyclic.
 */

import type { ClawdbotConfig, RuntimeEnv } from 'openclaw/plugin-sdk';
import type { AuthResumeTarget } from '../../core/auth-resume-target';
import type { FeishuMessageEvent } from '../types';

export interface InboundHandlerParams {
  cfg: ClawdbotConfig;
  event: FeishuMessageEvent;
  botOpenId?: string;
  runtime?: RuntimeEnv;
  accountId?: string;
  replyToMessageId?: string;
  forceMention?: boolean;
  skipTyping?: boolean;
  sessionRouteOverride?: AuthResumeTarget;
}

type InboundHandler = (params: InboundHandlerParams) => Promise<void>;

let inboundHandler: InboundHandler | null = null;

export function injectInboundHandler(handler: InboundHandler): void {
  inboundHandler = handler;
}

export function getInboundHandler(): InboundHandler {
  if (!inboundHandler) {
    throw new Error('Feishu inbound handler has not been initialised.');
  }
  return inboundHandler;
}
