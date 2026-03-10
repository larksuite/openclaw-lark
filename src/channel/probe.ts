/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import type { FeishuProbeResult } from './types';
import { LarkClient, type LarkClientCredentials } from '../core/lark-client';

/**
 * Probe the Feishu bot connection by calling the bot/v3/info API.
 *
 * Returns a result indicating whether the bot is reachable and its
 * basic identity (name, open_id).  Used by onboarding and status
 * checks to verify credentials before committing them to config.
 */
export async function probeFeishu(credentials?: LarkClientCredentials): Promise<FeishuProbeResult> {
  if (!credentials?.appId || !credentials?.appSecret) {
    return {
      ok: false,
      error: 'missing credentials (appId, appSecret)',
    };
  }

  return LarkClient.fromCredentials(credentials).probe();
}
