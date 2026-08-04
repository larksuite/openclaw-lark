/**
 * Tests for AskUserQuestion card callback immediate feedback.
 *
 * Verifies that submitting the card returns instant visual feedback
 * (toast + processing card) and that the two-phase card update flow
 * works correctly for success and failure paths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPluginInteractiveHandlers, registerPluginInteractiveHandler } from 'openclaw/plugin-sdk/plugin-runtime';

// ---------------------------------------------------------------------------
// Module mocks (hoisted)
// ---------------------------------------------------------------------------

const mockLog = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => mockLog,
}));

const mockAbortAgentHarnessRun = vi.fn();
vi.mock('openclaw/plugin-sdk/agent-harness-runtime', () => ({
  abortAgentHarnessRun: (...args: unknown[]) => mockAbortAgentHarnessRun(...args),
}));

const mockCreateCardEntity = vi.fn();
const mockSendCardByCardId = vi.fn();
const mockUpdateCardKitCard = vi.fn();
vi.mock('../src/card/cardkit', () => ({
  createCardEntity: (...args: unknown[]) => mockCreateCardEntity(...args),
  sendCardByCardId: (...args: unknown[]) => mockSendCardByCardId(...args),
  updateCardKitCard: (...args: unknown[]) => mockUpdateCardKitCard(...args),
}));

const mockEnqueueFeishuChatTask = vi.fn();
vi.mock('../src/channel/chat-queue', () => ({
  buildQueueKey: (accountId: string, chatId: string) => `${accountId}:${chatId}`,
  enqueueFeishuChatTask: (...args: unknown[]) => mockEnqueueFeishuChatTask(...args),
}));

vi.mock('../src/messaging/inbound/handler', () => ({
  handleFeishuMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/tools/auto-auth', () => ({
  handleCardAction: vi.fn(),
}));

const mockGetTicket = vi.fn();
const mockWithTicket = vi.fn();
vi.mock('../src/core/lark-ticket', () => ({
  getTicket: (...args: unknown[]) => mockGetTicket(...args),
  withTicket: (...args: unknown[]) => mockWithTicket(...args),
}));

vi.mock('../src/tools/helpers', () => ({
  checkToolRegistration: () => true,
  formatToolResult: (obj: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] }),
  formatToolError: (msg: string) => ({ content: [{ type: 'text', text: msg }], isError: true }),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { handleAskUserAction, registerAskUserQuestionTool } from '../src/tools/ask-user-question';
import { handleCardActionEvent } from '../src/channel/event-handlers';
import type { MonitorContext } from '../src/channel/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = 'test-account';
const TEST_CHAT_ID = 'oc_test123';
const TEST_SENDER = 'ou_sender1';
const TEST_MSG_ID = 'msg_test1';
const PENDING_QUESTION_TTL_MS = 5 * 60 * 1000;
const DEFAULT_QUESTIONS = [
  {
    question: '你喜欢什么水果?',
    header: '水果',
    options: [
      { label: '苹果', description: 'Apple' },
      { label: '香蕉', description: 'Banana' },
    ],
    multiSelect: false,
  },
];

function createMockCfg() {
  return {} as any;
}

function createMockMonitorContext(): MonitorContext {
  return {
    cfg: createMockCfg(),
    lark: { account: { appId: 'cli_test' } } as never,
    accountId: TEST_ACCOUNT_ID,
    chatHistories: new Map(),
    messageDedup: { tryRecord: vi.fn(() => true) } as never,
    log: vi.fn(),
    error: vi.fn(),
  };
}

function createRegisteredTool(sessionId: string | undefined) {
  let registration: any;
  const mockApi = {
    config: createMockCfg(),
    registerTool: (toolOrFactory: any) => {
      registration = toolOrFactory;
    },
    logger: { debug: vi.fn() },
  };
  registerAskUserQuestionTool(mockApi as any);
  return typeof registration === 'function' ? registration({ sessionId }) : registration;
}

function prepareSuccessfulCardDelivery(): void {
  mockGetTicket.mockReturnValue({
    chatId: TEST_CHAT_ID,
    accountId: TEST_ACCOUNT_ID,
    senderOpenId: TEST_SENDER,
    messageId: TEST_MSG_ID,
    chatType: 'p2p',
  });
  mockCreateCardEntity.mockResolvedValue('card_test_id');
  mockSendCardByCardId.mockResolvedValue(undefined);
}

/**
 * Seed a pending question by calling the tool's execute().
 * Returns the questionId that was generated.
 */
async function seedPendingQuestion(opts?: {
  questionId?: string;
  questions?: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
    selectStyle?: 'dropdown' | 'checkbox';
  }>;
}): Promise<string> {
  const questions = opts?.questions ?? DEFAULT_QUESTIONS;

  prepareSuccessfulCardDelivery();

  const tool = createRegisteredTool('session-seed-pending-question');
  const result = await tool.execute('call-1', { questions });
  const parsed = JSON.parse(result.content[0].text);

  return parsed.questionId;
}

/**
 * Create a card action event that simulates form submission.
 */
function createFormSubmitEvent(questionId: string, formValue: Record<string, unknown>, senderOpenId = TEST_SENDER) {
  return {
    operator: { open_id: senderOpenId },
    open_chat_id: TEST_CHAT_ID,
    action: {
      tag: 'button',
      name: `ask_user_submit_${questionId}`,
      form_value: formValue,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AskUserQuestion card callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAbortAgentHarnessRun.mockReturnValue(true);
    clearPluginInteractiveHandlers();
    vi.useFakeTimers();
  });

  afterEach(() => {
    clearPluginInteractiveHandlers();
    vi.useRealTimers();
  });

  describe('tool run suspension', () => {
    it('aborts the active run on the next event-loop turn after returning pending', async () => {
      prepareSuccessfulCardDelivery();
      const tool = createRegisteredTool('session-active-1');

      const result = await tool.execute('call-1', { questions: DEFAULT_QUESTIONS });
      try {
        expect(JSON.parse(result.content[0].text).status).toBe('pending');
        expect(mockAbortAgentHarnessRun).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(0);
        expect(mockAbortAgentHarnessRun).toHaveBeenCalledOnce();
        expect(mockAbortAgentHarnessRun).toHaveBeenCalledWith('session-active-1');
      } finally {
        await vi.advanceTimersByTimeAsync(PENDING_QUESTION_TTL_MS);
      }
    });

    it('fails before creating a card when the runtime session id is absent', async () => {
      prepareSuccessfulCardDelivery();
      const tool = createRegisteredTool(undefined);

      const result = await tool.execute('call-1', { questions: DEFAULT_QUESTIONS });
      try {
        expect(result.isError).toBe(true);
        expect(mockCreateCardEntity).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(0);
        expect(mockAbortAgentHarnessRun).not.toHaveBeenCalled();
      } finally {
        await vi.advanceTimersByTimeAsync(PENDING_QUESTION_TTL_MS);
      }
    });

    it('does not abort when card creation fails', async () => {
      prepareSuccessfulCardDelivery();
      mockCreateCardEntity.mockRejectedValueOnce(new Error('create failed'));
      const tool = createRegisteredTool('session-create-failure');

      const result = await tool.execute('call-1', { questions: DEFAULT_QUESTIONS });

      expect(result.isError).toBe(true);
      expect(mockSendCardByCardId).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(0);
      expect(mockAbortAgentHarnessRun).not.toHaveBeenCalled();
    });

    it('does not abort when card delivery fails', async () => {
      prepareSuccessfulCardDelivery();
      mockSendCardByCardId.mockRejectedValueOnce(new Error('send failed'));
      const tool = createRegisteredTool('session-send-failure');

      const result = await tool.execute('call-1', { questions: DEFAULT_QUESTIONS });

      expect(result.isError).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockAbortAgentHarnessRun).not.toHaveBeenCalled();
    });
  });

  describe('handleAskUserAction immediate feedback', () => {
    it('returns { toast, card } with processing state on successful submit', async () => {
      const questionId = await seedPendingQuestion();

      const event = createFormSubmitEvent(questionId, { selection_0: '苹果' });
      const result = handleAskUserAction(event, createMockCfg(), TEST_ACCOUNT_ID) as any;

      expect(result).toBeDefined();
      expect(result.toast).toEqual({
        type: 'success',
        content: '已收到回答，正在处理...',
      });
      expect(result.card).toBeDefined();
      expect(result.card.type).toBe('raw');
      // The card data should contain processing state indicators
      expect(result.card.data.header.template).toBe('turquoise');
      expect(result.card.data.header.text_tag_list[0].text.content).toBe('处理中');
      expect(result.card.data.header.title.content).toBe('已提交回答');
    });

    it('sets ctx.submitted to true on successful submit', async () => {
      const questionId = await seedPendingQuestion();

      const event = createFormSubmitEvent(questionId, { selection_0: '苹果' });
      handleAskUserAction(event, createMockCfg(), TEST_ACCOUNT_ID);

      // Submitting again should return the "already submitted" toast
      const result2 = handleAskUserAction(event, createMockCfg(), TEST_ACCOUNT_ID) as any;
      expect(result2.toast.type).toBe('info');
      expect(result2.toast.content).toContain('已提交');
    });

    it('returns warning toast for missing required answers', async () => {
      const questionId = await seedPendingQuestion();

      // Submit without any form values
      const event = createFormSubmitEvent(questionId, {});
      const result = handleAskUserAction(event, createMockCfg(), TEST_ACCOUNT_ID) as any;

      expect(result.toast.type).toBe('warning');
      expect(result.toast.content).toContain('请先完成');

      // Submitting again should still work (not marked as submitted)
      const event2 = createFormSubmitEvent(questionId, { selection_0: '苹果' });
      const result2 = handleAskUserAction(event2, createMockCfg(), TEST_ACCOUNT_ID) as any;
      expect(result2.toast.type).toBe('success');
    });

    it('returns undefined for non-submit actions', () => {
      const event = { action: { tag: 'some_other_action', name: 'other' } };
      const result = handleAskUserAction(event, createMockCfg(), TEST_ACCOUNT_ID);
      expect(result).toBeUndefined();
    });

    it('does not consume non-ask-user form submit actions from other plugins', async () => {
      await seedPendingQuestion();

      const event = {
        operator: { open_id: TEST_SENDER },
        open_chat_id: TEST_CHAT_ID,
        action: {
          tag: 'form_submit',
          name: 'example_form.submit',
          form_value: {
            field_a: 'alpha',
            field_b: 'beta',
          },
        },
      };

      try {
        const result = handleAskUserAction(event, createMockCfg(), TEST_ACCOUNT_ID);

        expect(result).toBeUndefined();
      } finally {
        await vi.advanceTimersByTimeAsync(PENDING_QUESTION_TTL_MS);
      }
    });

    it('does not consume business form_submit by form_name when an ask-user question is pending', async () => {
      await seedPendingQuestion();

      const event = {
        operator: { open_id: TEST_SENDER },
        context: {
          open_chat_id: TEST_CHAT_ID,
          open_message_id: 'om_business_card',
        },
        action: {
          tag: 'form_submit',
          form_name: 'example_form.submit',
          form_value: {
            field_a: 'alpha',
            field_b: 'beta',
          },
        },
      };

      try {
        const result = handleAskUserAction(event, createMockCfg(), TEST_ACCOUNT_ID);

        expect(result).toBeUndefined();
      } finally {
        await vi.advanceTimersByTimeAsync(PENDING_QUESTION_TTL_MS);
      }
    });

    it('accepts ask-user form_submit by value.action when button name is absent', async () => {
      const questionId = await seedPendingQuestion();

      const event = {
        operator: { open_id: TEST_SENDER },
        context: {
          open_chat_id: TEST_CHAT_ID,
          open_message_id: TEST_MSG_ID,
        },
        action: {
          tag: 'form_submit',
          value: {
            action: 'ask_user_submit',
            operation_id: questionId,
          },
          form_value: {
            selection_0: '苹果',
          },
        },
      };

      const result = handleAskUserAction(event, createMockCfg(), TEST_ACCOUNT_ID) as any;

      expect(result.toast.type).toBe('success');
    });

    it('accepts legacy ask-user form_submit without button name or value.action', async () => {
      await seedPendingQuestion();

      const event = {
        operator: { open_id: TEST_SENDER },
        context: {
          open_chat_id: TEST_CHAT_ID,
          open_message_id: TEST_MSG_ID,
        },
        action: {
          tag: 'form_submit',
          form_value: {
            selection_0: '苹果',
          },
        },
      };

      const result = handleAskUserAction(event, createMockCfg(), TEST_ACCOUNT_ID) as any;

      expect(result.toast.type).toBe('success');
    });

    it('routes business form_submit through handleCardActionEvent when ask-user is pending in the same chat', async () => {
      await seedPendingQuestion();

      const handler = vi.fn().mockReturnValue({ toast: { type: 'success', content: 'business handler reached' } });
      registerPluginInteractiveHandler('example-plugin', {
        channel: 'feishu',
        namespace: 'example_form.submit',
        handler,
      });

      const rawEvent = {
        operator: { open_id: TEST_SENDER },
        context: {
          open_chat_id: TEST_CHAT_ID,
          open_message_id: 'om_business_card',
        },
        action: {
          tag: 'form_submit',
          form_name: 'example_form.submit',
          form_value: {
            field_a: 'alpha',
            field_b: 'beta',
          },
        },
      };

      try {
        const result = await handleCardActionEvent(createMockMonitorContext(), rawEvent);

        expect(result).toEqual({ toast: { type: 'success', content: 'business handler reached' } });
        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({
            channel: 'feishu',
            accountId: TEST_ACCOUNT_ID,
            senderId: TEST_SENDER,
            conversationId: TEST_CHAT_ID,
            messageId: 'om_business_card',
            namespace: 'example_form.submit',
            payload: '',
            action: 'example_form.submit',
            rawEvent,
          }),
        );
      } finally {
        await vi.advanceTimersByTimeAsync(PENDING_QUESTION_TTL_MS);
      }
    });

    it('returns expired toast for unknown questionId', () => {
      const event = createFormSubmitEvent('non-existent-id', { selection_0: '苹果' });
      const result = handleAskUserAction(event, createMockCfg(), TEST_ACCOUNT_ID) as any;

      expect(result.toast.type).toBe('info');
      expect(result.toast.content).toContain('已过期');
    });
  });

  describe('buildProcessingCard output', () => {
    it('includes ⏳ prefix on answers', async () => {
      const questionId = await seedPendingQuestion();

      const event = createFormSubmitEvent(questionId, { selection_0: '苹果' });
      const result = handleAskUserAction(event, createMockCfg(), TEST_ACCOUNT_ID) as any;

      const cardData = result.card.data;
      const body = cardData.body;

      // Find markdown elements with answers
      const markdownElements = findDeep(
        body,
        (el: any) => el?.tag === 'markdown' && typeof el?.content === 'string' && el.content.includes('⏳'),
      );
      expect(markdownElements.length).toBeGreaterThan(0);
      expect(markdownElements[0].content).toContain('苹果');
    });

    it('includes processing hint text', async () => {
      const questionId = await seedPendingQuestion();

      const event = createFormSubmitEvent(questionId, { selection_0: '苹果' });
      const result = handleAskUserAction(event, createMockCfg(), TEST_ACCOUNT_ID) as any;

      const cardData = result.card.data;
      const hintElements = findDeep(
        cardData.body,
        (el: any) => el?.tag === 'markdown' && el?.content === '正在处理你的回答...',
      );
      expect(hintElements.length).toBe(1);
    });
  });

  describe('injectAnswerSyntheticMessage flow', () => {
    it('calls updateCardKitCard twice on success: processing then answered', async () => {
      mockEnqueueFeishuChatTask.mockImplementation(({ task }: any) => {
        const promise = (async () => {
          // Simulate task execution with withTicket mock
          mockWithTicket.mockImplementation((_ticket: any, fn: any) => fn());
          await task();
        })();
        return { status: 'queued', promise };
      });
      mockUpdateCardKitCard.mockResolvedValue(undefined);

      const questionId = await seedPendingQuestion();
      const event = createFormSubmitEvent(questionId, { selection_0: '苹果' });
      handleAskUserAction(event, createMockCfg(), TEST_ACCOUNT_ID);

      // Run setImmediate callbacks
      await vi.runAllTimersAsync();
      // Flush all microtasks
      await vi.advanceTimersByTimeAsync(0);

      // Should be called: 1st for processing state, 2nd for answered state
      expect(mockUpdateCardKitCard.mock.calls.length).toBeGreaterThanOrEqual(2);

      // First call: processing card (turquoise)
      const firstCallCard = mockUpdateCardKitCard.mock.calls[0][0].card;
      expect(firstCallCard.header.template).toBe('turquoise');
      expect(firstCallCard.header.text_tag_list[0].text.content).toBe('处理中');

      // Second call: answered card (green)
      const secondCallCard = mockUpdateCardKitCard.mock.calls[1][0].card;
      expect(secondCallCard.header.template).toBe('green');
      expect(secondCallCard.header.text_tag_list[0].text.content).toBe('已完成');
    });

    it('sequences increase correctly: processing=2, answered=3', async () => {
      mockEnqueueFeishuChatTask.mockImplementation(({ task }: any) => {
        const promise = (async () => {
          mockWithTicket.mockImplementation((_ticket: any, fn: any) => fn());
          await task();
        })();
        return { status: 'queued', promise };
      });
      mockUpdateCardKitCard.mockResolvedValue(undefined);

      const questionId = await seedPendingQuestion();
      const event = createFormSubmitEvent(questionId, { selection_0: '苹果' });
      handleAskUserAction(event, createMockCfg(), TEST_ACCOUNT_ID);

      await vi.runAllTimersAsync();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockUpdateCardKitCard.mock.calls.length).toBeGreaterThanOrEqual(2);
      // cardSequence starts at 1, processing increments to 2, answered increments to 3
      expect(mockUpdateCardKitCard.mock.calls[0][0].sequence).toBe(2);
      expect(mockUpdateCardKitCard.mock.calls[1][0].sequence).toBe(3);
    });

    it('reverts card to submittable on injection failure', async () => {
      mockEnqueueFeishuChatTask.mockImplementation(() => {
        return { status: 'queued', promise: Promise.reject(new Error('injection failed')) };
      });
      mockUpdateCardKitCard.mockResolvedValue(undefined);

      const questionId = await seedPendingQuestion();
      const event = createFormSubmitEvent(questionId, { selection_0: '苹果' });
      handleAskUserAction(event, createMockCfg(), TEST_ACCOUNT_ID);

      // Run through all retries (INJECT_MAX_RETRIES=2, so 3 total attempts)
      // Each retry has a 2s delay. Advance just enough for retries, not TTL.
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(2500);
      }

      // Find the submittable (blue) card update among all calls.
      // After retries exhaust, updateCardToSubmittable is called, but the
      // TTL timer (re-armed on failure) may also fire if timers advance too far.
      const submittableCall = mockUpdateCardKitCard.mock.calls.find(
        (call: any) => call[0].card?.header?.template === 'blue',
      );
      expect(submittableCall).toBeDefined();
      expect(submittableCall![0].card.header.text_tag_list[0].text.content).toBe('待回答');
    });

    it('continues injection even if processing card API update fails', async () => {
      let updateCallCount = 0;
      mockUpdateCardKitCard.mockImplementation(() => {
        updateCallCount++;
        if (updateCallCount === 1) {
          // First call (processing state) fails
          return Promise.reject(new Error('API error'));
        }
        // Subsequent calls succeed
        return Promise.resolve(undefined);
      });

      mockEnqueueFeishuChatTask.mockImplementation(({ task }: any) => {
        const promise = (async () => {
          mockWithTicket.mockImplementation((_ticket: any, fn: any) => fn());
          await task();
        })();
        return { status: 'queued', promise };
      });

      const questionId = await seedPendingQuestion();
      const event = createFormSubmitEvent(questionId, { selection_0: '苹果' });
      handleAskUserAction(event, createMockCfg(), TEST_ACCOUNT_ID);

      await vi.runAllTimersAsync();
      await vi.advanceTimersByTimeAsync(0);

      // Despite first updateCardKitCard failing, enqueue should still be called
      expect(mockEnqueueFeishuChatTask).toHaveBeenCalled();

      // Second call should be the answered state (green)
      const answeredCall = mockUpdateCardKitCard.mock.calls.find(
        (call: any) => call[0].card?.header?.template === 'green',
      );
      expect(answeredCall).toBeDefined();
    });
  });

  describe('multi-select checkbox style', () => {
    it('renders a checker per option when selectStyle is "checkbox"', async () => {
      await seedPendingQuestion({
        questions: [
          {
            question: '你喜欢哪些水果?',
            header: '水果',
            options: [
              { label: '苹果', description: 'Apple' },
              { label: '香蕉', description: 'Banana' },
              { label: '橙子', description: 'Orange' },
            ],
            multiSelect: true,
            selectStyle: 'checkbox',
          },
        ],
      });

      // The interactive form card is the one passed to createCardEntity.
      const sentCard = mockCreateCardEntity.mock.calls[0][0].card;
      const checkers = findDeep(sentCard, (el: any) => el?.tag === 'checker');

      // One checker per option, no multi_select_static dropdown.
      expect(checkers.length).toBe(3);
      expect(findDeep(sentCard, (el: any) => el?.tag === 'multi_select_static').length).toBe(0);

      // Each checker carries the per-option field name and a value (for 200340).
      expect(checkers[0].name).toBe('selection_0_0');
      expect(checkers[1].name).toBe('selection_0_1');
      expect(checkers[2].name).toBe('selection_0_2');
      expect(checkers[0].value).toEqual({ option: '苹果' });
      expect(checkers[0].text.content).toBe('苹果');
      expect(checkers[0].checked).toBe(false);
    });

    it('still renders multi_select_static dropdown by default (back-compat)', async () => {
      await seedPendingQuestion({
        questions: [
          {
            question: '你喜欢哪些水果?',
            header: '水果',
            options: [
              { label: '苹果', description: '' },
              { label: '香蕉', description: '' },
            ],
            multiSelect: true,
            // selectStyle omitted → default dropdown
          },
        ],
      });

      const sentCard = mockCreateCardEntity.mock.calls[0][0].card;
      expect(findDeep(sentCard, (el: any) => el?.tag === 'multi_select_static').length).toBe(1);
      expect(findDeep(sentCard, (el: any) => el?.tag === 'checker').length).toBe(0);
    });

    it('parses checked checker fields into the answer (boolean and string true)', async () => {
      const questionId = await seedPendingQuestion({
        questions: [
          {
            question: '你喜欢哪些水果?',
            header: '水果',
            options: [
              { label: '苹果', description: '' },
              { label: '香蕉', description: '' },
              { label: '橙子', description: '' },
            ],
            multiSelect: true,
            selectStyle: 'checkbox',
          },
        ],
      });

      // 苹果 checked (boolean), 香蕉 unchecked (false), 橙子 checked (string 'true').
      const event = createFormSubmitEvent(questionId, {
        selection_0_0: true,
        selection_0_1: false,
        selection_0_2: 'true',
      });
      const result = handleAskUserAction(event, createMockCfg(), TEST_ACCOUNT_ID) as any;

      // Submit succeeds (question is answered, not flagged unanswered).
      expect(result.toast.type).toBe('success');

      // The processing card should reflect the selected labels, comma-joined.
      const answerEls = findDeep(
        result.card.data.body,
        (el: any) => el?.tag === 'markdown' && typeof el?.content === 'string' && el.content.includes('⏳'),
      );
      expect(answerEls.length).toBe(1);
      expect(answerEls[0].content).toContain('苹果');
      expect(answerEls[0].content).toContain('橙子');
      expect(answerEls[0].content).not.toContain('香蕉');
    });

    it('parses a real Feishu form_submit payload (boolean checker values)', async () => {
      const questionId = await seedPendingQuestion({
        questions: [
          {
            question: '你想总结哪几个群？（可多选）',
            header: '选择群',
            options: [
              { label: 'Neo Wu Test', description: '' },
              { label: 'Hyclaw 产研', description: '' },
              { label: '巡检场景快速落地HyClaw', description: '' },
              { label: '资金中心项目-客诉群', description: '' },
              { label: '资金中心项目-产研群', description: '' },
              { label: '资金中心项目-研发群', description: '' },
            ],
            multiSelect: true,
            selectStyle: 'checkbox',
          },
        ],
      });

      // Real form_value captured from a Feishu card.action.trigger submit
      // (6 checkboxes, options 1 and 2 checked). Feishu reports each checker's
      // state as a JSON boolean, keyed by the per-option field name. Keeping a
      // real sample here pins the parser to the actual payload shape.
      const event = createFormSubmitEvent(questionId, {
        selection_0_0: false,
        selection_0_1: true,
        selection_0_2: true,
        selection_0_3: false,
        selection_0_4: false,
        selection_0_5: false,
      });
      const result = handleAskUserAction(event, createMockCfg(), TEST_ACCOUNT_ID) as any;

      expect(result.toast.type).toBe('success');

      const answerEls = findDeep(
        result.card.data.body,
        (el: any) => el?.tag === 'markdown' && typeof el?.content === 'string' && el.content.includes('⏳'),
      );
      expect(answerEls.length).toBe(1);
      // Only the two checked options appear, in option order.
      expect(answerEls[0].content).toContain('Hyclaw 产研');
      expect(answerEls[0].content).toContain('巡检场景快速落地HyClaw');
      expect(answerEls[0].content).not.toContain('Neo Wu Test');
      expect(answerEls[0].content).not.toContain('资金中心项目-客诉群');
    });
  });

  describe('multi-question form', () => {
    it('handles multiple questions in processing card', async () => {
      const questionId = await seedPendingQuestion({
        questions: [
          { question: '水果?', header: '水果', options: [{ label: '苹果', description: '' }], multiSelect: false },
          { question: '颜色?', header: '颜色', options: [], multiSelect: false },
        ],
      });

      const event = createFormSubmitEvent(questionId, {
        selection_0: '苹果',
        answer_1: '红色',
      });
      const result = handleAskUserAction(event, createMockCfg(), TEST_ACCOUNT_ID) as any;

      expect(result.toast.type).toBe('success');
      const cardData = result.card.data;
      expect(cardData.header.subtitle.content).toContain('2');

      // Both answers should appear in the card
      const allMarkdown = findDeep(
        cardData.body,
        (el: any) => el?.tag === 'markdown' && typeof el?.content === 'string' && el.content.includes('⏳'),
      );
      expect(allMarkdown.length).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Deep-search an object tree for elements matching a predicate.
 */
function findDeep(obj: unknown, predicate: (el: unknown) => boolean): any[] {
  const results: any[] = [];
  function walk(node: unknown): void {
    if (node === null || node === undefined) return;
    if (predicate(node)) results.push(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
    } else if (typeof node === 'object') {
      for (const value of Object.values(node as Record<string, unknown>)) walk(value);
    }
  }
  walk(obj);
  return results;
}
