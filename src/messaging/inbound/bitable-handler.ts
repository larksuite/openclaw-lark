/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Bitable record-changed event handler for the Lark/Feishu channel plugin.
 *
 * Handles `drive.file.bitable_record_changed_v1` events by building a
 * synthetic {@link MessageContext} that describes the record change and
 * dispatching it to the agent via {@link dispatchToAgent}, bypassing the
 * full 7-stage message pipeline.
 *
 * Routing is driven by `bitableNotifications` in the account config:
 * each entry maps a `fileToken` (bitable app token) to a target `chatId`.
 * When a record-changed event arrives, all matching entries are notified.
 *
 * The feature requires the application to have previously subscribed to
 * bitable file events via the `drive.file.subscribe` API — this plugin
 * does NOT auto-subscribe; that must be done manually or via tooling.
 */

import * as crypto from 'node:crypto';
import type { ClawdbotConfig, RuntimeEnv, HistoryEntry } from 'openclaw/plugin-sdk';
import { DEFAULT_GROUP_HISTORY_LIMIT } from 'openclaw/plugin-sdk';
import type {
  FeishuBitableRecordChangedEvent,
  FeishuBitableRecordAction,
  FeishuBitableFieldValue,
  MessageContext,
} from '../types';
import { getLarkAccount } from '../../core/accounts';
import { resolveUserName } from './user-name-cache';
import { dispatchToAgent } from './dispatch';
import { resolveFeishuGroupConfig } from './policy';
import { larkLogger } from '../../core/lark-logger';
import { getChatTypeFeishu } from '../../core/chat-info-cache';

const logger = larkLogger('inbound/bitable-handler');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse a JSON-serialised `field_value` string into a human-readable snippet.
 *
 * Feishu encodes all field values as JSON strings. We attempt to summarise
 * the parsed value in a compact, readable form for the AI context message.
 */
function parseFieldValueSnippet(raw: string): string {
  if (!raw) return '(empty)';

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON — return the raw string trimmed
    return raw.slice(0, 200);
  }

  if (typeof parsed === 'string') return parsed.slice(0, 200);
  if (typeof parsed === 'number' || typeof parsed === 'boolean') return String(parsed);

  if (Array.isArray(parsed)) {
    // Rich text / link / person arrays — extract text content
    const parts: string[] = [];
    for (const item of parsed as Record<string, unknown>[]) {
      if (typeof item === 'object' && item !== null) {
        const text = (item as Record<string, unknown>).text;
        const name = (item as Record<string, unknown>).name;
        if (typeof text === 'string') parts.push(text);
        else if (typeof name === 'string') parts.push(name);
      }
    }
    const joined = parts.join(', ');
    return joined.slice(0, 200) || JSON.stringify(parsed).slice(0, 200);
  }

  return JSON.stringify(parsed).slice(0, 200);
}

/**
 * Format a list of changed fields as a Markdown-ish table row.
 */
function formatFields(fields: FeishuBitableFieldValue[]): string {
  return fields
    .map((f) => `  • ${f.field_id}: ${parseFieldValueSnippet(f.field_value)}`)
    .join('\n');
}

/**
 * Render a single record action as a human-readable block.
 */
function formatAction(action: FeishuBitableRecordAction, idx: number): string {
  const header = `[记录 ${idx + 1}] ${action.record_id} (${action.action})`;
  const lines: string[] = [header];

  if (action.action === 'record_edited') {
    if (action.before_value?.length) {
      lines.push('  变更前:');
      lines.push(formatFields(action.before_value));
    }
    if (action.after_value?.length) {
      lines.push('  变更后:');
      lines.push(formatFields(action.after_value));
    }
  } else if (action.action === 'record_added') {
    if (action.after_value?.length) {
      lines.push('  新增字段:');
      lines.push(formatFields(action.after_value));
    }
  } else if (action.action === 'record_deleted') {
    if (action.before_value?.length) {
      lines.push('  删除的字段值:');
      lines.push(formatFields(action.before_value));
    }
  }

  return lines.join('\n');
}

/**
 * Build the text body of the synthetic notification message.
 */
function buildNotificationText(
  event: FeishuBitableRecordChangedEvent,
  label: string | undefined,
  operatorName: string | undefined,
): string {
  const tableLabel = label ? `【${label}】` : '';
  const actor = operatorName ?? event.operator_id?.open_id ?? '未知用户';
  const ts = event.update_time
    ? new Date(event.update_time * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    : undefined;

  const lines: string[] = [];
  lines.push(`[多维表格记录变更]${tableLabel}`);
  lines.push(`操作人：${actor}${ts ? `  时间：${ts}` : ''}`);
  lines.push(`多维表格 Token：${event.file_token}  数据表：${event.table_id}`);
  lines.push('');

  const actions = event.action_list ?? [];
  if (actions.length === 0) {
    lines.push('(无记录变更详情)');
  } else {
    for (let i = 0; i < actions.length; i++) {
      lines.push(formatAction(actions[i], i));
      if (i < actions.length - 1) lines.push('');
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BitableNotificationTarget {
  fileToken: string;
  chatId: string;
  tableIds?: string[];
  label?: string;
}

/**
 * Resolve which notification targets should receive the given bitable event.
 *
 * Matches on `fileToken` (required) and optionally filters by `tableIds`.
 */
export function resolveBitableTargets(
  targets: BitableNotificationTarget[],
  event: FeishuBitableRecordChangedEvent,
): BitableNotificationTarget[] {
  return targets.filter((t) => {
    if (t.fileToken !== event.file_token) return false;
    if (t.tableIds && t.tableIds.length > 0) {
      return t.tableIds.includes(event.table_id);
    }
    return true;
  });
}

/**
 * Handle a `drive.file.bitable_record_changed_v1` event.
 *
 * For each matching `bitableNotifications` entry, build a synthetic
 * {@link MessageContext} and dispatch to the agent as if the record-change
 * notification were a user message sent to the target chat.
 */
export async function handleFeishuBitableRecordChanged(params: {
  cfg: ClawdbotConfig;
  event: FeishuBitableRecordChangedEvent;
  runtime?: RuntimeEnv;
  chatHistories?: Map<string, HistoryEntry[]>;
  accountId?: string;
}): Promise<void> {
  const { cfg, event, runtime, chatHistories, accountId } = params;
  const log = runtime?.log ?? ((...args: unknown[]) => logger.info(args.map(String).join(' ')));
  const error = runtime?.error ?? ((...args: unknown[]) => logger.error(args.map(String).join(' ')));

  const account = getLarkAccount(cfg, accountId);
  const accountFeishuCfg = account.config;

  // Resolve notification targets from config
  const rawTargets = (accountFeishuCfg?.bitableNotifications ?? []) as BitableNotificationTarget[];
  const targets = resolveBitableTargets(rawTargets, event);

  if (targets.length === 0) {
    log(`feishu[${accountId}]: bitable_record_changed for ${event.file_token}/${event.table_id} — no matching targets, skipping`);
    return;
  }

  const accountScopedCfg: ClawdbotConfig = {
    ...cfg,
    channels: { ...cfg.channels, feishu: accountFeishuCfg },
  };

  // Resolve operator name once (shared across targets)
  const operatorOpenId = event.operator_id?.open_id ?? '';
  let operatorName: string | undefined;
  if (operatorOpenId) {
    const nameResult = await resolveUserName({ account, openId: operatorOpenId, log });
    operatorName = nameResult.name;
  }

  for (const target of targets) {
    try {
      // Determine chat type for the target chat
      let chatType: 'p2p' | 'group' = 'p2p';
      try {
        chatType = await getChatTypeFeishu({ cfg: accountScopedCfg, chatId: target.chatId, accountId });
      } catch {
        // Default to p2p on error
      }

      const notificationText = buildNotificationText(event, target.label, operatorName);
      const syntheticMessageId = `bitable:${event.file_token}:${event.table_id}:${crypto.randomUUID()}`;

      const ctx: MessageContext = {
        chatId: target.chatId,
        messageId: syntheticMessageId,
        // Use operator's open_id as sender so the agent knows who made the change
        senderId: operatorOpenId || 'bitable-system',
        senderName: operatorName,
        chatType,
        content: notificationText,
        contentType: 'text',
        resources: [],
        mentions: [],
        rawMessage: {
          message_id: syntheticMessageId,
          chat_id: target.chatId,
          chat_type: chatType,
          message_type: 'text',
          content: JSON.stringify({ text: notificationText }),
          create_time: event.update_time ? String(event.update_time * 1000) : String(Date.now()),
        },
        rawSender: {
          sender_id: {
            open_id: operatorOpenId || undefined,
            user_id: event.operator_id?.user_id,
            union_id: event.operator_id?.union_id,
          },
          sender_type: 'user',
        },
      };

      const isGroup = chatType === 'group';
      const groupConfig = isGroup ? resolveFeishuGroupConfig({ cfg: accountFeishuCfg, groupId: target.chatId }) : undefined;
      const defaultGroupConfig = isGroup ? accountFeishuCfg?.groups?.['*'] : undefined;

      const historyLimit = Math.max(
        0,
        accountFeishuCfg?.historyLimit ?? accountScopedCfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
      );

      log(`feishu[${accountId}]: bitable_record_changed ${event.file_token}/${event.table_id} → dispatching to chat ${target.chatId}`);
      logger.info(`bitable record changed: file=${event.file_token} table=${event.table_id} actions=${event.action_list?.length ?? 0} → chat=${target.chatId}`);

      await dispatchToAgent({
        ctx,
        permissionError: undefined,
        mediaPayload: {},
        quotedContent: undefined,
        account,
        accountScopedCfg,
        runtime,
        chatHistories,
        historyLimit,
        replyToMessageId: undefined,
        commandAuthorized: false,
        groupConfig,
        defaultGroupConfig,
        skipTyping: true,
      });
    } catch (err) {
      error(`feishu[${accountId}]: error dispatching bitable record changed to chat ${target.chatId}: ${String(err)}`);
    }
  }
}
