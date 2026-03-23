/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_im_bot_image 工具
 *
 * 以机器人身份下载飞书 IM 消息中的图片/文件资源到本地。
 *
 * 飞书 API:
 *   - 下载资源: GET  /open-apis/im/v1/messages/:message_id/resources/:file_key
 * 权限: im:resource
 * 凭证: tenant_access_token
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { buildRandomTempFilePath } from 'openclaw/plugin-sdk/temp-path';
import { Type } from '@sinclair/typebox';
import { json, createToolContext, formatLarkError, registerTool, StringEnum } from '../../oapi/helpers';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

// ===========================================================================
// Shared constants
// ===========================================================================

/** MIME type → 文件扩展名（下载时使用） */
const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'video/mp4': '.mp4',
  'video/mpeg': '.mpeg',
  'video/quicktime': '.mov',
  'video/x-msvideo': '.avi',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/zip': '.zip',
  'application/x-rar-compressed': '.rar',
  'text/plain': '.txt',
  'application/json': '.json',
};

// ===========================================================================
// Shared helpers
// ===========================================================================

/**
 * 从二进制响应中提取 Buffer、Content-Type。
 * SDK 的二进制响应可能有 getReadableStream()，也可能直接是 Buffer 等格式。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function extractBuffer(res: any): Promise<{
  buffer: Buffer;
  contentType: string;
}> {
  let chunks: Buffer[];
  if (typeof res.getReadableStream === 'function') {
    const stream = res.getReadableStream();
    chunks = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } else if (Buffer.isBuffer(res)) {
    chunks = [res];
  } else if (Buffer.isBuffer(res?.data)) {
    chunks = [res.data];
  } else {
    throw new Error('无法从响应中提取二进制数据');
  }

  const buffer = Buffer.concat(chunks);
  const contentType: string = res.headers?.['content-type'] ?? '';
  return { buffer, contentType };
}

/**
 * 将 buffer 保存到临时文件，返回路径。
 */
async function saveToTempFile(buffer: Buffer, contentType: string, prefix: string): Promise<string> {
  const mimeType = contentType ? contentType.split(';')[0].trim() : '';
  const mimeExt = mimeType ? MIME_TO_EXT[mimeType] : undefined;

  const filePath = buildRandomTempFilePath({
    prefix,
    extension: mimeExt,
  });

  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  await fsPromises.writeFile(filePath, buffer);
  return filePath;
}

// ===========================================================================
// Download tool — feishu_im_bot_image
// ===========================================================================

const FeishuImBotImageSchema = Type.Object({
  message_id: Type.String({
    description: '消息 ID（om_xxx 格式），引用消息可从上下文中的 [message_id=om_xxx] 提取',
  }),
  file_key: Type.String({
    description: '资源 Key，图片消息的 image_key（img_xxx）或文件消息的 file_key（file_xxx）',
  }),
  type: StringEnum(['image', 'file'], {
    description: '资源类型：image（图片消息中的图片）、file（文件/音频/视频消息中的文件）',
  }),
});

interface FeishuImBotImageParams {
  message_id: string;
  file_key: string;
  type: 'image' | 'file';
}

export function registerFeishuImBotImageTool(api: OpenClawPluginApi): boolean {
  if (!api.config) return false;

  const { getClient, log } = createToolContext(api, 'feishu_im_bot_image');

  return registerTool(
    api,
    {
      name: 'feishu_im_bot_image',
      label: 'Feishu: IM Bot Image Download',
      description:
        '【以机器人身份】下载飞书 IM 消息中的图片或文件资源到本地。' +
        '\n\n适用场景：用户直接发送给机器人的消息、用户引用的消息、机器人收到的群聊消息中的图片/文件。' +
        '即当前对话上下文中出现的 message_id 和 image_key/file_key，应使用本工具下载。' +
        '\n引用消息的 message_id 可从上下文中的 [message_id=om_xxx] 提取，无需向用户询问。' +
        '\n\n文件自动保存到 /tmp/openclaw/ 下，返回值中的 saved_path 为实际保存路径。',
      parameters: FeishuImBotImageSchema,
      async execute(_toolCallId: string, params: unknown) {
        const p = params as FeishuImBotImageParams;

        try {
          const client = getClient();

          log.info(`download: message_id="${p.message_id}", file_key="${p.file_key}", type="${p.type}"`);

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const res: any = await client.im.messageResource.get({
            path: {
              message_id: p.message_id,
              file_key: p.file_key,
            },
            params: { type: p.type },
          });

          const { buffer, contentType } = await extractBuffer(res);
          log.info(`download: ${buffer.length} bytes, content-type=${contentType}`);

          const savedPath = await saveToTempFile(buffer, contentType, 'bot-resource');
          log.info(`download: saved to ${savedPath}`);

          return json({
            message_id: p.message_id,
            file_key: p.file_key,
            type: p.type,
            size_bytes: buffer.length,
            content_type: contentType,
            saved_path: savedPath,
          });
        } catch (err) {
          log.error(`Error: ${formatLarkError(err)}`);
          return json({ error: formatLarkError(err) });
        }
      },
    },
    { name: 'feishu_im_bot_image' },
  );
}
