/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_task_agent tool -- Manage Feishu Task Agent registration.
 *
 * Actions:
 * - register:        Register task agent (tenant identity)
 * - update_profile:  Update task agent profile (tenant identity)
 *

 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';

import { createToolContext, handleInvokeErrorWithAutoAuth, json, registerTool } from '../helpers';
import { rawLarkRequest } from '../../../core/raw-request';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuTaskAgentSchema = Type.Union([
    Type.Object({
        action: Type.Literal('register'),
    }),
    Type.Object({
        action: Type.Literal('update_profile'),
        profile_content: Type.String(),
    }),
]);

type FeishuTaskAgentParams =
    | { action: 'register' }
    | { action: 'update_profile'; profile_content: string };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolvePathForAction(action: FeishuTaskAgentParams['action']): { path: string; env: string[] } {
    if (action === 'register') {
        return { path: '/open-apis/task/v2/agent/register_agent', env: [] };
    }

     return  { path: '/open-apis/task/v2/agent/update_agent_profile', env: [] };

}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFeishuTaskAgentTool(api: OpenClawPluginApi): void {
    if (!api.config) return;
    const cfg = api.config;

    const { toolClient } = createToolContext(api, 'feishu_task_agent');

    registerTool(
        api,
        {
            name: 'feishu_task_agent',
            label: 'Feishu Task Agent Registration',
            description:
                '飞书任务 Agent 注册管理工具。用于注册/取消注册 Task Agent，以及查询已注册列表。',
            parameters: FeishuTaskAgentSchema,
            async execute(_toolCallId: string, params: unknown) {
                const p = params as FeishuTaskAgentParams;
                try {
                    const normalizedAction = p.action ;

                    const resolved = resolvePathForAction(p.action);

                    const client = toolClient();

                    const tatRes = await rawLarkRequest(
                        {
                            brand: client.account.brand,
                            path: '/open-apis/auth/v3/tenant_access_token/internal/',
                            method: 'POST',
                            body: {
                                app_id: client.sdk.appId,
                                app_secret: client.sdk.appSecret,
                            },
                        },
                    );
                    const token = (tatRes as any)?.tenant_access_token ?? "";

                    // Match openclaw-lark-task semantics:
                    // - register/update_profile use tenant identity (TAT)
                    const as =
                        normalizedAction === 'register' ||normalizedAction === 'update_profile'
                            ? 'tenant'
                            : 'user';




                    if (normalizedAction === 'update_profile') {
                        const res = await client.invokeByPath('feishu_task_agent.update_profile', resolved.path, {
                            method: 'POST',
                            as,
                            body: {
                                profile_content: p.profile_content,
                            },
                            headers: {
                                'authorization': `Bearer ${token}`,
                            },
                        });
                        return json(res);
                    }

                    // register
                    if (normalizedAction === 'register') {
                        const res = await client.invokeByPath('feishu_task_agent.register', resolved.path, {
                            method: 'POST',
                            as,
                            headers: {
                                'authorization': `Bearer ${token}`,
                            },
                        });
                        return json(res);
                    }
                    return json({
                        error: `p.action is invalid ${normalizedAction}`,
                    });
                } catch (err) {
                    return await handleInvokeErrorWithAutoAuth(err, cfg);
                }
            },
        },
        { name: 'feishu_task_agent' },
    );
}