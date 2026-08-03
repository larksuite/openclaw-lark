/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * 飞书会话的运行时 ACP/session 绑定。
 *
 * 适配器随账号 monitor 创建，而不是在插件注册时创建。只有账号仍能接收
 * 入站事件并将其路由回目标 session 时，绑定才有效。
 */

import type { OpenClawConfig } from 'openclaw/plugin-sdk';
import {
  type AccountScopedConversationBindingManager,
  type BindingTargetKind,
  createAccountScopedConversationBindingManager,
  resetAccountScopedConversationBindingsForTests,
} from 'openclaw/plugin-sdk/thread-bindings-runtime';

type FeishuBindingTargetKind = 'subagent' | 'acp';

const FEISHU_THREAD_BINDINGS_STATE_KEY = Symbol.for('openclaw.larkThreadBindingsState');

function toFeishuTargetKind(raw: BindingTargetKind): FeishuBindingTargetKind {
  return raw === 'subagent' ? 'subagent' : 'acp';
}

function toSessionBindingTargetKind(raw: FeishuBindingTargetKind): BindingTargetKind {
  return raw === 'subagent' ? 'subagent' : 'session';
}

/**
 * 注册 ACP `/acp spawn` 命令使用的账号级适配器。SDK manager 会规范化
 * account ID，并在调用 `stop()` 时注销对应的适配器实例。
 */
export function createFeishuThreadBindingManager(params: {
  accountId?: string | null;
  cfg: OpenClawConfig;
}): AccountScopedConversationBindingManager<FeishuBindingTargetKind> {
  return createAccountScopedConversationBindingManager<FeishuBindingTargetKind>({
    channel: 'feishu',
    cfg: params.cfg,
    accountId: params.accountId,
    stateKey: FEISHU_THREAD_BINDINGS_STATE_KEY,
    toStoredTargetKind: toFeishuTargetKind,
    toSessionBindingTargetKind,
  });
}

export const __testing = {
  resetFeishuThreadBindingsForTests(): void {
    resetAccountScopedConversationBindingsForTests({
      stateKey: FEISHU_THREAD_BINDINGS_STATE_KEY,
    });
  },
};
