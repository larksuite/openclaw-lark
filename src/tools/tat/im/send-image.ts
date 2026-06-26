/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_im_bot_send_image 工具
 *
 * 以机器人身份可靠发送飞书 IM 图片消息。
 *
 * 飞书 API:
 *   - 上传图片: POST /open-apis/im/v1/images
 *   - 发送消息: POST /open-apis/im/v1/messages
 *   - 回复消息: POST /open-apis/im/v1/messages/:message_id/reply
 * 权限: im:resource, im:message:send_as_bot
 * 凭证: tenant_access_token
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';
import { uploadAndSendImageLark } from '../../../messaging/outbound/media';
import { createToolContext, formatLarkError, json, registerTool } from '../../oapi/helpers';

const BOT_SEND_IMAGE_LOCAL_ROOTS = ['/tmp/openclaw'] as const;

const FeishuImBotSendImageSchema = Type.Object({
  to: Type.Optional(
    Type.String({
      description: '接收者 ID。群聊用 oc_xxx，用户用 ou_xxx。回复消息时可省略，但直接发送新消息时必填。',
    }),
  ),
  image: Type.String({
    description:
      '图片 URL、file:// URL 或本地路径。优先使用 http/https URL；本地路径默认只允许 /tmp/openclaw 下的文件。',
  }),
  file_name: Type.Optional(
    Type.String({
      description: '可选文件名，仅用于日志和调用方可读性；图片格式以二进制内容检测为准。',
    }),
  ),
  reply_to_message_id: Type.Optional(
    Type.String({
      description: '要回复的消息 ID（om_xxx）。提供后将通过回复接口发送图片。',
    }),
  ),
  reply_in_thread: Type.Optional(
    Type.Boolean({
      description: '是否以话题形式回复。仅在 reply_to_message_id 存在时生效。',
    }),
  ),
});

interface FeishuImBotSendImageParams {
  to?: string;
  image: string;
  file_name?: string;
  reply_to_message_id?: string;
  reply_in_thread?: boolean;
}

export function registerFeishuImBotSendImageTool(api: OpenClawPluginApi): boolean {
  if (!api.config) return false;

  const { toolClient, log } = createToolContext(api, 'feishu_im_bot_send_image');

  return registerTool(
    api,
    {
      name: 'feishu_im_bot_send_image',
      label: 'Feishu: IM Bot Image Send',
      description:
        '【以机器人身份】可靠发送飞书图片消息。' +
        '\n\n固定执行官方两步流程：先上传图片获取 image_key，再发送 msg_type=image 消息。' +
        '本工具只在真正发出图片消息后返回 ok=true；不会把失败静默降级成文本链接或文件消息。' +
        '\n\n适用场景：需要保证对方看到的是图片，而不是卡片占位、链接或附件。' +
        '\n\n【安全约束】只有在用户明确要求发送图片，并且发送对象来自当前对话上下文或用户明确提供时才能调用。禁止自行选择新接收者、扩大接收范围或批量发送。' +
        '\n\n限制：图片需符合飞书官方限制：JPG/JPEG/PNG/WEBP/GIF/BMP/ICO/TIFF/HEIC，大小不超过 10 MB；GIF 不超过 2000x2000，其他图片不超过 12000x12000。',
      parameters: FeishuImBotSendImageSchema,
      async execute(_toolCallId: string, params: unknown) {
        const p = params as FeishuImBotSendImageParams;

        try {
          if (!p.to && !p.reply_to_message_id) {
            return json({ error: 'to 或 reply_to_message_id 至少需要提供一个。' });
          }

          const currentClient = toolClient();
          log.info(`send_image: to="${p.to ?? ''}", reply_to="${p.reply_to_message_id ?? ''}", image="${p.image}"`);

          const result = await uploadAndSendImageLark({
            cfg: currentClient.config,
            to: p.to ?? '',
            imageUrl: p.image,
            fileName: p.file_name,
            replyToMessageId: p.reply_to_message_id,
            replyInThread: p.reply_in_thread,
            accountId: currentClient.account.accountId,
            mediaLocalRoots: BOT_SEND_IMAGE_LOCAL_ROOTS,
          });

          return json({
            ok: true,
            message_id: result.messageId,
            chat_id: result.chatId,
            image_key: result.imageKey,
            image_format: result.imageFormat,
            width: result.width,
            height: result.height,
          });
        } catch (err) {
          log.error(`send_image error: ${formatLarkError(err)}`);
          return json({ ok: false, error: formatLarkError(err) });
        }
      },
    },
    { name: 'feishu_im_bot_send_image' },
  );
}
