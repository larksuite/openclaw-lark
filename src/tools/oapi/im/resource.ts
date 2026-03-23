/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_im_user_fetch_resource tool -- 以用户身份下载 IM 消息中的文件/图片资源
 *
 * 使用飞书 API:
 *   - im.v1.messageResource.get: GET /open-apis/im/v1/messages/:message_id/resources/:file_key
 *
 * 全部以用户身份（user_access_token）调用，scope 来自 real-scope.json。
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { buildRandomTempFilePath } from 'openclaw/plugin-sdk/temp-path';
import { Type } from '@sinclair/typebox';
import { json, createToolContext, handleInvokeErrorWithAutoAuth, registerTool, StringEnum } from '../helpers';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Helper: MIME type to extension mapping
// ---------------------------------------------------------------------------

const MIME_TO_EXT: Record<string, string> = {
  // Images
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  // Videos
  'video/mp4': '.mp4',
  'video/mpeg': '.mpeg',
  'video/quicktime': '.mov',
  'video/x-msvideo': '.avi',
  'video/webm': '.webm',
  // Audio
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  // Documents
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  // Others
  'application/zip': '.zip',
  'application/x-rar-compressed': '.rar',
  'text/plain': '.txt',
  'application/json': '.json',
};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FetchResourceSchema = Type.Object({
  message_id: Type.String({
    description: '消息 ID（om_xxx 格式），从消息事件或消息列表中获取',
  }),
  file_key: Type.String({
    description: '资源 Key，从消息体中获取。图片消息的 image_key（img_xxx）或文件消息的 file_key（file_xxx）',
  }),
  type: StringEnum(['image', 'file'], {
    description: '资源类型：image（图片消息中的图片）、file（文件/音频/视频消息中的文件）',
  }),
});

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

interface FetchResourceParams {
  message_id: string;
  file_key: string;
  type: 'image' | 'file';
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFeishuImUserFetchResourceTool(api: OpenClawPluginApi): boolean {
  if (!api.config) return false;
  const cfg = api.config;

  const { toolClient, log } = createToolContext(api, 'feishu_im_user_fetch_resource');

  return registerTool(
    api,
    {
      name: 'feishu_im_user_fetch_resource',
      label: 'Feishu: IM Fetch Resource',
      description:
        '【以用户身份】下载飞书 IM 消息中的文件或图片资源到本地文件。需要用户 OAuth 授权。' +
        '\n\n适用场景：当你以用户身份调用了消息列表/搜索等 API 获取到 message_id 和 file_key 时，' +
        '应使用本工具以同样的用户身份下载资源。' +
        '\n注意：如果 message_id 来自当前对话上下文（用户发给机器人的消息、引用的消息），' +
        '请使用 feishu_im_bot_image 工具以机器人身份下载，无需用户授权。' +
        '\n\n参数说明：' +
        '\n- message_id：消息 ID（om_xxx），从消息事件或消息列表中获取' +
        '\n- file_key：资源 Key，从消息体中获取。图片用 image_key（img_xxx），文件用 file_key（file_xxx）' +
        '\n- type：图片用 image，文件/音频/视频用 file' +
        '\n\n文件自动保存到 /tmp/openclaw/ 下，返回值中的 saved_path 为实际保存路径。' +
        '\n限制：文件大小不超过 100MB。不支持下载表情包、合并转发消息、卡片中的资源。',
      parameters: FetchResourceSchema,
      async execute(_toolCallId: string, params: unknown) {
        const p = params as FetchResourceParams;
        try {
          const client = toolClient();

          log.info(`fetch_resource: message_id="${p.message_id}", file_key="${p.file_key}", type="${p.type}"`);

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const res: any = await client.invoke(
            'feishu_im_user_fetch_resource.default',
            (sdk, opts) =>
              sdk.im.v1.messageResource.get(
                {
                  params: { type: p.type },
                  path: { message_id: p.message_id, file_key: p.file_key },
                },
                opts,
              ),
            {
              as: 'user',
            },
          );

          // 响应是二进制流，使用 getReadableStream() 读取
          const stream = res.getReadableStream();
          const chunks: Buffer[] = [];

          for await (const chunk of stream) {
            chunks.push(chunk);
          }

          const buffer = Buffer.concat(chunks);

          log.info(`fetch_resource: downloaded ${buffer.length} bytes`);

          // 从响应头获取 Content-Type，并确定文件扩展名
          const contentType = res.headers?.['content-type'] || '';
          log.info(`fetch_resource: content-type=${contentType}`);

          // 从 Content-Type 推断扩展名，自动生成保存路径
          const mimeType = contentType ? contentType.split(';')[0].trim() : '';
          const mimeExt = mimeType ? MIME_TO_EXT[mimeType] : undefined;

          const finalPath = buildRandomTempFilePath({
            prefix: 'im-resource',
            extension: mimeExt,
          });
          log.info(`fetch_resource: saving to ${finalPath}`);

          // 确保父目录存在
          await fs.mkdir(path.dirname(finalPath), { recursive: true });

          // 保存文件
          try {
            await fs.writeFile(finalPath, buffer);
            log.info(`fetch_resource: saved to ${finalPath}`);

            return json({
              message_id: p.message_id,
              file_key: p.file_key,
              type: p.type,
              size_bytes: buffer.length,
              content_type: contentType,
              saved_path: finalPath,
            });
          } catch (err) {
            log.error(`fetch_resource: failed to save file: ${err}`);
            return json({
              error: `保存文件失败: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        } catch (err) {
          return await handleInvokeErrorWithAutoAuth(err, cfg);
        }
      },
    },
    { name: 'feishu_im_user_fetch_resource' },
  );
}
