// SPDX-License-Identifier: MIT

/**
 * `before_agent_finalize` hook — validates Feishu task tool calls
 * before the agent run finalizes.
 *
 * When the last assistant message contains incomplete task operations
 * (e.g. missing `task_guid` for `patch`), requests a revise pass
 * with specific correction instructions.
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { larkLogger } from '../core/lark-logger';

const log = larkLogger('hooks/finalize');

// ---------------------------------------------------------------------------
// Validation rules derived from skills/feishu-task/SKILL.md
// ---------------------------------------------------------------------------

interface TaskCall {
  tool: string;
  action: string;
  params: Record<string, unknown>;
}

const ACTIONS_REQUIRING_TASK_GUID = new Set([
  'patch',
  'get',
  'add_members',
  'append_steps',
]);

/**
 * Extract feishu_task_* tool call blocks from an assistant message.
 *
 * Looks for JSON objects containing `"action"` and `"tool"` or
 * tool-name patterns like `feishu_task_task`. Also catches inline
 * JSON code blocks that contain task tool invocations.
 */
export function extractTaskCalls(message: string): TaskCall[] {
  const calls: TaskCall[] = [];

  // Match JSON code blocks and bare JSON objects
  const jsonPattern = /```(?:json)?\s*([\s\S]*?)```|(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})/g;
  let match: RegExpExecArray | null;

  while ((match = jsonPattern.exec(message)) !== null) {
    const raw = (match[1] ?? match[2] ?? '').trim();
    if (!raw) continue;

    try {
      const parsed = JSON.parse(raw);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];

      for (const obj of candidates) {
        if (typeof obj !== 'object' || obj == null) continue;

        // Detect tool name from various conventions
        const tool: string =
          obj.tool ??
          obj.toolName ??
          obj.name ??
          '';

        if (!/^feishu_task_/.test(tool)) continue;

        const action: string = obj.action ?? '';
        calls.push({ tool, action, params: obj as Record<string, unknown> });
      }
    } catch {
      // Not valid JSON — skip
    }
  }

  return calls;
}

/**
 * Validate extracted task tool calls against SKILL.md constraints.
 * Returns an array of human-readable issue descriptions (empty = valid).
 */
export function validateTaskCalls(calls: TaskCall[]): string[] {
  const issues: string[] = [];

  for (const call of calls) {
    const prefix = `[${call.tool}/${call.action || '?'}]`;

    // Actions that require task_guid
    if (ACTIONS_REQUIRING_TASK_GUID.has(call.action)) {
      if (!call.params.task_guid) {
        issues.push(`${prefix} missing required "task_guid" parameter`);
      }
    }

    // tasklist.tasks requires tasklist_guid
    if (call.tool === 'feishu_task_tasklist' && call.action === 'tasks') {
      if (!call.params.tasklist_guid) {
        issues.push(`${prefix} missing required "tasklist_guid" parameter`);
      }
    }

    // create strongly recommends current_user_id
    if (call.action === 'create' && call.tool === 'feishu_task_task') {
      if (!call.params.current_user_id) {
        issues.push(
          `${prefix} missing "current_user_id" — creator may lose edit access to the task`,
        );
      }
    }

    // append_steps: validate timestamp format (should be 10-digit seconds)
    if (call.action === 'append_steps' && Array.isArray(call.params.task_steps)) {
      for (const step of call.params.task_steps as Record<string, unknown>[]) {
        if (typeof step.timestamp === 'string' && step.timestamp.length === 13) {
          issues.push(
            `${prefix} timestamp "${step.timestamp}" looks like milliseconds (13 digits) — use 10-digit seconds`,
          );
        }
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Hook registration
// ---------------------------------------------------------------------------

export function registerBeforeAgentFinalizeHook(api: OpenClawPluginApi): void {
  // The SDK exposes the typed hook name. The `as any` bridge handles
  // the case where the local SDK type definitions lag behind the
  // runtime that actually ships the hook.
  (api as any).on(
    'before_agent_finalize',
    (event: { lastAssistantMessage?: string }, ctx: { channelId?: string; sessionKey?: string }) => {
      // Only validate for Feishu sessions
      if (ctx.channelId !== 'feishu') return;

      const msg = event.lastAssistantMessage;
      if (!msg) return;

      const calls = extractTaskCalls(msg);
      if (calls.length === 0) return;

      const issues = validateTaskCalls(calls);
      if (issues.length === 0) return;

      log.warn(`task validation found ${issues.length} issue(s) in ${ctx.sessionKey ?? '-'}`);
      return {
        action: 'revise',
        reason: `Task tool validation: ${issues.length} issue(s)`,
        retry: {
          instruction: `Please fix these issues before proceeding:\n${issues.map((i) => `- ${i}`).join('\n')}`,
          maxAttempts: 1,
        },
      };
    },
  );

  log.info('registered before_agent_finalize hook for Feishu task validation');
}
