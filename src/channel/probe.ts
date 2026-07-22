/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { LarkClient, type LarkClientCredentials } from '../core/lark-client';
import type { FeishuProbeResult } from './types';

/**
 * Probe the Feishu bot connection by calling the bot/v3/info API.
 *
 * Returns a result indicating whether the bot is reachable and its
 * basic identity (name, open_id).  Used by onboarding and status
 * checks to verify credentials before committing them to config.
 */
export async function probeFeishu(credentials?: LarkClientCredentials): Promise<FeishuProbeResult> {
  const keyless = credentials?.authMethod === 'private_key_jwt' && Boolean(credentials.keyRef);
  if (!credentials?.appId || (!credentials.appSecret && !keyless)) {
    return {
      ok: false,
      error: 'missing credentials (appId and authentication method)',
    };
  }

  return LarkClient.fromCredentials(credentials).probe();
}
