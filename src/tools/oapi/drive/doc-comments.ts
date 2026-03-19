/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_doc_comments tool -- 云文档评论管理
 *
 * 支持获取、创建、解决/恢复云文档评论
 * 使用以下 SDK 接口:
 * - sdk.drive.v1.fileComment.list - 获取评论列表
 * - sdk.drive.v1.fileComment.create - 创建全文评论
 * - sdk.drive.v1.fileComment.patch - 解决/恢复评论
 * - sdk.drive.v1.fileCommentReply.list - 获取回复列表
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
import type { CommentReplyListData } from '../sdk-types';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ReplyElementSchema = Type.Object({
  type: StringEnum(['text', 'mention', 'link']),
  text: Type.Optional(Type.String({ description: '文本内容(type=text时必填)' })),
  open_id: Type.Optional(Type.String({ description: '被@用户的open_id(type=mention时必填)' })),
  url: Type.Optional(Type.String({ description: '链接URL(type=link时必填)' })),
});

const DocCommentsSchema = Type.Object({
  action: StringEnum(['list', 'create', 'patch']),
  file_token: Type.String({
    description: '云文档token或wiki节点token(可从文档URL获取)。如果是wiki token，会自动转换为实际文档的obj_token',
  }),
  file_type: StringEnum(
    ['doc', 'docx', 'sheet', 'file', 'slides', 'wiki'],
    {
      description: '文档类型。wiki类型会自动解析为实际文档类型(docx/sheet/bitable等)',
    },
  ),
  // list action参数
  is_whole: Type.Optional(
    Type.Boolean({
      description: '是否只获取全文评论(action=list时可选)',
    }),
  ),
  is_solved: Type.Optional(
    Type.Boolean({
      description: '是否只获取已解决的评论(action=list时可选)',
    }),
  ),
  page_size: Type.Optional(Type.Integer({ description: '分页大小' })),
  page_token: Type.Optional(Type.String({ description: '分页标记' })),
  // create action参数
  elements: Type.Optional(
    Type.Array(ReplyElementSchema, {
      description: '评论内容元素数组(action=create时必填)。' + '支持text(纯文本)、mention(@用户)、link(超链接)三种类型',
    }),
  ),
  // patch action参数
  comment_id: Type.Optional(
    Type.String({
      description: '评论ID(action=patch时必填)',
    }),
  ),
  is_solved_value: Type.Optional(
    Type.Boolean({
      description: '解决状态:true=解决,false=恢复(action=patch时必填)',
    }),
  ),
  user_id_type: Type.Optional(StringEnum(['open_id', 'union_id', 'user_id'])),
});

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

interface ReplyElement {
  type: 'text' | 'mention' | 'link';
  text?: string;
  open_id?: string;
  url?: string;
}

interface DocCommentsParams {
  action: 'list' | 'create' | 'patch';
  file_token: string;
  file_type: 'doc' | 'docx' | 'sheet' | 'file' | 'slides' | 'wiki';
  is_whole?: boolean;
  is_solved?: boolean;
  page_size?: number;
  page_token?: string;
  elements?: ReplyElement[];
  comment_id?: string;
  is_solved_value?: boolean;
  user_id_type?: 'open_id' | 'union_id' | 'user_id';
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function convertElementsToSDKFormat(elements: ReplyElement[]) {
  return elements.map((el) => {
    if (el.type === 'text') {
      return {
        type: 'text_run',
        text_run: { text: el.text! },
      };
    } else if (el.type === 'mention') {
      return {
        type: 'person',
        person: { user_id: el.open_id! },
      };
    } else if (el.type === 'link') {
      return {
        type: 'docs_link',
        docs_link: { url: el.url! },
      };
    }
    return { type: 'text_run', text_run: { text: '' } };
  });
}

/**
 * 组装评论和回复数据
 * 获取评论列表API会返回部分回复,但可能不完整
 * 此函数会为每个评论获取完整的回复列表
 */
async function assembleCommentsWithReplies(
  client: any,
  file_token: string,
  file_type: string,
  comments: any[],
  user_id_type: string,
  log: any,
) {
  const result = [];

  for (const comment of comments) {
    const assembled: any = { ...comment };

    // 如果评论有回复,获取完整的回复列表
    if (comment.reply_list?.replies?.length > 0 || comment.has_more) {
      try {
        const replies = [];
        let pageToken: string | undefined = undefined;
        let hasMore = true;

        while (hasMore) {
          const replyRes = await client.invoke(
            'drive.v1.fileCommentReply.list',
            (sdk: any, opts: any) =>
              sdk.drive.v1.fileCommentReply.list(
                {
                  path: {
                    file_token,
                    comment_id: comment.comment_id,
                  },
                  params: {
                    file_type,
                    page_token: pageToken,
                    page_size: 50,
                    user_id_type,
                  },
                },
                opts,
              ),
            { as: 'user' },
          );

          const replyData = replyRes.data as CommentReplyListData | undefined;
          if ((replyRes as any).code === 0 && replyData?.items) {
            replies.push(...(replyData.items || []));
            hasMore = replyData.has_more || false;
            pageToken = replyData.page_token;
          } else {
            break;
          }
        }

        assembled.reply_list = { replies };
        log.info(`Assembled ${replies.length} replies for comment ${comment.comment_id}`);
      } catch (err) {
        log.warn(`Failed to fetch replies for comment ${comment.comment_id}: ${err}`);
        // 保留原始回复数据
      }
    }

    result.push(assembled);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerDocCommentsTool(api: OpenClawPluginApi): boolean {
  if (!api.config) return false;
  const cfg = api.config;

  const { toolClient, log } = createToolContext(api, 'feishu_doc_comments');

  return registerTool(
    api,
    {
      name: 'feishu_doc_comments',
      label: 'Feishu: Doc Comments',
      description:
        '【以用户身份】管理云文档评论。支持: ' +
        '(1) list - 获取评论列表(含完整回复); ' +
        '(2) create - 添加全文评论(支持文本、@用户、超链接); ' +
        '(3) patch - 解决/恢复评论。' +
        '支持 wiki token。',
      parameters: DocCommentsSchema,
      async execute(_toolCallId: string, params: unknown) {
        const p = params as DocCommentsParams;
        try {
          const client = toolClient();
          const userIdType = p.user_id_type || 'open_id';

          // 如果是 wiki token，先转换为实际的 obj_token 和 obj_type
          let actualFileToken = p.file_token;
          let actualFileType = p.file_type;

          if (p.file_type === 'wiki') {
            log.info(`doc_comments: detected wiki token="${p.file_token}", converting to obj_token...`);

            try {
              const wikiNodeRes = await client.invoke(
                'feishu_wiki_space_node.get',
                (sdk: any, opts: any) =>
                  sdk.wiki.space.getNode(
                    {
                      params: {
                        token: p.file_token,
                        obj_type: 'wiki',
                      },
                    },
                    opts,
                  ),
                { as: 'user' },
              );
              assertLarkOk(wikiNodeRes as any);

              const node = (wikiNodeRes as any).data?.node;
              if (!node || !node.obj_token || !node.obj_type) {
                return json({
                  error: `failed to resolve wiki token "${p.file_token}" to document object (may be a folder node rather than a document)`,
                  wiki_node: node,
                });
              }

              actualFileToken = node.obj_token;
              actualFileType = node.obj_type;

              log.info(
                `doc_comments: wiki token converted: obj_token="${actualFileToken}", obj_type="${actualFileType}"`,
              );
            } catch (err) {
              log.error(`doc_comments: failed to convert wiki token: ${err}`);
              return json({
                error: `failed to resolve wiki token "${p.file_token}": ${err}`,
              });
            }
          }

          // Action: list - 获取评论列表
          if (p.action === 'list') {
            log.info(`doc_comments.list: file_token="${actualFileToken}", file_type=${actualFileType}`);

            const res = await client.invoke(
              'feishu_doc_comments.list',
              (sdk: any, opts: any) =>
                sdk.drive.v1.fileComment.list(
                  {
                    path: { file_token: actualFileToken },
                    params: {
                      file_type: actualFileType,
                      is_whole: p.is_whole,
                      is_solved: p.is_solved,
                      page_size: p.page_size || 50,
                      page_token: p.page_token,
                      user_id_type: userIdType,
                    },
                  },
                  opts,
                ),
              { as: 'user' },
            );
            assertLarkOk(res as any);

            const items = ((res as any).data as any)?.items || [];
            log.info(`doc_comments.list: found ${items.length} comments`);

            // 组装评论和完整回复
            const assembledItems = await assembleCommentsWithReplies(
              client,
              actualFileToken,
              actualFileType,
              items,
              userIdType,
              log,
            );

            return json({
              items: assembledItems,
              has_more: ((res as any).data as any)?.has_more ?? false,
              page_token: ((res as any).data as any)?.page_token,
            });
          }

          // Action: create - 创建评论
          if (p.action === 'create') {
            if (!p.elements || p.elements.length === 0) {
              return json({
                error: 'elements 参数必填且不能为空',
              });
            }

            log.info(`doc_comments.create: file_token="${actualFileToken}", elements=${p.elements.length}`);

            const sdkElements = convertElementsToSDKFormat(p.elements);

            const res = await client.invoke(
              'feishu_doc_comments.create',
              (sdk: any, opts: any) =>
                sdk.drive.v1.fileComment.create(
                  {
                    path: { file_token: actualFileToken },
                    params: {
                      file_type: actualFileType,
                      user_id_type: userIdType,
                    },
                    data: {
                      reply_list: {
                        replies: [
                          {
                            content: {
                              elements: sdkElements,
                            },
                          },
                        ],
                      },
                    },
                  },
                  opts,
                ),
              { as: 'user' },
            );
            assertLarkOk(res as any);

            log.info(`doc_comments.create: created comment ${((res as any).data as any)?.comment_id}`);

            return json((res as any).data);
          }

          // Action: patch - 解决/恢复评论
          if (p.action === 'patch') {
            if (!p.comment_id) {
              return json({
                error: 'comment_id 参数必填',
              });
            }
            if (p.is_solved_value === undefined) {
              return json({
                error: 'is_solved_value 参数必填',
              });
            }

            log.info(`doc_comments.patch: comment_id="${p.comment_id}", is_solved=${p.is_solved_value}`);

            const res = await client.invoke(
              'feishu_doc_comments.patch',
              (sdk: any, opts: any) =>
                sdk.drive.v1.fileComment.patch(
                  {
                    path: {
                      file_token: actualFileToken,
                      comment_id: p.comment_id!,
                    },
                    params: {
                      file_type: actualFileType,
                    },
                    data: {
                      is_solved: p.is_solved_value!,
                    },
                  },
                  opts,
                ),
              { as: 'user' },
            );
            assertLarkOk(res as any);

            log.info(`doc_comments.patch: success`);

            return json({ success: true });
          }

          return json({
            error: `未知的 action: ${p.action}`,
          });
        } catch (err) {
          return await handleInvokeErrorWithAutoAuth(err, cfg);
        }
      },
    },
    { name: 'feishu_doc_comments' },
  );
}
