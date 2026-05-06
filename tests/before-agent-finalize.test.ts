/**
 * Tests for the before_agent_finalize hook — Feishu task call validation.
 */

import { describe, expect, it } from 'vitest';
import { extractTaskCalls, validateTaskCalls } from '../src/hooks/before-agent-finalize';

// ---------------------------------------------------------------------------
// extractTaskCalls
// ---------------------------------------------------------------------------

describe('extractTaskCalls', () => {
  it('returns empty array for messages without task tool patterns', () => {
    expect(extractTaskCalls('Hello, how can I help?')).toEqual([]);
  });

  it('returns empty array for empty message', () => {
    expect(extractTaskCalls('')).toEqual([]);
  });

  it('extracts a task tool call from a JSON code block', () => {
    const msg = 'Here is the result:\n```json\n{"tool":"feishu_task_task","action":"create","summary":"Test task"}\n```';
    const calls = extractTaskCalls(msg);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('feishu_task_task');
    expect(calls[0].action).toBe('create');
    expect(calls[0].params.summary).toBe('Test task');
  });

  it('extracts task tool call from bare JSON object', () => {
    const msg = 'I will create the task: {"tool":"feishu_task_task","action":"patch","task_guid":"abc123"}';
    const calls = extractTaskCalls(msg);
    expect(calls).toHaveLength(1);
    expect(calls[0].action).toBe('patch');
    expect(calls[0].params.task_guid).toBe('abc123');
  });

  it('extracts multiple task tool calls', () => {
    const msg = [
      '```json',
      '{"tool":"feishu_task_task","action":"create","summary":"Task 1"}',
      '```',
      'And also:',
      '```json',
      '{"tool":"feishu_task_tasklist","action":"tasks","tasklist_guid":"list_123"}',
      '```',
    ].join('\n');
    const calls = extractTaskCalls(msg);
    expect(calls).toHaveLength(2);
  });

  it('ignores non-task tool calls', () => {
    const msg = '```json\n{"tool":"web_search","query":"test"}\n```';
    expect(extractTaskCalls(msg)).toEqual([]);
  });

  it('handles toolName field variant', () => {
    const msg = '{"toolName":"feishu_task_agent","action":"register"}';
    const calls = extractTaskCalls(msg);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('feishu_task_agent');
  });
});

// ---------------------------------------------------------------------------
// validateTaskCalls
// ---------------------------------------------------------------------------

describe('validateTaskCalls', () => {
  it('returns empty array for valid calls', () => {
    const calls = extractTaskCalls(
      '{"tool":"feishu_task_task","action":"create","summary":"Test","current_user_id":"ou_123"}',
    );
    expect(validateTaskCalls(calls)).toEqual([]);
  });

  it('reports missing task_guid for patch action', () => {
    const calls = [{ tool: 'feishu_task_task', action: 'patch', params: { completed_at: '0' } }];
    const issues = validateTaskCalls(calls);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('task_guid');
  });

  it('reports missing task_guid for get action', () => {
    const calls = [{ tool: 'feishu_task_task', action: 'get', params: {} }];
    const issues = validateTaskCalls(calls);
    expect(issues.some((i) => i.includes('task_guid'))).toBe(true);
  });

  it('reports missing task_guid for add_members action', () => {
    const calls = [
      { tool: 'feishu_task_task', action: 'add_members', params: { members: [{ id: 'ou_x' }] } },
    ];
    const issues = validateTaskCalls(calls);
    expect(issues.some((i) => i.includes('task_guid'))).toBe(true);
  });

  it('reports missing tasklist_guid for tasklist.tasks', () => {
    const calls = [{ tool: 'feishu_task_tasklist', action: 'tasks', params: {} }];
    const issues = validateTaskCalls(calls);
    expect(issues.some((i) => i.includes('tasklist_guid'))).toBe(true);
  });

  it('reports missing current_user_id for create action', () => {
    const calls = [
      { tool: 'feishu_task_task', action: 'create', params: { summary: 'Test' } },
    ];
    const issues = validateTaskCalls(calls);
    expect(issues.some((i) => i.includes('current_user_id'))).toBe(true);
  });

  it('reports millisecond timestamps in append_steps', () => {
    const calls = [
      {
        tool: 'feishu_task_task',
        action: 'append_steps',
        params: {
          task_guid: 'abc',
          idempotent_key: 'key1',
          task_steps: [{ timestamp: '1740545400000' }],
        },
      },
    ];
    const issues = validateTaskCalls(calls);
    expect(issues.some((i) => i.includes('milliseconds'))).toBe(true);
  });

  it('does not flag 10-digit timestamps', () => {
    const calls = [
      {
        tool: 'feishu_task_task',
        action: 'append_steps',
        params: {
          task_guid: 'abc',
          idempotent_key: 'key1',
          task_steps: [{ timestamp: '1740545400' }],
        },
      },
    ];
    expect(validateTaskCalls(calls)).toEqual([]);
  });

  it('returns empty array for valid patch call with task_guid', () => {
    const calls = [
      {
        tool: 'feishu_task_task',
        action: 'patch',
        params: { task_guid: 'abc123', completed_at: '2026-05-06 10:00:00' },
      },
    ];
    expect(validateTaskCalls(calls)).toEqual([]);
  });
});
