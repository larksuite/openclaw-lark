/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_get_user tool -- 获取用户信息
 *
 * 支持两种模式:
 * 1. 不传 user_id: 获取当前用户自己的信息 (sdk.authen.userInfo.get)
 * 2. 传 user_id: 获取指定用户的信息 (sdk.contact.v3.user.get)
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';
import { json, createToolContext, assertLarkOk, handleInvokeErrorWithAutoAuth, registerTool, StringEnum } from '../helpers';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const GetUserSchema = Type.Object({
  user_id: Type.Optional(
    Type.String({
      description: '用户 ID（格式如 ou_xxx）。若不传入，则获取当前用户自己的信息',
    }),
  ),
  user_id_type: Type.Optional(StringEnum(['open_id', 'union_id', 'user_id'])),
});

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

interface GetUserParams {
  user_id?: string;
  user_id_type?: 'open_id' | 'union_id' | 'user_id';
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerGetUserTool(api: OpenClawPluginApi) {
  if (!api.config) return;
  const cfg = api.config;

  const { toolClient, log } = createToolContext(api, 'feishu_get_user');

  registerTool(
    api,
    {
      name: 'feishu_get_user',
      label: 'Feishu: Get User Info',
      description:
        '获取用户信息。不传 user_id 时获取当前用户自己的信息；传 user_id 时获取指定用户的信息。' +
        '返回用户姓名、头像、邮箱、手机号、部门等信息。',
      parameters: GetUserSchema,
      async execute(_toolCallId: string, params: unknown) {
        const p = params as GetUserParams;
        try {
          const client = toolClient();

          // 模式 1: 获取当前用户自己的信息
          if (!p.user_id) {
            log.info('get_user: fetching current user info');

            try {
              const res = await client.invoke(
                'feishu_get_user.default',
                (sdk, opts) => sdk.authen.userInfo.get({}, opts),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info('get_user: current user fetched successfully');

              return json({
                user: res.data,
              });
            } catch (invokeErr) {
              // 特殊处理错误码 41050：用户组织架构可见范围限制
              if (invokeErr && typeof invokeErr === 'object') {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const e = invokeErr as any;
                if (e.response?.data?.code === 41050) {
                  return json({
                    error:
                      '无权限查询该用户信息。\n\n' +
                      '说明：使用用户身份调用通讯录 API 时，可操作的权限范围不受应用的通讯录权限范围影响，' +
                      '而是受当前用户的组织架构可见范围影响。该范围限制了用户在企业内可见的组织架构数据范围。',
                  });
                }
              }
              throw invokeErr;
            }
          }

          // 模式 2: 获取指定用户的信息
          log.info(`get_user: fetching user ${p.user_id}`);

          const userIdType = p.user_id_type || 'open_id';

          try {
            const res = await client.invoke(
              'feishu_get_user.default',
              (sdk, opts) =>
                sdk.contact.v3.user.get(
                  {
                    path: { user_id: p.user_id! },
                    params: {
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      user_id_type: userIdType as any,
                    },
                  },
                  opts,
                ),
              { as: 'user' },
            );
            assertLarkOk(res);

            log.info(`get_user: user ${p.user_id} fetched successfully`);

            return json({
              user: res.data?.user,
            });
          } catch (invokeErr) {
            // 特殊处理错误码 41050：用户组织架构可见范围限制
            if (invokeErr && typeof invokeErr === 'object') {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const e = invokeErr as any;
              if (e.response?.data?.code === 41050) {
                return json({
                  error:
                    '无权限查询该用户信息。\n\n' +
                    '说明：使用用户身份调用通讯录 API 时，可操作的权限范围不受应用的通讯录权限范围影响，' +
                    '而是受当前用户的组织架构可见范围影响。该范围限制了用户在企业内可见的组织架构数据范围。\n\n' +
                    '建议：请联系管理员调整当前用户的组织架构可见范围，或使用应用身份（tenant_access_token）调用 API。',
                });
              }
            }
            throw invokeErr;
          }
        } catch (err) {
          return await handleInvokeErrorWithAutoAuth(err, cfg);
        }
      },
    },
    { name: 'feishu_get_user' },
  );

}
