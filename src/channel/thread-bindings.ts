/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Minimal Feishu session/thread binding support.
 *
 * This file uses the public session-binding surface from openclaw/plugin-sdk.
 * The current local runtime is patched to expose these APIs until they land
 * upstream in a released OpenClaw build.
 */

import {
  type ClawdbotConfig,
  type ConversationRef,
  type OpenClawPluginApi,
  type SessionBindingAdapter,
  type SessionBindingRecord,
  getSessionBindingService,
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
} from 'openclaw/plugin-sdk';
import { getLarkAccount, getLarkAccountIds } from '../core/accounts';
import { larkLogger } from '../core/lark-logger';
import { normalizeFeishuTarget } from '../core/targets';

const log = larkLogger('thread-bindings');
const FEISHU_BINDING_STATE_SYMBOL = Symbol.for('openclaw-lark.feishuThreadBindings');

interface FeishuBindingEntry {
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  targetSessionKey: string;
  targetKind: SessionBindingTargetKind;
  boundAt: number;
  lastActivityAt: number;
  metadata?: Record<string, unknown>;
}

interface FeishuBindingState {
  bindingsByAccountConversation: Map<string, FeishuBindingEntry>;
}

function getBindingState(): FeishuBindingState {
  const globalState = globalThis as typeof globalThis & {
    [FEISHU_BINDING_STATE_SYMBOL]?: FeishuBindingState;
  };
  globalState[FEISHU_BINDING_STATE_SYMBOL] ??= {
    bindingsByAccountConversation: new Map<string, FeishuBindingEntry>(),
  };
  return globalState[FEISHU_BINDING_STATE_SYMBOL]!;
}

function normalizeAccountId(input: string | undefined | null): string {
  return (input ?? 'default').trim() || 'default';
}

function normalizeConversationId(input: string | undefined | null): string | undefined {
  const value = input?.trim();
  return value ? value : undefined;
}

function resolveConversationParentTarget(input: string | undefined | null): string | undefined {
  return normalizeConversationId(input ? normalizeFeishuTarget(input) : null);
}

function toBindingKey(accountId: string, conversationId: string): string {
  return `${normalizeAccountId(accountId)}:${conversationId}`;
}

function toSessionBindingRecord(entry: FeishuBindingEntry): SessionBindingRecord {
  return {
    bindingId: toBindingKey(entry.accountId, entry.conversationId),
    targetSessionKey: entry.targetSessionKey,
    targetKind: entry.targetKind,
    conversation: {
      channel: 'feishu',
      accountId: entry.accountId,
      conversationId: entry.conversationId,
      parentConversationId: entry.parentConversationId,
    },
    status: 'active',
    boundAt: entry.boundAt,
    metadata: {
      ...(entry.metadata ?? {}),
      lastActivityAt: entry.lastActivityAt,
    },
  };
}

function listBindingsForAccount(accountId: string): FeishuBindingEntry[] {
  const state = getBindingState();
  return [...state.bindingsByAccountConversation.values()].filter((entry) => entry.accountId === accountId);
}

function findLatestBindingByParentConversation(accountId: string, parentConversationId: string): FeishuBindingEntry | null {
  const normalizedParentConversationId = normalizeConversationId(parentConversationId);
  if (!normalizedParentConversationId) return null;

  const candidates = listBindingsForAccount(accountId)
    .filter((entry) => entry.parentConversationId === normalizedParentConversationId)
    .sort((left, right) => right.lastActivityAt - left.lastActivityAt);

  return candidates[0] ?? null;
}

function getBindingByConversation(accountId: string, conversationId: string): FeishuBindingEntry | null {
  const state = getBindingState();
  return state.bindingsByAccountConversation.get(toBindingKey(accountId, conversationId)) ?? null;
}

function setBinding(entry: FeishuBindingEntry): FeishuBindingEntry {
  const state = getBindingState();
  state.bindingsByAccountConversation.set(toBindingKey(entry.accountId, entry.conversationId), entry);
  return entry;
}

function deleteBinding(accountId: string, conversationId: string): FeishuBindingEntry | null {
  const state = getBindingState();
  const key = toBindingKey(accountId, conversationId);
  const existing = state.bindingsByAccountConversation.get(key) ?? null;
  if (existing) {
    state.bindingsByAccountConversation.delete(key);
  }
  return existing;
}

function createFeishuSessionBindingAdapter(accountId: string): SessionBindingAdapter {
  return {
    channel: 'feishu',
    accountId,
    capabilities: {
      // Current-thread binding is the true MVP. We also advertise child so ACP
      // thread=true can pass the core capability gate on the current runtime.
      placements: ['current', 'child'],
      bindSupported: true,
      unbindSupported: true,
    },
    resolveConversationForSpawn: ({ to, threadId }) =>
      buildFeishuConversationRef({
        accountId,
        chatId: resolveConversationParentTarget(to),
        threadId,
        rootId: typeof threadId === 'string' && threadId.startsWith('om_') ? threadId : undefined,
      }),
    bind: async (input) => {
      if (input.conversation.channel !== 'feishu') return null;

      const conversationId = normalizeConversationId(input.conversation.conversationId);
      if (!conversationId) return null;

      const now = Date.now();
      const existing = getBindingByConversation(accountId, conversationId);
      const entry: FeishuBindingEntry = {
        accountId,
        conversationId,
        parentConversationId: normalizeConversationId(input.conversation.parentConversationId),
        targetSessionKey: input.targetSessionKey.trim(),
        targetKind: input.targetKind,
        boundAt: now,
        lastActivityAt: now,
        metadata: {
          ...(existing?.metadata ?? {}),
          ...(input.metadata ?? {}),
          placement: input.placement ?? 'current',
        },
      };
      return toSessionBindingRecord(setBinding(entry));
    },
    listBySession: (targetSessionKeyRaw) => {
      const targetSessionKey = targetSessionKeyRaw.trim();
      if (!targetSessionKey) return [];
      return listBindingsForAccount(accountId)
        .filter((entry) => entry.targetSessionKey === targetSessionKey)
        .map(toSessionBindingRecord);
    },
    resolveByConversation: (ref) => {
      if (ref.channel !== 'feishu') return null;
      const conversationId = normalizeConversationId(ref.conversationId);
      if (!conversationId) return null;
      const binding = getBindingByConversation(accountId, conversationId);
      if (binding) return toSessionBindingRecord(binding);

      // Some Feishu follow-up messages only carry chat-level context even when
      // the original ACP session was bound to a topic/root thread. In that
      // case, fall back to the latest active binding in the same chat.
      const parentConversationId = normalizeConversationId(ref.parentConversationId) ?? conversationId;
      const fallbackBinding = parentConversationId
        ? findLatestBindingByParentConversation(accountId, parentConversationId)
        : null;
      return fallbackBinding ? toSessionBindingRecord(fallbackBinding) : null;
    },
    touch: (bindingId, at) => {
      const prefix = `${accountId}:`;
      if (!bindingId.startsWith(prefix)) return;
      const conversationId = bindingId.slice(prefix.length).trim();
      if (!conversationId) return;
      const existing = getBindingByConversation(accountId, conversationId);
      if (!existing) return;
      setBinding({
        ...existing,
        lastActivityAt: typeof at === 'number' && Number.isFinite(at) ? Math.floor(at) : Date.now(),
      });
    },
    unbind: async (input) => {
      const removed: SessionBindingRecord[] = [];

      if (input.bindingId) {
        const prefix = `${accountId}:`;
        if (input.bindingId.startsWith(prefix)) {
          const conversationId = input.bindingId.slice(prefix.length).trim();
          const removedEntry = deleteBinding(accountId, conversationId);
          if (removedEntry) removed.push(toSessionBindingRecord(removedEntry));
        }
      }

      if (removed.length > 0 || !input.targetSessionKey) return removed;

      const targetSessionKey = input.targetSessionKey.trim();
      if (!targetSessionKey) return removed;

      for (const entry of listBindingsForAccount(accountId)) {
        if (entry.targetSessionKey !== targetSessionKey) continue;
        const removedEntry = deleteBinding(accountId, entry.conversationId);
        if (removedEntry) removed.push(toSessionBindingRecord(removedEntry));
      }

      return removed;
    },
  };
}

export function resolveFeishuConversationId(params: {
  chatId?: string | null;
  rootId?: string | null;
  threadId?: string | number | null;
}): string | null {
  const rootId = normalizeConversationId(params.rootId);
  if (rootId) return rootId;

  const threadId = params.threadId != null ? normalizeConversationId(String(params.threadId)) : undefined;
  if (threadId) return threadId;

  const chatId = normalizeConversationId(params.chatId);
  if (chatId) return chatId;

  return null;
}

export function buildFeishuConversationRef(params: {
  accountId: string;
  chatId?: string | null;
  rootId?: string | null;
  threadId?: string | number | null;
}): ConversationRef | null {
  const conversationId = resolveFeishuConversationId(params);
  const chatId = normalizeConversationId(params.chatId);
  if (!conversationId || !chatId) return null;
  return {
    channel: 'feishu',
    accountId: normalizeAccountId(params.accountId),
    conversationId,
    parentConversationId: chatId,
  };
}

function registerFeishuSessionBindingAdapterForAccount(accountId: string): void {
  try {
    registerSessionBindingAdapter(createFeishuSessionBindingAdapter(accountId));
    log.info(`registered Feishu session binding adapter for ${accountId}`);
  } catch (error) {
    const message = String(error);
    if (!message.includes('already registered')) {
      throw error;
    }
  }
}

export function registerFeishuSessionBindingAdapters(cfg: ClawdbotConfig): void {
  for (const accountId of getLarkAccountIds(cfg)) {
    registerFeishuSessionBindingAdapterForAccount(normalizeAccountId(accountId));
  }
}

export function unregisterFeishuSessionBindingAdapters(cfg: ClawdbotConfig): void {
  for (const accountId of getLarkAccountIds(cfg)) {
    unregisterSessionBindingAdapter({ channel: 'feishu', accountId: normalizeAccountId(accountId) });
  }
}

function resolveThreadBindingsEnabled(cfg: ClawdbotConfig, accountId: string): boolean {
  const account = getLarkAccount(cfg, accountId);
  return account.enabled !== false && account.configured !== false;
}

export function registerFeishuSubagentHooks(api: OpenClawPluginApi): void {
  api.on('gateway_start', () => {
    registerFeishuSessionBindingAdapters(api.config);
  });

  api.on('subagent_spawning', async (event) => {
    if (!event.threadRequested) return;
    const channel = event.requester?.channel?.trim().toLowerCase();
    if (channel !== 'feishu') return;

    const accountId = normalizeAccountId(event.requester?.accountId);
    if (!resolveThreadBindingsEnabled(api.config, accountId)) {
      return {
        status: 'error' as const,
        error: 'Feishu thread bindings are unavailable for this account.',
      };
    }

    const bindingService = getSessionBindingService();

    const conversationRef = buildFeishuConversationRef({
      accountId,
      chatId: resolveConversationParentTarget(event.requester?.to),
      threadId: event.requester?.threadId,
      rootId: typeof event.requester?.threadId === 'string' && event.requester.threadId.startsWith('om_')
        ? event.requester.threadId
        : undefined,
    });

    if (!conversationRef) {
      return {
        status: 'error' as const,
        error: 'Unable to resolve Feishu conversation for thread binding.',
      };
    }

    await bindingService.bind({
      targetSessionKey: event.childSessionKey,
      targetKind: 'subagent',
      conversation: conversationRef,
      placement: 'current',
      metadata: {
        agentId: event.agentId,
        label: event.label,
        boundBy: 'system',
      },
    });

    return { status: 'ok' as const, threadBindingReady: true };
  });

  api.on('subagent_delivery_target', (event) => {
    if (!event.expectsCompletionMessage) return;
    const requesterChannel = event.requesterOrigin?.channel?.trim().toLowerCase();
    if (requesterChannel !== 'feishu') return;

    const bindingService = getSessionBindingService();

    const accountId = normalizeAccountId(event.requesterOrigin?.accountId);
    const binding = bindingService
      .listBySession(event.childSessionKey)
      .find((entry) => entry.conversation.channel === 'feishu' && entry.conversation.accountId === accountId && entry.status === 'active');

    if (!binding) return;

    return {
      origin: {
        channel: 'feishu',
        accountId: binding.conversation.accountId,
        to: `channel:${binding.conversation.parentConversationId ?? binding.conversation.conversationId}`,
        threadId: binding.conversation.conversationId,
      },
    };
  });

  api.on('subagent_ended', async (event) => {
    const bindingService = getSessionBindingService();

    const bindings = bindingService.listBySession(event.targetSessionKey);
    if (bindings.length === 0) return;

    await bindingService.unbind({
      targetSessionKey: event.targetSessionKey,
      reason: event.reason,
    });
  });
}
