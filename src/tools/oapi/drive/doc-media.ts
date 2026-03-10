/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_doc_media tool -- 文档媒体管理（插入 + 下载）
 *
 * Actions:
 *   insert   - 在飞书文档末尾插入本地图片或文件（3 步流程）
 *   download - 下载文档素材或画板缩略图到本地
 *
 * 使用以下 SDK 接口:
 * - sdk.docx.documentBlockChildren.create - 创建子块
 * - sdk.drive.v1.media.uploadAll - 上传素材
 * - sdk.docx.documentBlock.batchUpdate - 批量更新块
 * - sdk.drive.v1.media.download - 下载素材
 * - sdk.board.v1.whiteboard.downloadAsImage - 下载画板缩略图
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';
import { json, createToolContext, assertLarkOk, handleInvokeErrorWithAutoAuth } from '../helpers';
import { validateLocalMediaRoots } from '../../../messaging/outbound/media-url-utils';
import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { imageSize } from 'image-size';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

const ALIGN_MAP: Record<string, number> = {
  left: 1,
  center: 2,
  right: 3,
};

/** 插入时的媒体类型配置 */
const MEDIA_CONFIG = {
  image: {
    block_type: 27,
    block_data: { image: {} },
    parent_type: 'docx_image' as const,
    label: '图片',
  },
  file: {
    block_type: 23,
    block_data: { file: { token: '' } },
    parent_type: 'docx_file' as const,
    label: '文件',
  },
};

/** MIME type → 扩展名映射 */
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * 从文档 URL 或纯 ID 中提取 document_id
 */
function extractDocumentId(input: string): string {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/\/docx\/([A-Za-z0-9]+)/);
  if (urlMatch) return urlMatch[1];
  return trimmed;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const DocMediaSchema = Type.Union([
  // INSERT action
  Type.Object({
    action: Type.Literal('insert'),
    doc_id: Type.String({
      description: '文档 ID 或文档 URL（必填）。支持从 URL 自动提取 document_id',
    }),
    file_path: Type.String({
      description: '本地文件的绝对路径（必填）。图片支持 jpg/png/gif/webp 等，文件支持任意格式，最大 20MB',
    }),
    type: Type.Optional(
      Type.Union([Type.Literal('image'), Type.Literal('file')], {
        description: '媒体类型："image"（图片，默认）或 "file"（文件附件）',
      }),
    ),
    align: Type.Optional(
      Type.Union([Type.Literal('left'), Type.Literal('center'), Type.Literal('right')], {
        description: '对齐方式（仅图片生效）："center"（默认居中）、"left"（居左）、"right"（居右）',
      }),
    ),
    caption: Type.Optional(
      Type.String({
        description: '图片描述/标题（可选，仅图片生效）',
      }),
    ),
  }),

  // DOWNLOAD action
  Type.Object({
    action: Type.Literal('download'),
    resource_token: Type.String({
      description: '资源的唯一标识（file_token 用于文档素材，whiteboard_id 用于画板）',
    }),
    resource_type: Type.Union([Type.Literal('media'), Type.Literal('whiteboard')], {
      description: '资源类型：media（文档素材：图片、视频、文件等）或 whiteboard（画板缩略图）',
    }),
    output_path: Type.String({
      description:
        '保存文件的完整本地路径。可以包含扩展名（如 /tmp/image.png），' +
        '也可以不带扩展名，系统会根据 Content-Type 自动添加',
    }),
  }),
]);

// ---------------------------------------------------------------------------
// Params types
// ---------------------------------------------------------------------------

interface InsertParams {
  action: 'insert';
  doc_id: string;
  file_path: string;
  type?: 'image' | 'file';
  align?: 'left' | 'center' | 'right';
  caption?: string;
}

interface DownloadParams {
  action: 'download';
  resource_token: string;
  resource_type: 'media' | 'whiteboard';
  output_path: string;
}

type DocMediaParams = InsertParams | DownloadParams;

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

async function handleInsert(
  p: InsertParams,
  client: ReturnType<ReturnType<typeof createToolContext>['toolClient']>,
  log: ReturnType<typeof createToolContext>['log'],
) {
  const documentId = extractDocumentId(p.doc_id);
  const mediaType = p.type ?? 'image';
  const config = MEDIA_CONFIG[mediaType];

  // 0. 路径白名单校验 — 仅允许 tmpdir 下的文件
  const filePath = p.file_path;
  const DOC_MEDIA_ALLOWED_ROOTS: readonly string[] = [os.tmpdir()];
  validateLocalMediaRoots(path.resolve(filePath), DOC_MEDIA_ALLOWED_ROOTS);

  // 1. 读取并校验本地文件
  let fileSize: number;
  try {
    const stat = await fs.stat(filePath);
    fileSize = stat.size;
  } catch (err) {
    return json({
      error: `failed to read file: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  if (fileSize > MAX_FILE_SIZE) {
    return json({
      error: `file ${(fileSize / 1024 / 1024).toFixed(1)}MB exceeds 20MB limit`,
    });
  }

  const fileName = path.basename(filePath);
  log.info(`insert: doc=${documentId}, type=${mediaType}, file=${fileName}, size=${fileSize}`);

  // 2. 创建空 Block（追加到文档末尾）
  const createRes: any = await client.invoke(
    'feishu_doc_media.insert',
    (sdk, opts) =>
      (sdk.docx.documentBlockChildren as any).create(
        {
          path: {
            document_id: documentId,
            block_id: documentId,
          },
          data: {
            children: [{ block_type: config.block_type, ...config.block_data }],
          },
          params: { document_revision_id: -1 },
        },
        opts,
      ),
    { as: 'user' },
  );
  assertLarkOk(createRes);

  // File Block 返回 View Block（block_type: 33）作为容器，
  // 真正的 File Block ID 在 children[0].children[0]；
  // Image Block 直接返回，block_id 在 children[0].block_id
  let blockId: string | undefined;
  if (mediaType === 'file') {
    blockId = createRes.data?.children?.[0]?.children?.[0];
  } else {
    blockId = createRes.data?.children?.[0]?.block_id;
  }
  if (!blockId) {
    return json({
      error: `failed to create ${config.label} block: no block_id returned`,
    });
  }
  log.info(`insert: created ${mediaType} block ${blockId}`);

  // 3. 上传素材
  const uploadRes: any = await client.invoke(
    'feishu_doc_media.insert',
    (sdk, opts) =>
      (sdk.drive.v1.media as any).uploadAll(
        {
          data: {
            file_name: fileName,
            parent_type: config.parent_type,
            parent_node: blockId,
            size: fileSize,
            file: createReadStream(filePath),
            extra: JSON.stringify({
              drive_route_token: documentId,
            }),
          },
        },
        opts,
      ),
    { as: 'user' },
  );

  const fileToken = uploadRes?.file_token ?? uploadRes?.data?.file_token;
  if (!fileToken) {
    return json({
      error: `failed to upload ${config.label} media: no file_token returned`,
    });
  }
  log.info(`insert: uploaded media, file_token=${fileToken}`);

  // 4. 批量更新 Block - 设置 token
  const patchRequest: any = { block_id: blockId };

  if (mediaType === 'image') {
    const alignNum = ALIGN_MAP[p.align ?? 'center'];

    // 自动检测图片尺寸
    let width: number | undefined;
    let height: number | undefined;
    try {
      const imgBuf = await fs.readFile(filePath);
      const dims = imageSize(imgBuf);
      if (dims.width && dims.height) {
        width = dims.width;
        height = dims.height;
        log.info(`insert: detected image size ${width}x${height}`);
      }
    } catch {
      log.info('insert: could not detect image dimensions, skipping');
    }

    patchRequest.replace_image = {
      token: fileToken,
      align: alignNum,
      ...(width != null ? { width } : {}),
      ...(height != null ? { height } : {}),
      ...(p.caption ? { caption: { content: p.caption } } : {}),
    };
  } else {
    patchRequest.replace_file = { token: fileToken };
  }

  const patchRes: any = await client.invoke(
    'feishu_doc_media.insert',
    (sdk, opts) =>
      sdk.docx.documentBlock.batchUpdate(
        {
          path: { document_id: documentId },
          data: { requests: [patchRequest] },
          params: { document_revision_id: -1 },
        },
        opts,
      ),
    { as: 'user' },
  );
  assertLarkOk(patchRes);
  log.info(`insert: patched ${mediaType} block with file_token`);

  return json({
    success: true,
    type: mediaType,
    document_id: documentId,
    block_id: blockId,
    file_token: fileToken,
    file_name: fileName,
  });
}

async function handleDownload(
  p: DownloadParams,
  client: ReturnType<ReturnType<typeof createToolContext>['toolClient']>,
  log: ReturnType<typeof createToolContext>['log'],
) {
  log.info(`download: resource_type=${p.resource_type}, token="${p.resource_token}"`);

  let res: any;
  if (p.resource_type === 'media') {
    res = await client.invoke(
      'feishu_doc_media.download',
      (sdk, opts) => sdk.drive.v1.media.download({ path: { file_token: p.resource_token } }, opts),
      { as: 'user' },
    );
  } else {
    res = await client.invoke(
      'feishu_doc_media.download',
      (sdk, opts) => sdk.board.v1.whiteboard.downloadAsImage({ path: { whiteboard_id: p.resource_token } }, opts),
      { as: 'user' },
    );
  }

  // 读取二进制流
  const stream = res.getReadableStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  log.info(`download: received ${buffer.length} bytes`);

  // 从 Content-Type 推断扩展名
  const contentType: string = res.headers?.['content-type'] || '';
  let finalPath = p.output_path;
  const currentExt = path.extname(p.output_path);

  if (!currentExt && contentType) {
    const mimeType = contentType.split(';')[0].trim();
    const defaultExt = p.resource_type === 'whiteboard' ? '.png' : undefined;
    const suggestedExt = MIME_TO_EXT[mimeType] || defaultExt;
    if (suggestedExt) {
      finalPath = p.output_path + suggestedExt;
      log.info(`download: auto-detected extension ${suggestedExt}`);
    }
  }

  // 确保父目录存在并保存
  await fs.mkdir(path.dirname(finalPath), { recursive: true });

  try {
    await fs.writeFile(finalPath, buffer);
    log.info(`download: saved to ${finalPath}`);
  } catch (err) {
    return json({
      error: `failed to save file: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return json({
    resource_type: p.resource_type,
    resource_token: p.resource_token,
    size_bytes: buffer.length,
    content_type: contentType,
    saved_path: finalPath,
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerDocMediaTool(api: OpenClawPluginApi) {
  if (!api.config) return;
  const cfg = api.config;

  const { toolClient, log } = createToolContext(api, 'feishu_doc_media');

  api.registerTool(
    {
      name: 'feishu_doc_media',
      label: 'Feishu: Document Media',
      description:
        '【以用户身份】文档媒体管理工具。' +
        '支持两种操作：' +
        '(1) insert - 在飞书文档末尾插入本地图片或文件（需要文档 ID + 本地文件路径）；' +
        '(2) download - 下载文档素材或画板缩略图到本地（需要资源 token + 输出路径）。' +
        '\n\n【重要】insert 仅支持本地文件路径。URL 图片请使用 create-doc/update-doc 的 <image url="..."/> 语法。',
      parameters: DocMediaSchema,
      async execute(_toolCallId: string, params: unknown) {
        const p = params as DocMediaParams;
        try {
          const client = toolClient();
          if (p.action === 'insert') {
            return await handleInsert(p, client, log);
          }
          if (p.action === 'download') {
            return await handleDownload(p, client, log);
          }
          return json({ error: `unknown action: ${(p as any).action}` });
        } catch (err) {
          return await handleInvokeErrorWithAutoAuth(err, cfg);
        }
      },
    },
    { name: 'feishu_doc_media' },
  );

  api.logger.info?.('feishu_doc_media: Registered feishu_doc_media tool (insert, download)');
}
