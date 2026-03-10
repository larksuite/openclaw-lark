/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Context enrichment for inbound Feishu messages.
 *
 * Enrichment phases:
 *
 * - **resolveSenderInfo** (lightweight, before gate) — resolves sender
 *   display name and tracks permission errors.
 * - **prefetchUserNames** (after gate, before content resolution) — batch
 *   pre-warm the account-scoped user-name cache for the sender and all
 *   non-bot mentions so that downstream merge_forward expansion and
 *   quoted-message formatting can read names synchronously.
 * - **resolveMedia** (after gate) — downloads binary media attachments
 *   using ResourceDescriptors from the converter phase.
 * - **resolveQuotedContent** (after gate) — fetches the replied-to
 *   message text for context.
 *
 * Note: merge_forward expansion for the primary message is now handled
 * at parse time in {@link parseMessageEvent}. Quoted merge_forward
 * messages are still expanded here via {@link resolveQuotedContent}.
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import type { MessageContext, FeishuMediaInfo } from '../types';
import type { LarkAccount } from '../../core/types';
import type { PermissionError } from './permission';
import { PERMISSION_ERROR_COOLDOWN_MS, permissionErrorNotifiedAt } from './permission';
import { resolveUserName } from './user-name-cache';
import { downloadResources, buildFeishuMediaPayload } from './media-resolver';
import { getMessageFeishu } from '../outbound/fetch';
import { getUserNameCache, batchResolveUserNames } from './user-name-cache';

// ---------------------------------------------------------------------------
// Phase 1: Sender info (lightweight, before gate)
// ---------------------------------------------------------------------------

/**
 * Resolve the sender display name and track permission errors.
 *
 * This must run before the gate check because per-group sender
 * allowlists may match on senderName.
 */
export async function resolveSenderInfo(params: {
  ctx: MessageContext;
  account: LarkAccount;
  log: (...args: unknown[]) => void;
}): Promise<{ ctx: MessageContext; permissionError?: PermissionError }> {
  const { account, log } = params;
  let ctx = params.ctx;

  // Only resolve display name for real users — the contact API
  // does not return results for app/bot accounts.
  if (ctx.rawSender?.sender_type !== 'user') {
    log(`sender_type is "${ctx.rawSender?.sender_type}", skipping name resolution`);
    return { ctx };
  }

  // Resolve sender display name (best-effort)
  const senderResult = await resolveUserName({
    account,
    openId: ctx.senderId,
    log,
  });
  if (senderResult.name) {
    ctx = { ...ctx, senderName: senderResult.name };
    log(`sender resolved: ${senderResult.name}`);
  } else if (senderResult.permissionError) {
    log(`sender resolve failed: permission error code=${senderResult.permissionError.code}`);
  }

  // Track permission errors (with cooldown)
  let permissionError: PermissionError | undefined;
  if (senderResult.permissionError) {
    const appKey = account.appId ?? 'default';
    const now = Date.now();
    const lastNotified = permissionErrorNotifiedAt.get(appKey) ?? 0;

    if (now - lastNotified > PERMISSION_ERROR_COOLDOWN_MS) {
      permissionErrorNotifiedAt.set(appKey, now);
      permissionError = senderResult.permissionError;
    }
  }

  return { ctx, permissionError };
}

// ---------------------------------------------------------------------------
// Phase 1.5: Batch pre-warm user name cache (after gate)
// ---------------------------------------------------------------------------

/**
 * Batch-prefetch user display names for the sender and all non-bot
 * mentions. Mention names that are already known from the event payload
 * are written into the cache for free.
 */
export async function prefetchUserNames(params: {
  ctx: MessageContext;
  account: LarkAccount;
  log: (...args: unknown[]) => void;
}): Promise<void> {
  const { ctx, account, log } = params;
  if (!account.configured) return;

  const cache = getUserNameCache(account.accountId);

  // Seed cache with mention names already present in the event payload
  for (const m of ctx.mentions) {
    if (!m.isBot && m.openId && m.name) {
      cache.set(m.openId, m.name);
    }
  }

  // Collect all openIds we care about
  const openIds = new Set<string>();
  if (ctx.senderId) openIds.add(ctx.senderId);
  for (const m of ctx.mentions) {
    if (!m.isBot && m.openId) openIds.add(m.openId);
  }

  // Batch-resolve any that are still missing
  const toResolve = cache.filterMissing([...openIds]);
  if (toResolve.length > 0) {
    await batchResolveUserNames({ account, openIds: toResolve, log });
  }
}

// ---------------------------------------------------------------------------
// Phase 2a: Media attachments (binary downloads)
// ---------------------------------------------------------------------------

/** Result of media resolution: envelope payload + per-file mapping. */
export interface ResolveMediaResult {
  payload: Record<string, unknown>;
  mediaList: FeishuMediaInfo[];
}

/**
 * Download and save binary media attachments (images, files, audio,
 * video, stickers) from the inbound message.
 *
 * Uses ResourceDescriptors extracted by content converters during the
 * parse phase — no re-parsing of rawMessage.content needed.
 *
 * Returns a payload object whose keys (`MediaPath`, `MediaType`, …)
 * are spread directly into the agent envelope, plus the raw mediaList
 * for content substitution.
 */
export async function resolveMedia(params: {
  ctx: MessageContext;
  /** account 级别的 ClawdbotConfig（channels.feishu 已替换为 per-account 合并后的配置） */
  accountScopedCfg: ClawdbotConfig;
  account: LarkAccount;
  log: (...args: unknown[]) => void;
}): Promise<ResolveMediaResult> {
  const { ctx, accountScopedCfg, account, log } = params;
  const accountFeishuCfg = account.config;

  const mediaMaxBytes = (accountFeishuCfg?.mediaMaxMb ?? 30) * 1024 * 1024;

  const mediaList = await downloadResources({
    cfg: accountScopedCfg,
    messageId: ctx.messageId,
    resources: ctx.resources,
    maxBytes: mediaMaxBytes,
    log,
    accountId: account.accountId,
  });

  if (mediaList.length > 0) {
    log(`media resolved: ${mediaList.length} attachment(s)`);
  }

  return {
    payload: buildFeishuMediaPayload(mediaList),
    mediaList,
  };
}

// ---------------------------------------------------------------------------
// Media content substitution
// ---------------------------------------------------------------------------

/**
 * Replace Feishu file-key references in message content with actual
 * local file paths after download.
 *
 * This is critical for:
 * - **Images / stickers**: The SDK's `detectAndLoadPromptImages` scans
 *   the prompt text for local file paths with image extensions.
 * - **Audio / video / files**: Gives the AI meaningful context about
 *   what was received (the SDK reads these via `MediaPath` directly,
 *   but the text body should still reflect the actual attachments).
 */
export function substituteMediaPaths(content: string, mediaList: FeishuMediaInfo[]): string {
  let result = content;
  for (const media of mediaList) {
    const { fileKey, path, resourceType } = media;
    switch (resourceType) {
      case 'image':
        // ![image](img_v3_xxx) → local path (SDK detects image extensions)
        result = result.replace(`![image](${fileKey})`, path);
        break;
      case 'sticker':
        // <sticker key="xxx"/> → local path (treated like image)
        result = result.replace(`<sticker key="${fileKey}"/>`, path);
        break;
      case 'audio': {
        // <audio key="xxx" .../> → [Audio: /path/to/audio.opus ...]
        const audioRe = new RegExp(`<audio key="${escapeRegExp(fileKey)}"[^/]*/>`);
        result = result.replace(audioRe, `[Audio: ${path}]`);
        break;
      }
      case 'file': {
        // <file key="xxx" .../> → [File: /path/to/doc.pdf]
        const fileRe = new RegExp(`<file key="${escapeRegExp(fileKey)}"[^/]*/>`);
        result = result.replace(fileRe, `[File: ${path}]`);
        break;
      }
      case 'video': {
        // <video key="xxx" .../> → [Video: /path/to/video.mp4]
        const videoRe = new RegExp(`<video key="${escapeRegExp(fileKey)}"[^/]*/>`);
        result = result.replace(videoRe, `[Video: ${path}]`);
        break;
      }
    }
  }
  return result;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Phase 2b: Quoted / replied-to message (text context)
// ---------------------------------------------------------------------------

/**
 * Fetch the text content of the message that the user replied to.
 *
 * If the quoted message is itself a merge_forward, its sub-messages are
 * fetched and formatted as a single text block.
 *
 * Returns `"senderName: content"` when the sender name is available so
 * the AI knows who originally wrote the quoted message.
 */
export async function resolveQuotedContent(params: {
  ctx: MessageContext;
  /** account 级别的 ClawdbotConfig（channels.feishu 已替换为 per-account 合并后的配置） */
  accountScopedCfg: ClawdbotConfig;
  account: LarkAccount;
  log: (...args: unknown[]) => void;
}): Promise<string | undefined> {
  const { ctx, accountScopedCfg, account, log } = params;

  if (!ctx.parentId) return undefined;

  try {
    const quotedMsg = await getMessageFeishu({
      cfg: accountScopedCfg,
      messageId: ctx.parentId,
      accountId: account.accountId,
      expandForward: true,
    });
    if (!quotedMsg) return undefined;

    log(`feishu[${account.accountId}]: fetched quoted message: ${quotedMsg.content?.slice(0, 100)}`);

    // Build quoted text with message_id prefix so AI can correlate
    // file_key / image_key with the source message for resource download.
    const prefix = `[message_id=${ctx.parentId}]`;
    if (quotedMsg.senderName) {
      return `${prefix} ${quotedMsg.senderName}: ${quotedMsg.content}`;
    }
    return `${prefix} ${quotedMsg.content}`;
  } catch (err) {
    log(`feishu[${account.accountId}]: failed to fetch quoted message: ${String(err)}`);
    return undefined;
  }
}
