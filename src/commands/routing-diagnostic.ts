/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import type { OpenClawConfig } from 'openclaw/plugin-sdk';
import { resolveAgentRoute } from 'openclaw/plugin-sdk/routing';

interface AccountRoutingCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  details?: string;
}

/** Check account-level fallback without fabricating a sender or changing routing policy. */
export function checkAccountRouting(config: OpenClawConfig, accountId: string): AccountRoutingCheck {
  const name = '账户默认 Agent 路由';
  try {
    const route = resolveAgentRoute({ cfg: config, channel: 'feishu', accountId });
    return {
      name,
      status: 'pass' as const,
      message: `默认路由到 Agent: ${route.agentId}`,
      details: '仅验证账户默认路由；不代表具体会话权限、模型调用或回复发送已通过。',
    };
  } catch (err) {
    if (
      err instanceof Error &&
      err.name === 'AgentSelectionRequiredError' &&
      'surface' in err &&
      err.surface === `feishu account ${accountId} routing`
    ) {
      return {
        name,
        status: 'warn' as const,
        message: '账户没有默认 Agent；未命中特定会话绑定的消息无法分发。',
        details:
          '若有意仅允许已绑定会话，可保留此配置。否则请先选择负责该账户的 Agent，再运行 ' +
          `openclaw agents bind --agent <agent-id> --bind ${JSON.stringify(`feishu:${accountId}`)}。` +
          '特定群/会话绑定仍优先；不要通过放宽 allowlist 或配对策略解决路由问题。',
      };
    }
    return {
      name,
      status: 'fail' as const,
      message: `路由检查失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
