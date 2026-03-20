/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_im_user_message tool -- 以用户身份发送/回复 IM 消息
 *
 * Actions: send, reply
 *
 * Uses the Feishu IM API:
 *   - send:  POST /open-apis/im/v1/messages?receive_id_type=...
 *   - reply: POST /open-apis/im/v1/messages/:message_id/reply
 *
 * 全部以用户身份（user_access_token）调用，scope 来自 real-scope.json。
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';
import { json, createToolContext, assertLarkOk, handleInvokeErrorWithAutoAuth, registerTool, StringEnum } from '../helpers';
import type { ToolClient } from '../../../core/tool-client';
import type { ProxyBotMetadata } from '../../../messaging/proxy-bot';
import {
  rememberProxyMessageMetadata,
  resolveCurrentBotMetadata,
  shouldProxyBotMention,
} from '../../../messaging/proxy-bot';
import { getMessageFeishu } from '../../../messaging/shared/message-lookup';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const PROXY_MARKER_EMOJI_TYPE = 'Loudspeaker';

const FeishuImMessageSchema = Type.Union([
  // SEND
  Type.Object({
    action: Type.Literal('send'),
    receive_id_type: StringEnum(['open_id', 'chat_id'], {
      description: '接收者 ID 类型：open_id（私聊，ou_xxx）、chat_id（群聊，oc_xxx）',
    }),
    receive_id: Type.String({
      description: "接收者 ID，与 receive_id_type 对应。open_id 填 'ou_xxx'，chat_id 填 'oc_xxx'",
    }),
    msg_type: StringEnum(
      ['text', 'post', 'image', 'file', 'audio', 'media', 'interactive', 'share_chat', 'share_user'],
      {
        description:
          '消息类型：text（纯文本）、post（富文本）、image（图片）、file（文件）、interactive（消息卡片）、share_chat（群名片）、share_user（个人名片）等',
      },
    ),
    content: Type.String({
      description:
        '消息内容（JSON 字符串），格式取决于 msg_type。' +
        '示例：text → \'{"text":"你好"}\'，' +
        'image → \'{"image_key":"img_xxx"}\'，' +
        'share_chat → \'{"chat_id":"oc_xxx"}\'，' +
        'post → \'{"zh_cn":{"title":"标题","content":[[{"tag":"text","text":"正文"}]]}}\'',
    }),
    uuid: Type.Optional(
      Type.String({
        description: '幂等唯一标识。同一 uuid 在 1 小时内只会发送一条消息，用于去重',
      }),
    ),
  }),

  // REPLY
  Type.Object({
    action: Type.Literal('reply'),
    message_id: Type.String({
      description: '被回复消息的 ID（om_xxx 格式）',
    }),
    msg_type: StringEnum(
      ['text', 'post', 'image', 'file', 'audio', 'media', 'interactive', 'share_chat', 'share_user'],
      {
        description: '消息类型：text（纯文本）、post（富文本）、image（图片）、interactive（消息卡片）等',
      },
    ),
    content: Type.String({
      description: '回复消息内容（JSON 字符串），格式同 send 的 content',
    }),
    reply_in_thread: Type.Optional(
      Type.Boolean({
        description: '是否以话题形式回复。true 则消息出现在该消息的话题中，false（默认）则出现在聊天主流',
      }),
    ),
    uuid: Type.Optional(
      Type.String({
        description: '幂等唯一标识',
      }),
    ),
  }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuImMessageParams =
  | {
      action: 'send';
      receive_id_type: 'open_id' | 'chat_id';
      receive_id: string;
      msg_type: string;
      content: string;
      uuid?: string;
    }
  | {
      action: 'reply';
      message_id: string;
      msg_type: string;
      content: string;
      reply_in_thread?: boolean;
      uuid?: string;
    };

const INLINE_MENTION_RE = /<at\s+(?:user_id|open_id|id)\s*=\s*"?([^">\s]+)"?\s*>/giu;

function extractInlineMentionOpenIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(INLINE_MENTION_RE)) {
    const openId = match[1]?.trim();
    if (!openId || openId === 'all') continue;
    ids.add(openId);
  }
  return [...ids];
}

function collectMentionOpenIdsFromUnknown(value: unknown, ids: Set<string>): void {
  if (typeof value === 'string') {
    for (const openId of extractInlineMentionOpenIds(value)) ids.add(openId);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMentionOpenIdsFromUnknown(item, ids);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  if (record.tag === 'at' && typeof record.user_id === 'string' && record.user_id !== 'all') {
    ids.add(record.user_id);
  }
  for (const nested of Object.values(record)) {
    collectMentionOpenIdsFromUnknown(nested, ids);
  }
}

function collectMentionOpenIdsFromToolMessage(msgType: string, content: string): string[] {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const ids = new Set<string>();

    if (msgType === 'text' && typeof parsed.text === 'string') {
      for (const openId of extractInlineMentionOpenIds(parsed.text)) ids.add(openId);
      return [...ids];
    }

    collectMentionOpenIdsFromUnknown(parsed, ids);
    return [...ids];
  } catch {
    return [];
  }
}

function prependImplicitTextMention(text: string, openId: string): string {
  if (extractInlineMentionOpenIds(text).includes(openId)) return text;
  return `<at user_id="${openId}"></at> ${text}`;
}

function buildImplicitPostMentionRow(openId: string, name?: string): Array<Record<string, string>> {
  return [
    { tag: 'at', user_id: openId, user_name: name ?? openId },
    { tag: 'text', text: ' ' },
  ];
}

function normalizeInteractiveAtMentions(text: string): string {
  let normalized = text.replace(
    /<at\s+(?:id|open_id|user_id)\s*=\s*"?([^">\s]+)"?\s*>[\s\S]*?<\/at>/giu,
    '<at id="$1"></at>',
  );
  normalized = normalized.replace(/<at\s+(?:id|open_id|user_id)\s*=\s*"?([^">\s]+)"?\s*>/giu, '<at id="$1"></at>');
  return normalized;
}

function isInteractiveTextCarrier(parent: Record<string, unknown> | undefined, key: string | undefined): boolean {
  if (!key) return false;
  if (key === 'content') {
    const tag = typeof parent?.tag === 'string' ? parent.tag : '';
    if (!tag) return true;
    return ['lark_md', 'markdown', 'markdown_v1', 'plain_text', 'text', 'div', 'note'].includes(tag);
  }
  return key === 'text';
}

function resolveInteractiveTransformTarget(
  parsed: Record<string, unknown>,
): unknown {
  if (typeof parsed.card === 'string') {
    try {
      return JSON.parse(parsed.card) as unknown;
    } catch {
      // fall through to root content
    }
  }

  if (typeof parsed.json_card === 'string') {
    try {
      return JSON.parse(parsed.json_card) as unknown;
    } catch {
      // fall through to root content
    }
  }

  return parsed;
}

function transformToolMessageContent(params: {
  msgType: string;
  content: string;
  implicitMentionOpenId?: string;
  implicitMentionName?: string;
}): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(params.content) as Record<string, unknown>;
  } catch {
    return params.content;
  }

  if (params.msgType === 'text' && typeof parsed.text === 'string') {
    let text = parsed.text;
    if (params.implicitMentionOpenId) {
      text = prependImplicitTextMention(text, params.implicitMentionOpenId);
    }
    parsed.text = text;
    return JSON.stringify(parsed);
  }

  if (params.msgType === 'post') {
    for (const localeValue of Object.values(parsed)) {
      if (!localeValue || typeof localeValue !== 'object') continue;
      const localeRecord = localeValue as Record<string, unknown>;
      const contentRows = localeRecord.content;
      if (!Array.isArray(contentRows)) continue;

      if (params.implicitMentionOpenId) {
        const alreadyMentioned = extractInlineMentionOpenIds(JSON.stringify(contentRows)).includes(
          params.implicitMentionOpenId,
        );
        if (!alreadyMentioned) {
          contentRows.unshift(buildImplicitPostMentionRow(params.implicitMentionOpenId, params.implicitMentionName));
        }
      }
    }
    return JSON.stringify(parsed);
  }

  if (params.msgType === 'interactive') {
    const target = resolveInteractiveTransformTarget(parsed);
    const hasImplicitMention = Boolean(
      params.implicitMentionOpenId && extractInlineMentionOpenIds(JSON.stringify(target)).includes(params.implicitMentionOpenId),
    );

    let injectImplicitMention = Boolean(params.implicitMentionOpenId && !hasImplicitMention);
    let changed = false;

    const visit = (
      value: unknown,
      parent?: Record<string, unknown>,
      key?: string,
    ): unknown => {
      if (typeof value === 'string') {
        let text = normalizeInteractiveAtMentions(value);
        const textCarrier = isInteractiveTextCarrier(parent, key);

        if (textCarrier && injectImplicitMention && params.implicitMentionOpenId) {
          text = `<at id="${params.implicitMentionOpenId}"></at> ${text}`;
          injectImplicitMention = false;
        }

        if (text !== value) changed = true;
        return text;
      }

      if (Array.isArray(value)) {
        let arrayChanged = false;
        const next = value.map((item) => {
          const visited = visit(item);
          if (visited !== item) arrayChanged = true;
          return visited;
        });
        if (arrayChanged) changed = true;
        return next;
      }

      if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        let recordChanged = false;
        const nextEntries = Object.entries(record).map(([nestedKey, nestedValue]) => {
          const visited = visit(nestedValue, record, nestedKey);
          if (visited !== nestedValue) recordChanged = true;
          return [nestedKey, visited] as const;
        });

        if (!recordChanged) return value;
        changed = true;
        return Object.fromEntries(nextEntries);
      }

      return value;
    };

    const nextTarget = visit(target);
    if (nextTarget !== target) {
      if (typeof parsed.card === 'string') {
        parsed.card = JSON.stringify(nextTarget);
      } else if (typeof parsed.json_card === 'string') {
        parsed.json_card = JSON.stringify(nextTarget);
      } else {
        Object.assign(parsed, nextTarget as Record<string, unknown>);
      }
    }

    if (!changed) return params.content;
    return JSON.stringify(parsed);
  }

  return params.content;
}

async function maybeApplyBotProxyProtocol(params: {
  cfg: NonNullable<OpenClawPluginApi['config']>;
  client: ToolClient;
  log: { info: (message: string) => void };
  payload: FeishuImMessageParams;
}): Promise<{ payload: FeishuImMessageParams; proxied: boolean; botMeta?: ProxyBotMetadata }> {
  const { cfg, client, log, payload } = params;
  const botMeta = await resolveCurrentBotMetadata(client.account);
  if (!botMeta?.openId) return { payload, proxied: false, botMeta: undefined };

  let targetChatId: string | undefined;
  let implicitMentionOpenId: string | undefined;
  let implicitMentionName: string | undefined;

  if (payload.action === 'send' && payload.receive_id_type === 'chat_id') {
    targetChatId = payload.receive_id;
  }

  if (payload.action === 'reply') {
    const quotedMsg = await getMessageFeishu({
      cfg,
      messageId: payload.message_id,
      accountId: client.account.accountId,
      expandForward: true,
    });
    targetChatId = quotedMsg?.chatId;
    if (quotedMsg?.proxyFromBotOpenId) {
      implicitMentionOpenId = quotedMsg.proxyFromBotOpenId;
      implicitMentionName = quotedMsg.proxyFromBotName;
    }
  }

  let mentionOpenIds = collectMentionOpenIdsFromToolMessage(payload.msg_type, payload.content);
  if (implicitMentionOpenId && !mentionOpenIds.includes(implicitMentionOpenId)) {
    mentionOpenIds = [...mentionOpenIds, implicitMentionOpenId];
  }

  if (!targetChatId || mentionOpenIds.length === 0) return { payload, proxied: false, botMeta: undefined };

  const shouldAppendHeader = await shouldProxyBotMention({
    cfg,
    to: targetChatId,
    accountId: client.account.accountId,
    mentionOpenIds,
  });
  if (!shouldAppendHeader) return { payload, proxied: false, botMeta: undefined };

  const content = transformToolMessageContent({
    msgType: payload.msg_type,
    content: payload.content,
    implicitMentionOpenId,
    implicitMentionName,
  });

  log.info(`proxy send enabled: action=${payload.action}, msg_type=${payload.msg_type}, accountId=${client.account.accountId}, targetChatId=${targetChatId}`);

  if (content === payload.content) {
    return { payload, proxied: true, botMeta };
  }

  return { payload: { ...payload, content }, proxied: true, botMeta };
}

async function addProxyMarkerReaction(params: {
  client: ToolClient;
  log: { debug?: (message: string) => void };
  messageId?: string;
  botMeta?: ProxyBotMetadata;
}): Promise<void> {
  const messageId = params.messageId?.trim();
  if (!messageId) return;
  if (params.botMeta?.openId) {
    rememberProxyMessageMetadata(messageId, params.botMeta);
  }

  try {
    await params.client.sdk.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: PROXY_MARKER_EMOJI_TYPE } },
    });
  } catch (err) {
    params.log.debug?.(`failed to add proxy marker reaction: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFeishuImUserMessageTool(api: OpenClawPluginApi): void {
  if (!api.config) return;
  const cfg = api.config;
  const { toolClient, log } = createToolContext(api, 'feishu_im_user_message');

  registerTool(
    api,
    {
      name: 'feishu_im_user_message',
      label: 'Feishu: IM User Message',
      description:
        '飞书用户身份 IM 消息工具。**有且仅当用户明确要求以自己身份发消息、回复消息时使用，当没有明确要求时优先使用message系统工具**。' +
        '\n\nActions:' +
        '\n- send（发送消息）：发送消息到私聊或群聊。私聊用 receive_id_type=open_id，群聊用 receive_id_type=chat_id' +
        '\n- reply（回复消息）：回复指定 message_id 的消息，支持话题回复（reply_in_thread=true）' +
        '\n\n【重要】content 必须是合法 JSON 字符串，格式取决于 msg_type。' +
        '最常用：text 类型 content 为 \'{"text":"消息内容"}\'。' +
        '\n\n【安全约束】此工具以用户身份发送消息，发出后对方看到的发送者是用户本人。' +
        '调用前必须先向用户确认：1) 发送对象（哪个人或哪个群）2) 消息内容。' +
        '禁止在用户未明确同意的情况下自行发送消息。',
      parameters: FeishuImMessageSchema,
      async execute(_toolCallId: string, params: unknown) {
        let p = params as FeishuImMessageParams;
        let proxied = false;
        let proxyBotMeta: ProxyBotMetadata | undefined;
        try {
          const client = toolClient();
          const proxyResult = await maybeApplyBotProxyProtocol({
            cfg,
            client,
            log,
            payload: p,
          });
          p = proxyResult.payload;
          proxied = proxyResult.proxied;
          proxyBotMeta = proxyResult.botMeta;

          if (p.action === 'send') {
            const sendPayload = p;
            // -----------------------------------------------------------------
            // SEND MESSAGE
            // -----------------------------------------------------------------
            log.info(
              `send: receive_id_type=${sendPayload.receive_id_type}, receive_id=${sendPayload.receive_id}, msg_type=${sendPayload.msg_type}`,
            );

            const res = await client.invoke(
              'feishu_im_user_message.send',
              (sdk, opts) =>
                sdk.im.v1.message.create(
                  {
                    params: { receive_id_type: sendPayload.receive_id_type },
                    data: {
                      receive_id: sendPayload.receive_id,
                      msg_type: sendPayload.msg_type,
                      content: sendPayload.content,
                      uuid: sendPayload.uuid,
                    },
                  },
                  opts,
                ),
              {
                as: 'user',
              },
            );
            assertLarkOk(res);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const data = res.data as any;
            log.info(`send: message sent, message_id=${data?.message_id}`);
            if (proxied) {
              await addProxyMarkerReaction({
                client,
                log,
                messageId: data?.message_id,
                botMeta: proxyBotMeta,
              });
            }

            return json({
              message_id: data?.message_id,
              chat_id: data?.chat_id,
              create_time: data?.create_time,
            });
          }

          if (p.action === 'reply') {
            const replyPayload = p;
            // -----------------------------------------------------------------
            // REPLY MESSAGE
            // -----------------------------------------------------------------
            log.info(
              `reply: message_id=${replyPayload.message_id}, msg_type=${replyPayload.msg_type}, reply_in_thread=${replyPayload.reply_in_thread ?? false}`,
            );

            const res = await client.invoke(
              'feishu_im_user_message.reply',
              (sdk, opts) =>
                sdk.im.v1.message.reply(
                  {
                    path: { message_id: replyPayload.message_id },
                    data: {
                      content: replyPayload.content,
                      msg_type: replyPayload.msg_type,
                      reply_in_thread: replyPayload.reply_in_thread,
                      uuid: replyPayload.uuid,
                    },
                  },
                  opts,
                ),
              {
                as: 'user',
              },
            );
            assertLarkOk(res);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const data = res.data as any;
            log.info(`reply: message sent, message_id=${data?.message_id}`);
            if (proxied) {
              await addProxyMarkerReaction({
                client,
                log,
                messageId: data?.message_id,
                botMeta: proxyBotMeta,
              });
            }

            return json({
              message_id: data?.message_id,
              chat_id: data?.chat_id,
              create_time: data?.create_time,
            });
          }

          return json({ error: `unsupported action: ${(p as { action?: string }).action ?? 'unknown'}` });
        } catch (err) {
          return await handleInvokeErrorWithAutoAuth(err, cfg);
        }
      },
    },
    { name: 'feishu_im_user_message' },
  );
}
