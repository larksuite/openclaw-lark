/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Drive comment event context resolution.
 *
 * Resolves the full context for a `drive.notice.comment_add_v1` event:
 * document title, comment quoted text, and reply chain.
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import type { FeishuDriveCommentEvent } from '../types';
import { LarkClient } from '../../core/lark-client';
import { larkLogger } from '../../core/lark-logger';

const logger = larkLogger('inbound/comment-context');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Resolved context for a Drive comment event. */
export interface CommentEventTurn {
  /** Document title (best-effort, may be undefined). */
  docTitle?: string;
  /** File type of the document. */
  fileType: string;
  /** File token of the document. */
  fileToken: string;
  /** Root comment ID. */
  commentId: string;
  /** Reply ID (if this event is a reply). */
  replyId?: string;
  /** Quoted text from the comment (the content being commented on). */
  quotedText?: string;
  /** The text of the triggering comment/reply. */
  commentText?: string;
  /** Reply chain context (previous replies in the thread). */
  replyChainContext?: string;
  /** Whether the bot was @-mentioned. */
  isMentioned?: boolean;
  /** Whether the source comment is a whole-document comment. */
  isWholeComment?: boolean;
  /** Surface prompt for the agent (context + instructions). */
  prompt: string;
  /** Short preview of the prompt. */
  preview: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract plain text from comment element arrays.
 */
function extractElementText(elements: unknown[]): string {
  if (!Array.isArray(elements)) return '';
  return elements
    .map((el: any) => {
      if (el.type === 'text_run' && el.text_run?.text) return el.text_run.text;
      if (el.type === 'person' && el.person?.user_id) return `@${el.person.user_id}`;
      if (el.type === 'docs_link' && el.docs_link?.url) return el.docs_link.url;
      // Fallback for simplified element formats
      if (el.text) return el.text;
      return '';
    })
    .join('');
}

/**
 * Extract text from a comment reply object.
 */
function extractReplyText(reply: any): string {
  if (!reply?.content?.elements) return '';
  return extractElementText(reply.content.elements);
}

/**
 * Infer whether a Drive comment thread is a whole-document comment.
 *
 * The explicit `is_whole` flag is authoritative when present. When the API
 * omits it, the root comment's quoted anchor is the best fallback signal:
 * whole-document comments have no quote, while anchored comments do.
 *
 * Note that this inference is about the root thread, so it must behave the
 * same for both root-comment events and reply events.
 */
export function inferIsWholeComment(params: {
  explicitIsWhole?: boolean;
  quotedText?: string;
}): boolean {
  if (typeof params.explicitIsWhole === 'boolean') {
    return params.explicitIsWhole;
  }

  return !params.quotedText?.trim();
}

/**
 * Fetch document title via Drive file meta API.
 */
async function fetchDocTitle(params: {
  cfg: ClawdbotConfig;
  fileToken: string;
  fileType: string;
  accountId?: string;
}): Promise<string | undefined> {
  const { cfg, fileToken, fileType, accountId } = params;
  try {
    const client = LarkClient.fromCfg(cfg, accountId);
    const res = await (client.sdk as any).drive.v1.fileMeta.batchQuery({
      data: {
        request_docs: [{ doc_token: fileToken, doc_type: fileType }],
        with_url: false,
      },
    });
    const meta = res?.data?.metas?.[0];
    return meta?.title || undefined;
  } catch (err) {
    logger.warn(`failed to fetch doc title: ${err}`);
    return undefined;
  }
}

/**
 * Fetch a single comment with its replies.
 */
async function fetchComment(params: {
  cfg: ClawdbotConfig;
  fileToken: string;
  fileType: string;
  commentId: string;
  accountId?: string;
}): Promise<{ comment: any; replies: any[] } | undefined> {
  const { cfg, fileToken, fileType, commentId, accountId } = params;
  try {
    const client = LarkClient.fromCfg(cfg, accountId);

    // Paginate through comments to find the target comment.
    // Cap at MAX_COMMENT_PAGES to avoid excessive OAPI calls on
    // documents with thousands of comments.
    const MAX_COMMENT_PAGES = 5; // 5 × 100 = 500 comments max scan
    let comment: any = undefined;
    let commentPageToken: string | undefined;
    let commentHasMore = true;
    let commentPages = 0;

    while (commentHasMore && !comment && commentPages < MAX_COMMENT_PAGES) {
      commentPages++;
      const res = await client.sdk.drive.v1.fileComment.list({
        path: { file_token: fileToken },
        params: {
          file_type: fileType as any,
          page_size: 100,
          page_token: commentPageToken,
          user_id_type: 'open_id',
        },
      });

      const data = res?.data as any;
      const items = data?.items ?? [];
      comment = items.find((c: any) => c.comment_id === commentId);
      commentHasMore = data?.has_more ?? false;
      commentPageToken = data?.page_token;
    }

    if (!comment) return undefined;

    // Fetch complete replies
    const replies: any[] = [];
    let pageToken: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const replyRes = await client.sdk.drive.v1.fileCommentReply.list({
        path: { file_token: fileToken, comment_id: commentId },
        params: {
          file_type: fileType as any,
          page_token: pageToken,
          page_size: 50,
          user_id_type: 'open_id',
        },
      });

      const replyData = replyRes?.data as any;
      if (replyData?.items) {
        replies.push(...replyData.items);
        hasMore = replyData.has_more ?? false;
        pageToken = replyData.page_token;
      } else {
        break;
      }
    }

    return { comment, replies };
  } catch (err) {
    logger.warn(`failed to fetch comment: ${err}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Surface prompt
// ---------------------------------------------------------------------------

/**
 * Build the surface prompt sent to the agent for a Drive comment event.
 *
 * Includes document context (title, quoted text, comment text) and
 * behavioural instructions aligned with the upstream PR.
 */
function buildDriveCommentSurfacePrompt(params: {
  noticeType: 'add_comment' | 'add_reply';
  fileType: string;
  fileToken: string;
  commentId: string;
  replyId?: string;
  isMentioned?: boolean;
  documentTitle?: string;
  quoteText?: string;
  rootCommentText?: string;
  targetReplyText?: string;
}): string {
  const documentLabel = params.documentTitle
    ? `"${params.documentTitle}"`
    : `${params.fileType} document ${params.fileToken}`;
  const actionLabel = params.noticeType === 'add_reply' ? 'reply' : 'comment';
  const firstLine = params.targetReplyText
    ? `The user added a ${actionLabel} in ${documentLabel}: ${params.targetReplyText}`
    : `The user added a ${actionLabel} in ${documentLabel}.`;
  const lines = [firstLine];
  if (
    params.noticeType === 'add_reply' &&
    params.rootCommentText &&
    params.rootCommentText !== params.targetReplyText
  ) {
    lines.push(`Original comment: ${params.rootCommentText}`);
  }
  if (params.quoteText) {
    lines.push(`Quoted content: ${params.quoteText}`);
  }
  if (params.isMentioned === true) {
    lines.push('This comment mentioned you.');
  }
  lines.push(
    `Event type: ${params.noticeType}`,
    `file_token: ${params.fileToken}`,
    `file_type: ${params.fileType}`,
    `comment_id: ${params.commentId}`,
  );
  if (params.replyId?.trim()) {
    lines.push(`reply_id: ${params.replyId.trim()}`);
  }
  lines.push(
    'This is a Feishu document comment-thread event, not a Feishu IM conversation. Your final text reply will be posted automatically to the current comment thread and will not be sent as an instant message.',
    'If you need to inspect or handle the comment thread, prefer the feishu_drive tools: use list_comments / list_comment_replies to inspect comments, and use reply_comment/add_comment to notify the user after modifying the document.',
    'If the comment asks you to modify document content, such as adding, inserting, replacing, or deleting text, tables, or headings, you must first use feishu_doc to actually modify the document. Do not reply with only "done", "I\'ll handle it", or a restated plan without calling tools.',
    'If the comment quotes document content, that quoted text is usually the edit anchor. For requests like "insert xxx below this content", first locate the position around the quoted content, then use feishu_doc to make the change.',
    'If the comment asks you to summarize, explain, rewrite, translate, refine, continue, or review the document content "below", "above", "this paragraph", "this section", or the quoted content, you must also treat the quoted content as the primary target anchor instead of defaulting to the whole document.',
    'For requests like "summarize the content below", "explain this section", or "continue writing from here", first locate the relevant document fragment based on the comment\'s quoted content. If the quote is not sufficient to support the answer, then use feishu_doc.read or feishu_doc.list_blocks to read nearby context.',
    'Do not guess document content based only on the comment text, and do not output a vague summary before reading enough context. Unless the user explicitly asks to summarize the entire document, default to handling only the local scope related to the quoted content.',
    'When document edits are involved, first use feishu_doc.read or feishu_doc.list_blocks to confirm the context, then use feishu_doc writing or updating capabilities to complete the change. After the edit succeeds, notify the user through feishu_drive.reply_comment.',
    'If the document edit fails or you cannot locate the anchor, do not pretend it succeeded. Reply clearly in the comment thread with the reason for failure or the missing information.',
    'If this is a reading-comprehension task, such as summarization, explanation, or extraction, you may directly output the final answer text after confirming the context. The system will automatically reply with that answer in the current comment thread.',
    'When you produce a user-visible reply, keep it in the same language as the user\'s original comment or reply unless they explicitly ask for another language.',
    'If you have already completed the user-visible action through feishu_drive.reply_comment or feishu_drive.add_comment, output NO_REPLY at the end to avoid duplicate sending.',
    'If the user directly asks a question in the comment and a plain text answer is sufficient, output the answer text directly. The system will automatically reply with your final answer in the current comment thread.',
    'If you determine that the current comment does not require any user-visible action, output NO_REPLY at the end.',
  );
  lines.push(`Decide what to do next based on this document ${actionLabel} event.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the full context for a Drive comment event.
 *
 * Fetches document metadata, comment content, and reply chain.
 */
export async function resolveDriveCommentEventTurn(params: {
  cfg: ClawdbotConfig;
  event: FeishuDriveCommentEvent;
  accountId?: string;
}): Promise<CommentEventTurn | null> {
  const { cfg, event, accountId } = params;
  const fileToken = event.file_token;
  const fileType = event.file_type ?? 'docx';
  const commentId = event.comment_id;

  if (!fileToken || !commentId) {
    logger.warn('missing file_token or comment_id in comment event');
    return null;
  }

  // Fetch document title and comment context in parallel
  const [docTitle, commentData] = await Promise.all([
    fetchDocTitle({ cfg, fileToken, fileType, accountId }),
    fetchComment({ cfg, fileToken, fileType, commentId, accountId }),
  ]);

  let quotedText: string | undefined;
  let commentText: string | undefined;
  let replyChainContext: string | undefined;
  let isWholeComment = false;

  if (commentData) {
    // Extract quoted text from the root comment
    if (commentData.comment?.quote) {
      quotedText = String(commentData.comment.quote);
    }

    isWholeComment = inferIsWholeComment({
      explicitIsWhole: commentData.comment?.is_whole,
      quotedText,
    });

    // Determine the triggering text
    if (event.reply_id && commentData.replies.length > 0) {
      // This is a reply event — find the specific reply
      const targetReply = commentData.replies.find((r: any) => r.reply_id === event.reply_id);
      commentText = targetReply ? extractReplyText(targetReply) : undefined;

      // Build reply chain context (all replies before the target)
      const chainReplies = commentData.replies.filter(
        (r: any) => r.reply_id !== event.reply_id,
      );
      if (chainReplies.length > 0) {
        replyChainContext = chainReplies
          .map((r: any) => {
            const sender = r.user_id?.open_id ?? 'unknown';
            const text = extractReplyText(r);
            return `[${sender}]: ${text}`;
          })
          .join('\n');
      }
    } else {
      // This is a root comment event
      const rootReply = commentData.comment?.reply_list?.replies?.[0];
      commentText = rootReply ? extractReplyText(rootReply) : undefined;
    }
  }

  // Determine notice type and root comment text for prompt building
  const noticeType: 'add_comment' | 'add_reply' = event.reply_id ? 'add_reply' : 'add_comment';
  let rootCommentText: string | undefined;
  if (commentData) {
    const rootReply = commentData.comment?.reply_list?.replies?.[0];
    rootCommentText = rootReply ? extractReplyText(rootReply) : undefined;
  }

  const isMentioned = event.notice_meta?.is_mentioned ?? event.is_mention;

  const prompt = buildDriveCommentSurfacePrompt({
    noticeType,
    fileType,
    fileToken,
    commentId,
    replyId: event.reply_id,
    isMentioned,
    documentTitle: docTitle,
    quoteText: quotedText,
    rootCommentText,
    targetReplyText: commentText,
  });
  const preview = prompt.replace(/\s+/g, ' ').slice(0, 160);

  return {
    docTitle,
    fileType,
    fileToken,
    commentId,
    replyId: event.reply_id,
    quotedText,
    commentText,
    replyChainContext,
    isMentioned,
    isWholeComment,
    prompt,
    preview,
  };
}

// ---------------------------------------------------------------------------
// Event payload parsing
// ---------------------------------------------------------------------------

/**
 * Parse the raw webhook payload for a `drive.notice.comment_add_v1` event.
 *
 * The SDK flattens the v2 envelope, so the event data may be at the
 * top level or nested under `event`. User info and timestamp live inside
 * `notice_meta` in the real event structure, with fallback to top-level
 * fields for compatibility with different SDK flattening styles.
 */
/**
 * Normalize a Drive comment event into a canonical shape.
 *
 * Real event structures vary:
 *   - **notice_meta style**: file_token, file_type, from_user_id, timestamp
 *     all live inside `notice_meta`; top-level only has comment_id/reply_id.
 *   - **SDK-flattened style**: fields may be hoisted to top level.
 *
 * This parser checks `notice_meta.*` first, then falls back to top-level
 * fields, so the handler can consume a single canonical shape.
 */
export function parseFeishuDriveCommentNoticeEventPayload(data: unknown): FeishuDriveCommentEvent | null {
  if (!data || typeof data !== 'object') return null;

  const raw = data as Record<string, unknown>;
  // Handle both flattened and nested event formats
  const event = (raw.event ?? raw) as Record<string, unknown>;

  // notice_meta is the primary source for most fields in real events
  const noticeMeta = (event.notice_meta ?? raw.notice_meta) as Record<string, unknown> | undefined;

  // file_token: notice_meta > top-level event > top-level raw
  const fileToken = (
    noticeMeta?.file_token ?? event.file_token ?? raw.file_token
  ) as string | undefined;

  // file_type: notice_meta > top-level
  const fileType = (
    noticeMeta?.file_type ?? event.file_type ?? raw.file_type
  ) as string | undefined;

  // comment_id / reply_id are typically at event top-level
  const commentId = (event.comment_id ?? raw.comment_id) as string | undefined;
  const replyId = (event.reply_id ?? raw.reply_id) as string | undefined;

  if (!fileToken || !commentId) return null;

  // User info: notice_meta.from_user_id > top-level user_id
  const metaUserId = noticeMeta?.from_user_id as Record<string, unknown> | undefined;
  const fallbackUserId = (event.user_id ?? raw.user_id) as Record<string, unknown> | undefined;
  const userId = metaUserId ?? fallbackUserId;

  // Timestamp: notice_meta.timestamp > top-level action_time
  const timestamp = (
    noticeMeta?.timestamp ?? event.action_time ?? raw.action_time
  ) as string | undefined;

  // Mention flag: notice_meta.is_mentioned > top-level is_mention
  const isMentioned = (
    noticeMeta?.is_mentioned ?? event.is_mention ?? raw.is_mention
  ) as boolean | undefined;

  // Build the canonical, normalized event
  return {
    app_id: (raw.app_id ?? event.app_id) as string | undefined,
    // Canonical fields — always populated from the best source
    file_token: fileToken,
    file_type: fileType,
    comment_id: commentId,
    reply_id: replyId,
    // notice_meta preserved for debugging
    notice_meta: noticeMeta
      ? {
          from_user_id: userId as any,
          file_token: fileToken,
          file_type: fileType,
          timestamp,
          is_mentioned: isMentioned,
        }
      : undefined,
    // Normalized top-level convenience fields (canonical)
    is_mention: isMentioned,
    user_id: userId as any,
    action_time: timestamp,
  };
}
