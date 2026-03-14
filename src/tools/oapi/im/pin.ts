/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_im_pin tool -- 以机器人身份 Pin/取消 Pin 消息
 *
 * Actions: create, delete
 *
 * Uses the Feishu IM API:
 *   - create: POST /open-apis/im/v1/pins
 *   - delete: DELETE /open-apis/im/v1/pins/:message_id
 *
 * Pin 功能用于将重要消息标记到会话的 Pin 列表中，所有成员可见。
 * 以机器人身份（tenant_access_token）调用。
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';
import { json, createToolContext, handleInvokeErrorWithAutoAuth } from '../helpers';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuImPinSchema = Type.Union([
  // CREATE (Pin 消息)
  Type.Object({
    action: Type.Literal('create'),
    message_id: Type.String({
      description: '要 Pin 的消息 ID（om_xxx 格式）',
    }),
  }),

  // DELETE (取消 Pin)
  Type.Object({
    action: Type.Literal('delete'),
    message_id: Type.String({
      description: '要取消 Pin 的消息 ID（om_xxx 格式）',
    }),
  }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuImPinParams =
  | {
      action: 'create';
      message_id: string;
    }
  | {
      action: 'delete';
      message_id: string;
    };

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFeishuImPinTool(api: OpenClawPluginApi) {
  if (!api.config) return;
  const cfg = api.config;

  const { toolClient, log } = createToolContext(api, 'feishu_im_pin');

  api.registerTool(
    {
      name: 'feishu_im_pin',
      label: 'Feishu: Pin Message',
      description:
        '飞书消息 Pin 工具。Pin 是将重要消息标记到会话的「Pin 列表」中，所有会话成员都可以在 Pin 列表中查看被标记的消息，方便快速定位关键信息。' +
        '\n\n**注意：Pin 不是"置顶消息"，而是"标记/收藏重要消息到共享列表"。**' +
        '\n\nActions:' +
        '\n- create（Pin 消息）：将指定 message_id 的消息添加到会话的 Pin 列表。机器人需为会话成员' +
        '\n- delete（取消 Pin）：将指定 message_id 的消息从 Pin 列表中移除' +
        '\n\n【使用场景】当用户要求"pin 这条消息"、"标记重要消息"、"取消 pin"时使用此工具。' +
        '\n\n【注意】' +
        '\n- 已被 Pin 的消息重复 Pin 会返回错误（错误码 230006）' +
        '\n- 已撤回的消息不可 Pin（错误码 230005）' +
        '\n- 取消 Pin 一条未曾 Pin 的消息不会报错',
      parameters: FeishuImPinSchema,
      async execute(_toolCallId: string, params: unknown) {
        const p = params as FeishuImPinParams;
        try {
          const client = toolClient();

          switch (p.action) {
            // -----------------------------------------------------------------
            // CREATE PIN
            // -----------------------------------------------------------------
            case 'create': {
              log.info(`create: message_id=${p.message_id}`);

              const res = await client.invoke<{
                code?: number;
                msg?: string;
                data?: {
                  pin?: {
                    message_id?: string;
                    chat_id?: string;
                    operator_id?: string;
                    operator_id_type?: string;
                    create_time?: string;
                  };
                };
              }>(
                'feishu_im_pin.create',
                (sdk) =>
                  sdk.request({
                    url: '/open-apis/im/v1/pins',
                    method: 'POST',
                    data: { message_id: p.message_id },
                  }),
                {
                  as: 'tenant',
                },
              );

              if (res.code !== 0) {
                log.warn(`create: failed, code=${res.code}, msg=${res.msg}`);
                return json({ error: res.msg, code: res.code });
              }

              log.info(`create: success, message_id=${res.data?.pin?.message_id}`);
              return json({
                pin: res.data?.pin,
              });
            }

            // -----------------------------------------------------------------
            // DELETE PIN
            // -----------------------------------------------------------------
            case 'delete': {
              log.info(`delete: message_id=${p.message_id}`);

              const res = await client.invoke<{
                code?: number;
                msg?: string;
              }>(
                'feishu_im_pin.delete',
                (sdk) =>
                  sdk.request({
                    url: `/open-apis/im/v1/pins/${p.message_id}`,
                    method: 'DELETE',
                  }),
                {
                  as: 'tenant',
                },
              );

              if (res.code !== 0) {
                log.warn(`delete: failed, code=${res.code}, msg=${res.msg}`);
                return json({ error: res.msg, code: res.code });
              }

              log.info(`delete: success, message_id=${p.message_id}`);
              return json({ success: true, message_id: p.message_id });
            }
          }
        } catch (err) {
          return await handleInvokeErrorWithAutoAuth(err, cfg);
        }
      },
    },
    { name: 'feishu_im_pin' },
  );

  api.logger.info?.('feishu_im_pin: Registered feishu_im_pin tool');
}
