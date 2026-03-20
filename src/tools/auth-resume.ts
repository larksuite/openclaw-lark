/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Helpers for carrying tool resume context across auth flows.
 */

import type { LarkTicket } from '../core/lark-ticket';

const DEFAULT_RESUME_TEXT = '我已完成飞书账号授权，请直接恢复刚才被打断的工具调用。';

export function buildToolResumeText(toolName: string, params: unknown): string {
  return [
    'System: 飞书授权已完成。请不要要求用户重新授权，也不要让用户重复发送“继续”。',
    `System: 现在请直接恢复刚才被打断的工具调用：${toolName}`,
    'System: 工具参数如下：',
    JSON.stringify(params, null, 2),
  ].join('\n');
}

export function resolveResumeText(
  ticket?: Pick<LarkTicket, 'resumeText'>,
  fallbackText: string = DEFAULT_RESUME_TEXT,
): string {
  return ticket?.resumeText?.trim() || fallbackText;
}
