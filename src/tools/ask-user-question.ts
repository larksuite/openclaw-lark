/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * AskUserQuestion tool — AI agent 主动向用户提问并等待回答。
 *
 * 流程（非阻塞，遵循 auto-auth synthetic message 模式）：
 * 1. AI 调用 AskUserQuestion 工具，传入问题和选项
 * 2. 发送 form 交互式飞书卡片
 * 3. 工具 execute() 立即返回 { status: 'pending' }
 * 4. 用户填写表单并点击提交，form_value 一次性回传
 * 5. handleAskUserAction 解析答案，注入 synthetic message
 * 6. AI 在新一轮对话中收到用户答案
 *
 * 所有卡片统一使用 form 容器，交互组件在本地缓存值，
 * 提交时通过 form_value 一次性回调，避免独立回调导致的 loading 闪烁。
 *
 * 注意：提交按钮必须设置 value 字段。飞书客户端会校验交互组件是否携带 value，
 * 缺失时直接报 200340 错误，回调不会发送到服务端。虽然 form_submit 场景下
 * form_value 是主要数据载体，但 value 作为按钮的合法性标记仍需存在。
 */

import { randomUUID } from 'node:crypto';
import type { ClawdbotConfig, OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';
import { getTicket, withTicket } from '../core/lark-ticket';
import { larkLogger } from '../core/lark-logger';
import { createCardEntity, sendCardByCardId, updateCardKitCard } from '../card/cardkit';
import { buildQueueKey, enqueueFeishuChatTask } from '../channel/chat-queue';
import { handleFeishuMessage } from '../messaging/inbound/handler';
import { checkToolRegistration, formatToolError, formatToolResult } from './helpers';

const log = larkLogger('tools/ask-user-question');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ACTION_SUBMIT = 'ask_user_submit';

/** TTL for pending questions: auto-expire after 5 minutes. */
const PENDING_QUESTION_TTL_MS = 5 * 60 * 1000;

/** Max retries for synthetic message injection. */
const INJECT_MAX_RETRIES = 2;

/** Delay between retry attempts (ms). */
const INJECT_RETRY_DELAY_MS = 2000;

/** Field name used for text input inside forms. */
const INPUT_FIELD_NAME = 'answer';

/** Field name used for select components inside forms. */
const SELECT_FIELD_NAME = 'selection';

/** Prefix for submit button name — questionId is appended for identification. */
const SUBMIT_BUTTON_PREFIX = 'ask_user_submit_';

/** Shared V2 card config */
const V2_CONFIG = { wide_screen_mode: true, update_multi: true, locales: ['zh_cn', 'en_us'] };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QuestionItem {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

/** Lightweight context stored while awaiting user response (no Promise / timeout). */
interface QuestionContext {
  questionId: string;
  chatId: string;
  accountId: string;
  senderOpenId: string;
  cardId: string;
  cfg: ClawdbotConfig;
  questions: QuestionItem[];
  threadId?: string;
  chatType?: 'p2p' | 'group';
  messageId: string;
  cardSequence: number;
  submitted: boolean;
  ttlTimer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Pending Question Registry
// ---------------------------------------------------------------------------

const pendingQuestions = new Map<string, QuestionContext>();
/**
 * Secondary index: chatKey → Set<questionId> for fallback lookup when
 * operationId is missing. Uses the base key (accountId:chatId, without
 * threadId) because card action callbacks typically lack thread context.
 * Stores a Set so multiple pending questions in the same chat don't
 * overwrite each other's fallback entry.
 */
const byChatContext = new Map<string, Set<string>>();

/** Arm (or re-arm) the TTL expiry timer for a pending question. */
function armTtlTimer(ctx: QuestionContext, delayMs: number): void {
  clearTimeout(ctx.ttlTimer);
  ctx.ttlTimer = setTimeout(() => {
    if (!pendingQuestions.has(ctx.questionId)) return; // already consumed
    if (ctx.submitted) return; // user already submitted, injection in progress
    log.info(`question ${ctx.questionId} expired (TTL ${delayMs}ms)`);
    consumePendingQuestion(ctx.questionId);
    // Update card to expired state (fire-and-forget)
    setImmediate(async () => {
      try {
        await updateCardToExpired(ctx);
      } catch (err) {
        log.warn(`failed to update card to expired state: ${err}`);
      }
    });
  }, delayMs);
}

function storePendingQuestion(init: Omit<QuestionContext, 'ttlTimer'>): void {
  const ctx = init as QuestionContext;
  pendingQuestions.set(ctx.questionId, ctx);
  const baseKey = buildQueueKey(ctx.accountId, ctx.chatId);
  let set = byChatContext.get(baseKey);
  if (!set) {
    set = new Set();
    byChatContext.set(baseKey, set);
  }
  set.add(ctx.questionId);

  armTtlTimer(ctx, PENDING_QUESTION_TTL_MS);
}

function consumePendingQuestion(questionId: string): void {
  const ctx = pendingQuestions.get(questionId);
  if (ctx) {
    clearTimeout(ctx.ttlTimer);
    pendingQuestions.delete(questionId);
    const baseKey = buildQueueKey(ctx.accountId, ctx.chatId);
    const set = byChatContext.get(baseKey);
    if (set) {
      set.delete(questionId);
      if (set.size === 0) byChatContext.delete(baseKey);
    }
  }
}

/**
 * Targeted chat-scoped fallback: exact accountId:chatId match via secondary index.
 * Used when operationId cannot be extracted from the card callback.
 *
 * Only returns a result when exactly one non-submitted pending question
 * exists for this chat — refuses to guess when ambiguous.
 */
function findQuestionByChat(accountId: string, chatId: string): QuestionContext | undefined {
  const baseKey = buildQueueKey(accountId, chatId);
  const set = byChatContext.get(baseKey);
  if (!set) return undefined;
  let match: QuestionContext | undefined;
  for (const qid of set) {
    const ctx = pendingQuestions.get(qid);
    if (ctx && !ctx.submitted) {
      if (match) {
        // Ambiguous: more than one non-submitted question in this chat.
        // Refuse to guess — operationId is required to disambiguate.
        log.warn(`chat-scoped fallback ambiguous: multiple pending questions in ${baseKey}`);
        return undefined;
      }
      match = ctx;
    }
  }
  return match;
}

// ---------------------------------------------------------------------------
// Field name helpers
// ---------------------------------------------------------------------------

function getInputFieldName(questionIndex: number): string {
  return `${INPUT_FIELD_NAME}_${questionIndex}`;
}

function getSelectFieldName(questionIndex: number): string {
  return `${SELECT_FIELD_NAME}_${questionIndex}`;
}

// ---------------------------------------------------------------------------
// Card Action Handler (used by event-handlers.ts)
// ---------------------------------------------------------------------------

/**
 * 处理 form 表单提交事件。
 *
 * 统一使用 form 后，所有值通过 form_value 一次性提交。
 * 解析答案后注入 synthetic message，AI 在新一轮对话中收到答案。
 *
 * @returns 卡片回调响应，或 undefined 表示非本模块的 action
 */
export function handleAskUserAction(data: unknown, _cfg: ClawdbotConfig, accountId: string): unknown | undefined {
  let action: string | undefined;
  let operationId: string | undefined;
  let senderOpenId: string | undefined;
  let formValue: Record<string, unknown> | undefined;
  let openChatId: string | undefined;

  try {
    const event = data as {
      operator?: { open_id?: string };
      open_chat_id?: string;
      context?: { open_chat_id?: string; open_message_id?: string };
      action?: {
        tag?: string;
        name?: string;
        form_value?: Record<string, unknown>;
        value?: Record<string, unknown>;
      };
    };
    senderOpenId = event.operator?.open_id;
    // open_chat_id may be at top level or inside context (form submit callbacks use context)
    openChatId = event.open_chat_id ?? event.context?.open_chat_id;
    const actionTag = event.action?.tag;
    const actionName = event.action?.name;
    formValue = event.action?.form_value as Record<string, unknown> | undefined;

    log.info(
      `card action received: tag=${actionTag}, name=${actionName}, chat=${openChatId}, ` +
        `sender=${senderOpenId}, hasFormValue=${!!formValue}, hasValue=${!!event.action?.value}`,
    );

    // Extract action/operationId from button value (may not propagate for form submit)
    const val = event.action?.value;
    if (val && typeof val === 'object') {
      action = val.action as string | undefined;
      operationId = val.operation_id as string | undefined;
    }

    // Detect form submit by button name
    if (!action && actionName?.startsWith(SUBMIT_BUTTON_PREFIX)) {
      action = ACTION_SUBMIT;
      // Extract questionId from button name: ask_user_submit_<questionId>
      if (!operationId) {
        operationId = actionName.slice(SUBMIT_BUTTON_PREFIX.length);
      }
    }
    // Detect form submit by tag + formValue
    if (!action && actionTag === 'button' && formValue) {
      action = ACTION_SUBMIT;
    }
    // Some SDK versions emit tag='form_submit'
    if (!action && actionTag === 'form_submit') {
      action = ACTION_SUBMIT;
      if (!formValue && event.action) {
        formValue = event.action as unknown as Record<string, unknown>;
      }
    }
  } catch {
    return undefined;
  }

  if (action !== ACTION_SUBMIT) return undefined;

  // Look up pending question: try operationId first, then chat-scoped fallback
  let ctx: QuestionContext | undefined;
  if (operationId) {
    ctx = pendingQuestions.get(operationId);
  }
  if (!ctx && openChatId) {
    // Targeted fallback: exact accountId:chatId match via secondary index
    ctx = findQuestionByChat(accountId, openChatId);
    if (ctx) {
      log.info(`resolved question via chat-scoped fallback: ${ctx.questionId}`);
    }
  }
  if (!ctx) {
    if (operationId) {
      log.warn(`ask-user action: question ${operationId} not found (expired or already handled)`);
    }
    return operationId ? { toast: { type: 'info', content: '该问题已过期或已被回答' } } : undefined;
  }
  if (ctx.submitted) {
    return { toast: { type: 'info', content: '该问题已提交，请等待处理' } };
  }

  if (senderOpenId && ctx.senderOpenId && senderOpenId !== ctx.senderOpenId) {
    return { toast: { type: 'warning', content: '只有被提问的用户可以回答此问题' } };
  }

  if (!formValue) {
    log.warn(`ask-user submit without form_value for question ${operationId}`);
    return { toast: { type: 'error', content: '表单数据丢失，请重试' } };
  }

  log.info(`form_value: ${JSON.stringify(formValue)}`);

  // ---- Parse form_value → answers ----
  const answers: Record<string, string> = {};
  const unanswered: string[] = [];

  for (let i = 0; i < ctx.questions.length; i++) {
    const q = ctx.questions[i];
    let answer: string | undefined;

    if (q.options.length === 0) {
      // Free-text input
      answer = readFormTextField(formValue, getInputFieldName(i));
    } else if (q.multiSelect) {
      // Multi-select
      const selected = readFormMultiSelect(formValue, getSelectFieldName(i));
      if (selected.length > 0) {
        answer = selected.join(', ');
      }
    } else {
      // Single-select
      answer = readFormTextField(formValue, getSelectFieldName(i));
    }

    if (answer) {
      answers[q.question] = answer;
    } else {
      unanswered.push(q.header);
    }
  }

  if (unanswered.length > 0) {
    return {
      toast: { type: 'warning', content: `请先完成: ${unanswered.join(', ')}` },
    };
  }

  // Mark as submitted (guard against double-submit & TTL expiry).
  ctx.submitted = true;

  // Build the intermediate "processing" card for immediate visual feedback.
  const processingCard = buildProcessingCard(ctx.questions, answers);

  // Inject synthetic message with answers. On success, updates card to
  // "answered" and consumes context. On failure, reverts card to submittable
  // form state and resets submitted flag so user can re-submit.
  setImmediate(() => {
    injectAnswerSyntheticMessage(ctx, answers).catch((err) => {
      log.error(`unhandled error in injectAnswerSyntheticMessage: ${err}`);
    });
  });

  log.info(`question ${operationId} submitted, synthetic message will be injected`);

  // Return immediate visual feedback via Feishu callback response:
  // - toast: ephemeral success message for the clicking user
  // - card: replaces card content immediately for the clicking user
  // Note: callback-return card does NOT consume a cardSequence number.
  return {
    toast: {
      type: 'success' as const,
      content: '已收到回答，正在处理...',
    },
    card: {
      type: 'raw' as const,
      data: processingCard,
    },
  };
}

// ---------------------------------------------------------------------------
// Synthetic Message Injection
// ---------------------------------------------------------------------------

/**
 * Inject a synthetic message carrying the user's answers so the AI receives
 * them in a new turn. Follows the same pattern as oauth.ts for auth-complete
 * synthetic messages. Retries on failure to prevent answer loss.
 */
async function injectAnswerSyntheticMessage(ctx: QuestionContext, answers: Record<string, string>): Promise<void> {
  const syntheticMsgId = `${ctx.messageId}:ask-user-answer:${ctx.questionId}`;

  // Format answers as readable text for the AI
  const answerLines = Object.entries(answers)
    .map(([q, a]) => `- ${q}: ${a}`)
    .join('\n');
  const text = `用户回答了你的问题:\n${answerLines}`;

  const syntheticEvent = {
    sender: { sender_id: { open_id: ctx.senderOpenId } },
    message: {
      message_id: syntheticMsgId,
      chat_id: ctx.chatId,
      chat_type: ctx.chatType ?? ('p2p' as const),
      message_type: 'text',
      content: JSON.stringify({ text }),
      thread_id: ctx.threadId,
    },
  };

  const syntheticRuntime = {
    log: (msg: string) => log.info(msg),
    error: (msg: string) => log.error(msg),
  };

  // Update card to "processing" state via API so ALL viewers see it (not just
  // the clicking user — the callback-return card field only updates for the
  // clicker). Per Feishu docs, delayed update must execute AFTER the callback
  // response — since we're in setImmediate, the callback has already returned.
  try {
    const processingCard = buildProcessingCard(ctx.questions, answers);
    ctx.cardSequence++;
    await updateCardKitCard({
      cfg: ctx.cfg,
      cardId: ctx.cardId,
      card: processingCard,
      sequence: ctx.cardSequence,
      accountId: ctx.accountId,
    });
  } catch (err) {
    log.warn(`failed to update card to processing state via API: ${err}`);
    // Non-fatal: the clicking user already sees the processing state via callback return.
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= INJECT_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      log.info(`retrying synthetic message injection (attempt ${attempt + 1}) for question ${ctx.questionId}`);
      await new Promise((r) => setTimeout(r, INJECT_RETRY_DELAY_MS));
    }

    try {
      const { status, promise } = enqueueFeishuChatTask({
        accountId: ctx.accountId,
        chatId: ctx.chatId,
        threadId: ctx.threadId,
        task: async () => {
          await withTicket(
            {
              messageId: syntheticMsgId,
              chatId: ctx.chatId,
              accountId: ctx.accountId,
              startTime: Date.now(),
              senderOpenId: ctx.senderOpenId,
              chatType: ctx.chatType,
              threadId: ctx.threadId,
            },
            () =>
              handleFeishuMessage({
                cfg: ctx.cfg,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                event: syntheticEvent as any,
                accountId: ctx.accountId,
                forceMention: true,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                runtime: syntheticRuntime as any,
                replyToMessageId: ctx.messageId,
              }),
          );
        },
      });

      // Wait for the task to actually execute (not just enqueue)
      await promise;
      consumePendingQuestion(ctx.questionId);
      log.info(`synthetic answer message dispatched (${status}) for question ${ctx.questionId}`);
      // Update card to answered state only after synthetic message succeeds.
      // This ensures the card stays submittable for retry if injection fails.
      try {
        await updateCardToAnswered(ctx, answers);
      } catch (err) {
        log.warn(`failed to update card to answered state: ${err}`);
      }
      return; // success
    } catch (err) {
      lastError = err;
      log.warn(`synthetic message injection attempt ${attempt + 1} failed: ${err}`);
    }
  }

  // All retries exhausted — reset submitted flag so user can retry via card,
  // revert card to submittable form state, and re-arm TTL.
  ctx.submitted = false;
  armTtlTimer(ctx, PENDING_QUESTION_TTL_MS);
  log.error(
    `synthetic message injection failed after ${INJECT_MAX_RETRIES + 1} attempts for question ${ctx.questionId}: ${lastError}`,
  );

  // Revert card from "processing" back to interactive form so user can retry.
  try {
    await updateCardToSubmittable(ctx);
    log.info(`reverted card to submittable state for question ${ctx.questionId}`);
  } catch (err) {
    log.warn(`failed to revert card to submittable state: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Form value readers
// ---------------------------------------------------------------------------

function readFormTextField(formValue: Record<string, unknown>, fieldName: string): string | undefined {
  const value = formValue[fieldName];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readFormMultiSelect(formValue: Record<string, unknown>, fieldName: string): string[] {
  const raw = formValue[fieldName];
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw.trim());
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
      }
    } catch {
      // not JSON
    }
    return [raw.trim()];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Card Builders — unified form layout
// ---------------------------------------------------------------------------

/**
 * Build a left-right row: label on left, control on right.
 */
function buildLabeledRow(label: Record<string, unknown>, control: Record<string, unknown>): Record<string, unknown> {
  return {
    tag: 'column_set',
    flex_mode: 'stretch',
    horizontal_spacing: '8px',
    margin: '12px 0 0 0',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        vertical_align: 'center',
        elements: [label],
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 3,
        vertical_align: 'center',
        elements: [control],
      },
    ],
  };
}

/**
 * Build form elements for a single question.
 *
 * All controls use `name` for form_value collection. No `value` property
 * is set on interactive components — they do not fire individual callbacks.
 */
function buildQuestionFormElements(q: QuestionItem, questionIndex: number): Record<string, unknown>[] {
  const elems: Record<string, unknown>[] = [];
  const labelMd = { tag: 'markdown', content: `**${q.header}**` };

  // Question description as subtitle
  if (q.question && q.question !== q.header) {
    elems.push({ tag: 'markdown', content: q.question, text_size: 'notation' });
  }

  if (q.options.length === 0) {
    // ---- Free-text input ----
    elems.push(
      buildLabeledRow(labelMd, {
        tag: 'input',
        name: getInputFieldName(questionIndex),
        placeholder: {
          tag: 'plain_text',
          content: '请输入...',
          i18n_content: { zh_cn: '请输入...', en_us: 'Type your answer...' },
        },
      }),
    );
    return elems;
  }

  // ---- Build option list ----
  const selectOptions = q.options.map((opt) => ({
    text: { tag: 'plain_text', content: opt.label },
    value: opt.label,
  }));

  if (q.multiSelect) {
    // ---- Multi-select dropdown ----
    elems.push(
      buildLabeledRow(labelMd, {
        tag: 'multi_select_static',
        name: getSelectFieldName(questionIndex),
        placeholder: {
          tag: 'plain_text',
          content: '请选择...',
          i18n_content: { zh_cn: '请选择...', en_us: 'Select options...' },
        },
        options: selectOptions,
      }),
    );
  } else {
    // ---- Single-select dropdown ----
    elems.push(
      buildLabeledRow(labelMd, {
        tag: 'select_static',
        name: getSelectFieldName(questionIndex),
        placeholder: {
          tag: 'plain_text',
          content: '请选择...',
          i18n_content: { zh_cn: '请选择...', en_us: 'Select an option...' },
        },
        options: selectOptions,
      }),
    );
  }

  // ---- Option descriptions ----
  const descLines = q.options.filter((opt) => opt.description).map((opt) => `• **${opt.label}**: ${opt.description}`);
  if (descLines.length > 0) {
    elems.push({ tag: 'markdown', content: descLines.join('\n'), text_size: 'notation' });
  }

  return elems;
}

/**
 * Build the full interactive ask-user card.
 *
 * All elements are wrapped in a single `form` container.
 * Submit button uses `form_action_type: "submit"` to collect all values.
 */
function buildAskUserCard(questions: QuestionItem[], questionId: string): Record<string, unknown> {
  const formElements: Record<string, unknown>[] = [];

  for (let i = 0; i < questions.length; i++) {
    if (i > 0) {
      formElements.push({ tag: 'hr' });
    }
    formElements.push(...buildQuestionFormElements(questions[i], i));
  }

  // Submit button.
  // questionId is encoded in both button name and value for resilience:
  // - `value` is the primary carrier and is included in card.action.trigger
  //   callbacks per Feishu's documented event structure.
  // - `name` acts as a fallback in case the SDK version strips value
  //   from form_submit events.
  // Both are needed because a button without a `value` field fails
  // Feishu's client-side interactive-component validation with code 200340.
  formElements.push({ tag: 'hr' });
  formElements.push({
    tag: 'button',
    name: `${SUBMIT_BUTTON_PREFIX}${questionId}`,
    value: { action: 'ask_user_submit', operation_id: questionId },
    text: {
      tag: 'plain_text',
      content: '📮 提交',
      i18n_content: { zh_cn: '📮 提交', en_us: '📮 Submit' },
    },
    type: 'primary',
    form_action_type: 'submit',
  });

  return {
    schema: '2.0',
    config: V2_CONFIG,
    header: {
      title: {
        tag: 'plain_text',
        content: '需要你的确认',
        i18n_content: { zh_cn: '需要你的确认', en_us: 'Your Input Needed' },
      },
      subtitle: {
        tag: 'plain_text',
        content: `共 ${questions.length} 个问题`,
        i18n_content: {
          zh_cn: `共 ${questions.length} 个问题`,
          en_us: `${questions.length} question${questions.length > 1 ? 's' : ''}`,
        },
      },
      text_tag_list: [
        {
          tag: 'text_tag',
          text: { tag: 'plain_text', content: '待回答' },
          color: 'blue',
        },
      ],
      template: 'blue',
    },
    body: {
      elements: [
        {
          tag: 'form',
          name: 'ask_user_form',
          elements: formElements,
        },
      ],
    },
  };
}

function buildAnsweredCard(questions: QuestionItem[], answers: Record<string, string>): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const answer = answers[q.question] ?? '(no answer)';
    if (i > 0) {
      elements.push({ tag: 'hr' });
    }
    elements.push(
      buildLabeledRow(
        { tag: 'markdown', content: `**${q.header}**` },
        { tag: 'markdown', content: `✅ **${answer}**` },
      ),
    );
  }

  return {
    schema: '2.0',
    config: V2_CONFIG,
    header: {
      title: {
        tag: 'plain_text',
        content: '已收到回答',
        i18n_content: { zh_cn: '已收到回答', en_us: 'Response Received' },
      },
      subtitle: {
        tag: 'plain_text',
        content: `共 ${questions.length} 个问题`,
        i18n_content: {
          zh_cn: `共 ${questions.length} 个问题`,
          en_us: `${questions.length} question${questions.length > 1 ? 's' : ''}`,
        },
      },
      text_tag_list: [
        {
          tag: 'text_tag',
          text: { tag: 'plain_text', content: '已完成' },
          color: 'green',
        },
      ],
      template: 'green',
    },
    body: { elements },
  };
}

function buildProcessingCard(questions: QuestionItem[], answers: Record<string, string>): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const answer = answers[q.question] ?? '(no answer)';
    if (i > 0) {
      elements.push({ tag: 'hr' });
    }
    elements.push(
      buildLabeledRow(
        { tag: 'markdown', content: `**${q.header}**` },
        { tag: 'markdown', content: `⏳ **${answer}**` },
      ),
    );
  }

  elements.push({
    tag: 'markdown',
    content: '正在处理你的回答...',
    text_size: 'notation',
  });

  return {
    schema: '2.0',
    config: V2_CONFIG,
    header: {
      title: {
        tag: 'plain_text',
        content: '已提交回答',
        i18n_content: { zh_cn: '已提交回答', en_us: 'Response Submitted' },
      },
      subtitle: {
        tag: 'plain_text',
        content: `共 ${questions.length} 个问题 · 正在处理`,
        i18n_content: {
          zh_cn: `共 ${questions.length} 个问题 · 正在处理`,
          en_us: `${questions.length} question${questions.length > 1 ? 's' : ''} · Processing`,
        },
      },
      text_tag_list: [
        {
          tag: 'text_tag',
          text: { tag: 'plain_text', content: '处理中' },
          color: 'turquoise',
        },
      ],
      template: 'turquoise',
    },
    body: { elements },
  };
}

function buildExpiredCard(questions: QuestionItem[]): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (i > 0) {
      elements.push({ tag: 'hr' });
    }
    elements.push(
      buildLabeledRow({ tag: 'markdown', content: `**${q.header}**` }, { tag: 'markdown', content: q.question }),
    );
  }

  elements.push({
    tag: 'markdown',
    content: '⏱ 该问题已过期',
    i18n_content: { zh_cn: '⏱ 该问题已过期', en_us: '⏱ This question has expired' },
    text_size: 'notation',
  });

  return {
    schema: '2.0',
    config: V2_CONFIG,
    header: {
      title: {
        tag: 'plain_text',
        content: '问题已过期',
        i18n_content: { zh_cn: '问题已过期', en_us: 'Question Expired' },
      },
      subtitle: {
        tag: 'plain_text',
        content: '未在规定时间内回答',
        i18n_content: { zh_cn: '未在规定时间内回答', en_us: 'No response within time limit' },
      },
      text_tag_list: [
        {
          tag: 'text_tag',
          text: { tag: 'plain_text', content: '已过期' },
          color: 'neutral',
        },
      ],
      template: 'grey',
    },
    body: { elements },
  };
}

// ---------------------------------------------------------------------------
// Card Update Helpers
// ---------------------------------------------------------------------------

async function updateCardToAnswered(ctx: QuestionContext, answers: Record<string, string>): Promise<void> {
  const card = buildAnsweredCard(ctx.questions, answers);
  ctx.cardSequence++;
  await updateCardKitCard({
    cfg: ctx.cfg,
    cardId: ctx.cardId,
    card,
    sequence: ctx.cardSequence,
    accountId: ctx.accountId,
  });
}

async function updateCardToExpired(ctx: QuestionContext): Promise<void> {
  const card = buildExpiredCard(ctx.questions);
  ctx.cardSequence++;
  await updateCardKitCard({
    cfg: ctx.cfg,
    cardId: ctx.cardId,
    card,
    sequence: ctx.cardSequence,
    accountId: ctx.accountId,
  });
}

async function updateCardToSubmittable(ctx: QuestionContext): Promise<void> {
  const card = buildAskUserCard(ctx.questions, ctx.questionId);
  ctx.cardSequence++;
  await updateCardKitCard({
    cfg: ctx.cfg,
    cardId: ctx.cardId,
    card,
    sequence: ctx.cardSequence,
    accountId: ctx.accountId,
  });
}

// ---------------------------------------------------------------------------
// Tool Schema
// ---------------------------------------------------------------------------

const AskUserQuestionSchema = Type.Object({
  questions: Type.Array(
    Type.Object({
      question: Type.String({ description: 'The question to ask the user' }),
      header: Type.String({ description: 'Short label for the question (max 12 chars)' }),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: 'Display text for this option' }),
          description: Type.String({ description: 'Explanation of what this option means' }),
        }),
        {
          description:
            'Available choices. Renders as a dropdown. ' +
            'Leave empty ([]) for free-text input — the user will see a text field instead.',
          maxItems: 10,
        },
      ),
      multiSelect: Type.Boolean({
        description: 'Whether multiple options can be selected (ignored when options is empty)',
      }),
    }),
    {
      description: 'Questions to ask the user (1-6 questions)',
      minItems: 1,
      maxItems: 6,
    },
  ),
});

// ---------------------------------------------------------------------------
// Tool Registration
// ---------------------------------------------------------------------------

export function registerAskUserQuestionTool(api: OpenClawPluginApi): void {
  const toolName = 'feishu_ask_user_question';

  if (!checkToolRegistration(api, toolName)) return;

  const cfg = api.config;

  api.registerTool({
    name: toolName,
    label: 'Ask User Question',
    description:
      'Ask the user a question via an interactive Feishu card. ' +
      'Returns immediately after sending the card. ' +
      "The user's answers will arrive as a new message in the conversation. " +
      'Do NOT poll or re-call this tool — just wait for the response message. ' +
      'For selection questions, provide options (renders as dropdown). ' +
      'For free-text input, set options to an empty array.',
    parameters: AskUserQuestionSchema,

    async execute(_toolCallId: string, params: unknown) {
      const { questions } = params as { questions: QuestionItem[] };

      const ticket = getTicket();
      if (!ticket) {
        return formatToolError('AskUserQuestion can only be used in a Feishu message context');
      }

      const { chatId, accountId, senderOpenId, threadId } = ticket;
      if (!senderOpenId) {
        return formatToolError('Cannot determine the target user (no senderOpenId in ticket)');
      }

      const questionId = randomUUID();
      log.info(`creating ask-user-question: id=${questionId}, questions=${questions.length}, chat=${chatId}`);

      // 1. Build and send card
      const card = buildAskUserCard(questions, questionId);

      let cardId: string | null;
      try {
        cardId = await createCardEntity({ cfg, card, accountId });
      } catch (err) {
        log.error(`failed to create card entity: ${err}`);
        return formatToolError(`Failed to create question card: ${err}`);
      }

      if (!cardId) {
        return formatToolError('Failed to create question card: no card_id returned');
      }

      try {
        await sendCardByCardId({
          cfg,
          to: chatId,
          cardId,
          replyToMessageId: ticket.messageId,
          replyInThread: Boolean(threadId),
          accountId,
        });
      } catch (err) {
        log.error(`failed to send card: ${err}`);
        return formatToolError(`Failed to send question card: ${err}`);
      }

      // 2. Store context for card action handler to inject synthetic message
      storePendingQuestion({
        questionId,
        chatId,
        accountId,
        senderOpenId,
        cardId,
        cfg,
        questions,
        threadId,
        chatType: ticket.chatType,
        messageId: ticket.messageId,
        cardSequence: 1,
        submitted: false,
      });

      // 3. Return immediately — answers will arrive via synthetic message
      log.info(`question ${questionId} card sent, returning pending status`);
      return formatToolResult({
        status: 'pending',
        questionId,
        message:
          'Question card sent to the user. Their answers will arrive as a follow-up message ' +
          'in this conversation. Do NOT call this tool again for the same question — just wait ' +
          'for the response message.',
      });
    },
  });

  api.logger.debug?.(`${toolName}: registered tool`);
}
