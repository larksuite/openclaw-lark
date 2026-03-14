/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_drive_file tool -- Manage Feishu Drive files.
 *
 * Actions: list, get_meta, copy, move, delete, upload, download
 *
 * Uses the Feishu Drive API:
 *   - list:        GET    /open-apis/drive/v1/files
 *   - get_meta:    POST   /open-apis/drive/v1/metas/batch_query
 *   - copy:        POST   /open-apis/drive/v1/files/:file_token/copy
 *   - move:        POST   /open-apis/drive/v1/files/:file_token/move
 *   - delete:      DELETE /open-apis/drive/v1/files/:file_token
 *   - upload:      POST   /open-apis/drive/v1/files/upload_all
 *   - download:    GET    /open-apis/drive/v1/files/:file_token/download
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';
import {
  json,
  createToolContext,
  assertLarkOk,
  handleInvokeErrorWithAutoAuth,
  registerTool,
  StringEnum,
} from '../helpers';
import type { DriveFileListData, DriveFileData, DriveTaskData } from '../sdk-types';
import * as fs from 'fs/promises';
import * as path from 'path';

// 分片上传配置
const SMALL_FILE_THRESHOLD = 15 * 1024 * 1024; // 15MB，小于此大小使用一次上传

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuDriveFileSchema = Type.Union([
  // LIST FILES
  Type.Object({
    action: Type.Literal('list'),
    folder_token: Type.Optional(
      Type.String({
        description:
          '文件夹 token（可选）。不填写或填空字符串时，获取用户云空间根目录下的清单（注意：根目录模式不支持分页和返回快捷方式）',
      }),
    ),
    page_size: Type.Optional(
      Type.Integer({
        description: '分页大小（默认 200，最大 200）',
        minimum: 1,
        maximum: 200,
      }),
    ),
    page_token: Type.Optional(
      Type.String({
        description: '分页标记。首次请求无需填写',
      }),
    ),
    order_by: Type.Optional(
      StringEnum(['EditedTime', 'CreatedTime'], {
        description: '排序方式：EditedTime（编辑时间）、CreatedTime（创建时间）',
      }),
    ),
    direction: Type.Optional(
      StringEnum(['ASC', 'DESC'], {
        description: '排序方向：ASC（升序）、DESC（降序）',
      }),
    ),
  }),

  // GET META
  Type.Object({
    action: Type.Literal('get_meta'),
    request_docs: Type.Array(
      Type.Object({
        doc_token: Type.String({
          description: '文档 token（从浏览器 URL 中获取，如 spreadsheet_token、doc_token 等）',
        }),
        doc_type: Type.Union(
          [
            Type.Literal('doc'),
            Type.Literal('sheet'),
            Type.Literal('file'),
            Type.Literal('bitable'),
            Type.Literal('docx'),
            Type.Literal('folder'),
            Type.Literal('mindnote'),
            Type.Literal('slides'),
          ],
          {
            description: '文档类型：doc、sheet、file、bitable、docx、folder、mindnote、slides',
          },
        ),
      }),
      {
        description:
          "要查询的文档列表（批量查询，最多 50 个）。示例：[{doc_token: 'Z1FjxxxxxxxxxxxxxxxxxxxtnAc', doc_type: 'sheet'}]",
        minItems: 1,
        maxItems: 50,
      },
    ),
  }),

  // COPY FILE
  Type.Object({
    action: Type.Literal('copy'),
    file_token: Type.String({
      description: '文件 token（必填）',
    }),
    name: Type.String({
      description: '目标文件名（必填）',
    }),
    type: Type.Union(
      [
        Type.Literal('doc'),
        Type.Literal('sheet'),
        Type.Literal('file'),
        Type.Literal('bitable'),
        Type.Literal('docx'),
        Type.Literal('folder'),
        Type.Literal('mindnote'),
        Type.Literal('slides'),
      ],
      {
        description: '文档类型（必填）',
      },
    ),
    folder_token: Type.Optional(
      Type.String({
        description: '目标文件夹 token。不传则复制到「我的空间」根目录',
      }),
    ),
    parent_node: Type.Optional(
      Type.String({
        description: '【folder_token 的别名】目标文件夹 token（为兼容性保留，建议使用 folder_token）',
      }),
    ),
  }),

  // MOVE FILE
  Type.Object({
    action: Type.Literal('move'),
    file_token: Type.String({
      description: '文件 token（必填）',
    }),
    type: Type.Union(
      [
        Type.Literal('doc'),
        Type.Literal('sheet'),
        Type.Literal('file'),
        Type.Literal('bitable'),
        Type.Literal('docx'),
        Type.Literal('folder'),
        Type.Literal('mindnote'),
        Type.Literal('slides'),
      ],
      {
        description: '文档类型（必填）',
      },
    ),
    folder_token: Type.String({
      description: '目标文件夹 token（必填）',
    }),
  }),

  // DELETE FILE
  Type.Object({
    action: Type.Literal('delete'),
    file_token: Type.String({
      description: '文件 token（必填）',
    }),
    type: Type.Union(
      [
        Type.Literal('doc'),
        Type.Literal('sheet'),
        Type.Literal('file'),
        Type.Literal('bitable'),
        Type.Literal('docx'),
        Type.Literal('folder'),
        Type.Literal('mindnote'),
        Type.Literal('slides'),
      ],
      {
        description: '文档类型（必填）',
      },
    ),
  }),

  // UPLOAD FILE
  Type.Object({
    action: Type.Literal('upload'),
    parent_node: Type.Optional(
      Type.String({
        description:
          '父节点 token（可选）。explorer 类型填文件夹 token，bitable 类型填 app_token。不填写或填空字符串时，上传到云空间根目录',
      }),
    ),
    file_path: Type.Optional(
      Type.String({
        description:
          '本地文件路径（与 file_content_base64 二选一）。优先使用此参数，会自动读取文件内容、计算大小、提取文件名。',
      }),
    ),
    file_content_base64: Type.Optional(
      Type.String({
        description: '文件内容的 Base64 编码（与 file_path 二选一）。当不提供 file_path 时使用。',
      }),
    ),
    file_name: Type.Optional(
      Type.String({
        description:
          '文件名（可选）。如果提供了 file_path，会自动从路径中提取文件名；如果使用 file_content_base64，则必须提供此参数。',
      }),
    ),
    size: Type.Optional(
      Type.Integer({
        description:
          '文件大小（字节，可选）。如果提供了 file_path，会自动计算；如果使用 file_content_base64，则必须提供此参数。',
      }),
    ),
  }),

  // DOWNLOAD FILE
  Type.Object({
    action: Type.Literal('download'),
    file_token: Type.String({
      description: '文件 token（必填）',
    }),
    output_path: Type.Optional(
      Type.String({
        description:
          "本地保存的完整文件路径（可选）。必须包含文件名和扩展名，例如 '/tmp/file.pdf'。如果不提供，则返回 Base64 编码的文件内容。",
      }),
    ),
  }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuDriveFileParams =
  | {
      action: 'list';
      folder_token?: string;
      page_size?: number;
      page_token?: string;
      order_by?: 'EditedTime' | 'CreatedTime';
      direction?: 'ASC' | 'DESC';
    }
  | {
      action: 'get_meta';
      request_docs: Array<{
        doc_token: string;
        doc_type: string;
      }>;
    }
  | {
      action: 'copy';
      file_token: string;
      name: string;
      type: string;
      folder_token?: string;
      parent_node?: string;
    }
  | {
      action: 'move';
      file_token: string;
      type: string;
      folder_token: string;
    }
  | {
      action: 'delete';
      file_token: string;
      type: string;
    }
  | {
      action: 'upload';
      parent_node?: string;
      file_path?: string;
      file_content_base64?: string;
      file_name?: string;
      size?: number;
    }
  | {
      action: 'download';
      file_token: string;
      output_path?: string;
    };

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFeishuDriveFileTool(api: OpenClawPluginApi) {
  if (!api.config) return;
  const cfg = api.config;

  const { toolClient, log } = createToolContext(api, 'feishu_drive_file');

  registerTool(
    api,
    {
      name: 'feishu_drive_file',
      label: 'Feishu Drive Files',
      description:
        '【以用户身份】飞书云空间文件管理工具。当用户要求查看云空间(云盘)中的文件列表、获取文件信息、复制/移动/删除文件、上传/下载文件时使用。消息中的文件读写**禁止**使用该工具!' +
        '\n\nActions:' +
        '\n- list（列出文件）：列出文件夹下的文件。不提供 folder_token 时获取根目录清单' +
        "\n- get_meta（批量获取元数据）：批量查询文档元信息，使用 request_docs 数组参数，格式：[{doc_token: '...', doc_type: 'sheet'}]" +
        '\n- copy（复制文件）：复制文件到指定位置' +
        '\n- move（移动文件）：移动文件到指定文件夹' +
        '\n- delete（删除文件）：删除文件' +
        '\n- upload（上传文件）：上传本地文件到云空间。提供 file_path（本地文件路径）或 file_content_base64（Base64 编码）' +
        '\n- download（下载文件）：下载文件到本地。提供 output_path（本地保存路径）则保存到本地，否则返回 Base64 编码' +
        '\n\n【重要】copy/move/delete 操作需要 file_token 和 type 参数。get_meta 使用 request_docs 数组参数。' +
        '\n【重要】upload 优先使用 file_path（自动读取文件、提取文件名和大小），也支持 file_content_base64（需手动提供 file_name 和 size）。' +
        '\n【重要】download 提供 output_path 时保存到本地（可以是文件路径或文件夹路径+file_name），不提供则返回 Base64。',
      parameters: FeishuDriveFileSchema,
      async execute(_toolCallId: string, params: unknown) {
        const p = params as FeishuDriveFileParams;
        try {
          const client = toolClient();

          switch (p.action) {
            // -----------------------------------------------------------------
            // LIST FILES
            // -----------------------------------------------------------------
            case 'list': {
              log.info(`list: folder_token=${p.folder_token || '(root)'}, page_size=${p.page_size ?? 200}`);

              const res = await client.invoke(
                'feishu_drive_file.list',
                (sdk, opts) =>
                  sdk.drive.file.list(
                    {
                      params: {
                        folder_token: p.folder_token as any,
                        page_size: p.page_size as any,
                        page_token: p.page_token,
                        order_by: p.order_by as any,
                        direction: p.direction as any,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`list: returned ${res.data?.files?.length ?? 0} files`);

              const data = res.data as DriveFileListData | undefined;
              return json({
                files: data?.files,
                has_more: data?.has_more,
                page_token: data?.next_page_token,
              });
            }

            // -----------------------------------------------------------------
            // GET META
            // -----------------------------------------------------------------
            case 'get_meta': {
              if (!p.request_docs || !Array.isArray(p.request_docs) || p.request_docs.length === 0) {
                return json({
                  error:
                    "request_docs must be a non-empty array. Correct format: {action: 'get_meta', request_docs: [{doc_token: '...', doc_type: 'sheet'}]}",
                });
              }

              log.info(`get_meta: querying ${p.request_docs.length} documents`);

              const res = await client.invoke(
                'feishu_drive_file.get_meta',
                (sdk, opts) =>
                  sdk.drive.meta.batchQuery(
                    {
                      data: {
                        request_docs: p.request_docs as any,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              log.info(`get_meta: returned ${res.data?.metas?.length ?? 0} metas`);

              return json({
                metas: res.data?.metas ?? [],
              });
            }

            // -----------------------------------------------------------------
            // COPY FILE
            // -----------------------------------------------------------------
            case 'copy': {
              // 兼容处理：parent_node 作为 folder_token 的别名
              const targetFolderToken = p.folder_token || p.parent_node;

              log.info(
                `copy: file_token=${p.file_token}, name=${p.name}, type=${p.type}, folder_token=${targetFolderToken ?? '(root)'}`,
              );

              const res = await client.invoke(
                'feishu_drive_file.copy',
                (sdk, opts) =>
                  sdk.drive.file.copy(
                    {
                      path: { file_token: p.file_token },
                      data: {
                        name: p.name,
                        type: p.type as any,
                        folder_token: targetFolderToken as any,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              const data = res.data as DriveFileData | undefined;
              log.info(`copy: new file_token=${data?.file?.token ?? 'unknown'}`);

              return json({
                file: data?.file,
              });
            }

            // -----------------------------------------------------------------
            // MOVE FILE
            // -----------------------------------------------------------------
            case 'move': {
              log.info(`move: file_token=${p.file_token}, type=${p.type}, folder_token=${p.folder_token}`);

              const res = await client.invoke(
                'feishu_drive_file.move',
                (sdk, opts) =>
                  sdk.drive.file.move(
                    {
                      path: { file_token: p.file_token },
                      data: {
                        type: p.type as any,
                        folder_token: p.folder_token,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              const data = res.data as DriveTaskData | undefined;
              log.info(`move: task_id=${data?.task_id}`);

              return json({
                success: true,
                task_id: data?.task_id,
                file_token: p.file_token,
                target_folder_token: p.folder_token,
              });
            }

            // -----------------------------------------------------------------
            // DELETE FILE
            // -----------------------------------------------------------------
            case 'delete': {
              log.info(`delete: file_token=${p.file_token}, type=${p.type}`);

              const res = await client.invoke(
                'feishu_drive_file.delete',
                (sdk, opts) =>
                  sdk.drive.file.delete(
                    {
                      path: { file_token: p.file_token },
                      params: {
                        type: p.type as any,
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(res);

              const data = res.data as DriveTaskData | undefined;
              log.info(`delete: task_id=${data?.task_id}`);

              return json({
                success: true,
                task_id: data?.task_id,
                file_token: p.file_token,
              });
            }

            // -----------------------------------------------------------------
            // UPLOAD FILE
            // -----------------------------------------------------------------
            case 'upload': {
              let fileBuffer: Buffer;
              let fileName: string;
              let fileSize: number;

              // 优先使用 file_path
              if (p.file_path) {
                log.info(`upload: reading from local file: ${p.file_path}`);

                try {
                  // 读取文件内容
                  fileBuffer = await fs.readFile(p.file_path);

                  // 提取文件名（如果未提供）
                  fileName = p.file_name || path.basename(p.file_path);

                  // 计算文件大小（如果未提供）
                  fileSize = p.size || fileBuffer.length;

                  log.info(`upload: file_name=${fileName}, size=${fileSize}, parent=${p.parent_node || '(root)'}`);
                } catch (err) {
                  return json({
                    error: `failed to read local file: ${err instanceof Error ? err.message : String(err)}`,
                  });
                }
              } else if (p.file_content_base64) {
                // 使用 base64 内容
                if (!p.file_name || !p.size) {
                  return json({
                    error: 'file_name and size are required when using file_content_base64',
                  });
                }

                log.info(
                  `upload: using base64 content, file_name=${p.file_name}, size=${p.size}, parent=${p.parent_node}`,
                );

                // Decode base64 to buffer
                fileBuffer = Buffer.from(p.file_content_base64, 'base64');
                fileName = p.file_name;
                fileSize = p.size;
              } else {
                return json({
                  error: 'either file_path or file_content_base64 is required',
                });
              }

              // 根据文件大小选择上传方式
              if (fileSize <= SMALL_FILE_THRESHOLD) {
                // 小文件：使用一次上传
                log.info(`upload: using upload_all (file size ${fileSize} <= 15MB)`);

                const res: any = await client.invoke(
                  'feishu_drive_file.upload',
                  (sdk, opts) =>
                    sdk.drive.file.uploadAll(
                      {
                        data: {
                          file_name: fileName,
                          parent_type: 'explorer' as any,
                          parent_node: p.parent_node || '',
                          size: fileSize,
                          file: fileBuffer as any,
                        },
                      },
                      opts,
                    ),
                  { as: 'user' },
                );
                assertLarkOk(res);

                log.info(`upload: file_token=${res.data?.file_token}`);

                return json({
                  file_token: res.data?.file_token,
                  file_name: fileName,
                  size: fileSize,
                });
              } else {
                // 大文件：使用分片上传
                log.info(`upload: using chunked upload (file size ${fileSize} > 15MB)`);

                // 1. 预上传
                log.info(`upload: step 1 - prepare upload`);
                const prepareRes: any = await client.invoke(
                  'feishu_drive_file.upload',
                  (sdk, opts) =>
                    sdk.drive.file.uploadPrepare(
                      {
                        data: {
                          file_name: fileName,
                          parent_type: 'explorer' as any,
                          parent_node: p.parent_node || '',
                          size: fileSize,
                        },
                      },
                      opts,
                    ),
                  { as: 'user' },
                );

                log.info(`upload: prepareRes = ${JSON.stringify(prepareRes)}`);

                if (!prepareRes) {
                  return json({ error: 'pre-upload failed: empty response' });
                }

                assertLarkOk(prepareRes);

                const { upload_id, block_size, block_num } = prepareRes.data;
                log.info(`upload: got upload_id=${upload_id}, block_num=${block_num}, block_size=${block_size}`);

                // 2. 上传分片
                log.info(`upload: step 2 - uploading ${block_num} chunks`);
                for (let seq = 0; seq < block_num; seq++) {
                  const start = seq * block_size;
                  const end = Math.min(start + block_size, fileSize);
                  const chunkBuffer = fileBuffer.subarray(start, end);

                  log.info(`upload: uploading chunk ${seq + 1}/${block_num} (${chunkBuffer.length} bytes)`);

                  await client.invoke(
                    'feishu_drive_file.upload',
                    (sdk, opts) =>
                      sdk.drive.file.uploadPart(
                        {
                          data: {
                            upload_id: String(upload_id),
                            seq: Number(seq),
                            size: Number(chunkBuffer.length),
                            file: chunkBuffer,
                          },
                        },
                        opts,
                      ),
                    { as: 'user' },
                  );

                  log.info(`upload: chunk ${seq + 1}/${block_num} uploaded successfully`);
                }

                // 3. 完成上传
                log.info(`upload: step 3 - finish upload`);
                const finishRes: any = await client.invoke(
                  'feishu_drive_file.upload',
                  (sdk, opts) =>
                    sdk.drive.file.uploadFinish(
                      {
                        data: {
                          upload_id,
                          block_num,
                        },
                      },
                      opts,
                    ),
                  { as: 'user' },
                );
                assertLarkOk(finishRes);

                log.info(`upload: file_token=${finishRes.data?.file_token}`);

                return json({
                  file_token: finishRes.data?.file_token,
                  file_name: fileName,
                  size: fileSize,
                  upload_method: 'chunked',
                  chunks_uploaded: block_num,
                });
              }
            }

            // -----------------------------------------------------------------
            // DOWNLOAD FILE
            // -----------------------------------------------------------------
            case 'download': {
              log.info(`download: file_token=${p.file_token}`);

              const res: any = await client.invoke(
                'feishu_drive_file.download',
                (sdk, opts) =>
                  sdk.drive.file.download(
                    {
                      path: { file_token: p.file_token },
                    },
                    opts,
                  ),
                { as: 'user' },
              );

              // File download returns Buffer through getReadableStream
              const stream = res.getReadableStream();
              const chunks: Buffer[] = [];

              for await (const chunk of stream) {
                chunks.push(chunk);
              }

              const fileBuffer = Buffer.concat(chunks);

              log.info(`download: file size=${fileBuffer.length} bytes`);

              // 如果提供了 output_path，保存到本地文件
              if (p.output_path) {
                try {
                  // output_path 必须是完整文件路径
                  // 确保父目录存在
                  await fs.mkdir(path.dirname(p.output_path), { recursive: true });

                  // 写入文件
                  await fs.writeFile(p.output_path, fileBuffer);

                  log.info(`download: saved to ${p.output_path}`);

                  return json({
                    saved_path: p.output_path,
                    size: fileBuffer.length,
                  });
                } catch (err) {
                  return json({
                    error: `failed to save file: ${err instanceof Error ? err.message : String(err)}`,
                  });
                }
              } else {
                // 没有提供 output_path，返回 base64
                const base64Content = fileBuffer.toString('base64');

                return json({
                  file_content_base64: base64Content,
                  size: fileBuffer.length,
                });
              }
            }
          }
        } catch (err) {
          return await handleInvokeErrorWithAutoAuth(err, cfg);
        }
      },
    },
    { name: 'feishu_drive_file' },
  );

}
