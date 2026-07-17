/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Tool Execution Context — AsyncLocalStorage-based context propagation.
 *
 * Provides a way to pass agentId from the tool registration layer down to
 * account resolution helpers without threading it through every function call.
 *
 * Also provides `resolveAccountFromBindings()` — a shared resolver that maps
 * agentId → accountId via the `bindings` config, enabling correct account
 * routing when tools are invoked from non-Feishu channels (e.g., Telegram).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import type { LarkAccount } from './types';
import { getEnabledLarkAccounts, getLarkAccount } from './accounts';
import { larkLogger } from './lark-logger';

const tecLog = larkLogger('core/tool-execution-context');

// ---------------------------------------------------------------------------
// ALS Context
// ---------------------------------------------------------------------------

interface ToolExecutionCtx {
  agentId?: string;
}

const als = new AsyncLocalStorage<ToolExecutionCtx>();

/**
 * Run a callback within a tool execution context.
 * The context (e.g., agentId) will be available to any downstream code
 * via `getToolExecutionContext()`.
 */
export function runInToolExecutionContext<T>(ctx: ToolExecutionCtx, fn: () => T): T {
  return als.run(ctx, fn);
}

/**
 * Get the current tool execution context, if any.
 */
export function getToolExecutionContext(): ToolExecutionCtx | undefined {
  return als.getStore();
}

// ---------------------------------------------------------------------------
// Bindings-based Account Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a Feishu account from the `bindings` config using the current agentId.
 *
 * This is the key fix for issue #321: when tools are called from non-Feishu
 * channels (Telegram, Discord, etc.), there is no LarkTicket, so we need
 * another way to determine which account to use.
 *
 * Resolution priority (handled by callers):
 *   1. LarkTicket.accountId (existing logic, unchanged)
 *   2. bindings[agentId] → accountId (this function)
 *   3. accounts[accountIndex] fallback (existing logic, unchanged)
 *
 * @param config - OpenClaw config
 * @param agentId - The current agent's ID (from ALS context or plugin ctx)
 * @returns The resolved LarkAccount, or undefined if no binding matches
 * @throws If multiple bindings match the same agentId (ambiguous config)
 */
export function resolveAccountFromBindings(
  config: ClawdbotConfig,
  agentId: string | undefined,
): LarkAccount | undefined {
  if (!agentId) return undefined;

  // Access bindings from feishu channel config
  const feishuConfig = (config as any)?.channels?.feishu;
  const bindings: Array<{ match?: { accountId?: string }; agentId?: string }> | undefined = feishuConfig?.bindings;

  if (!Array.isArray(bindings) || bindings.length === 0) return undefined;

  // Find bindings that match this agentId
  const matches = bindings.filter((b) => b.agentId === agentId);

  if (matches.length === 0) return undefined;

  if (matches.length > 1) {
    throw new Error(
      `Ambiguous Feishu bindings: ${matches.length} bindings match agentId="${agentId}". ` +
        `Please ensure each agentId maps to exactly one binding in channels.feishu.bindings.`,
    );
  }

  const accountId = matches[0]?.match?.accountId;
  if (typeof accountId !== 'string' || accountId.trim() === '') {
    tecLog.debug?.(`Binding for agentId="${agentId}" has no valid accountId, skipping`);
    return undefined;
  }

  const account = getLarkAccount(config, accountId.trim());
  if (!account.enabled || !account.configured) {
    tecLog.warn?.(
      `Binding for agentId="${agentId}" resolved to account "${accountId}" but it is ` +
        `${!account.enabled ? 'disabled' : 'not configured'}. Falling back.`,
    );
    return undefined;
  }

  tecLog.info?.(`Resolved account via bindings: agentId="${agentId}" → accountId="${accountId}"`);
  return account;
}
