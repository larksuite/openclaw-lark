/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Proxy-send helpers for bot-to-bot mentions.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import * as Lark from '@larksuiteoapi/node-sdk';
import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import type { FeishuSendResult, MentionInfo } from './types';
import type { ConfiguredLarkAccount } from '../core/types';
import { getLarkAccount, getEnabledLarkAccounts } from '../core/accounts';
import { getAppOwnerFallback } from '../core/app-owner-fallback';
import { LARK_ERROR, NeedAuthorizationError } from '../core/auth-errors';
import { pollDeviceToken, requestDeviceAuthorization } from '../core/device-flow';
import { larkLogger } from '../core/lark-logger';
import { LarkClient } from '../core/lark-client';
import { getTicket } from '../core/lark-ticket';
import { normalizeFeishuTarget, normalizeMessageId, resolveReceiveIdType } from '../core/targets';
import { getStoredToken, setStoredToken, tokenStatus } from '../core/token-store';
import { callWithUAT } from '../core/uat-client';
import { optimizeMarkdownStyle } from '../card/markdown-style';
import { buildMentionedMessage } from './inbound/mention';
import { listChatMembersFeishu } from './outbound/chat-manage';
import { buildAuthCard } from '../tools/oauth-cards';

const log = larkLogger('messaging/proxy-bot');

const PROXY_HEADER_PREFIX = 'Bot2Bot-Proxy';
const PROXY_AUTH_SCOPES = ['offline_access', 'im:message', 'im:message.send_as_user'] as const;
const BOT_ID_CACHE_TTL_MS = 5 * 60 * 1000;
const CHAT_MEMBER_CACHE_TTL_MS = 60 * 1000;
const AUTH_PROMPT_COOLDOWN_MS = 60 * 1000;
const INLINE_MENTION_RE = /<at\s+(?:user_id|open_id|id)\s*=\s*"?([^">\s]+)"?\s*>/giu;

interface CachedOpenIds {
  expireAt: number;
  ids: Set<string>;
}

const knownBotIdsCache = new Map<string, CachedOpenIds>();
const humanMembersCache = new Map<string, CachedOpenIds>();
const authPromptCooldowns = new Map<string, number>();
const pendingOwnerAuthFlows = new Set<string>();
const proxyReplyContextStore = new AsyncLocalStorage<{ mentions: MentionInfo[] }>();

export interface ProxyBotMetadata {
  openId: string;
  name?: string;
}

export class ProxySendPausedError extends Error {
  readonly ownerOpenId: string;

  constructor(ownerOpenId: string) {
    super('Proxy send paused until App Owner authorizes send_as_user.');
    this.name = 'ProxySendPausedError';
    this.ownerOpenId = ownerOpenId;
  }
}

function jsonStringValue(value: string): string {
  return JSON.stringify(value);
}

function normalizeAtMentions(text: string): string {
  return text.replace(/<at\s+(?:id|open_id|user_id)\s*=\s*"?([^">\s]+)"?\s*>/gi, '<at user_id="$1">');
}

function dedupeMentions(mentions: MentionInfo[]): MentionInfo[] {
  const merged = new Map<string, MentionInfo>();
  for (const mention of mentions) {
    if (!mention.openId || mention.openId === 'all') continue;
    merged.set(mention.openId, mention);
  }
  return [...merged.values()];
}

export function withImplicitProxyMentions<T>(mentions: MentionInfo[], fn: () => T | Promise<T>): T | Promise<T> {
  return proxyReplyContextStore.run({ mentions: dedupeMentions(mentions) }, fn);
}

export function getImplicitProxyMentions(): MentionInfo[] {
  return [...(proxyReplyContextStore.getStore()?.mentions ?? [])];
}

export function resolveEffectiveMentions(mentions?: MentionInfo[]): MentionInfo[] {
  return dedupeMentions([...(mentions ?? []), ...getImplicitProxyMentions()]);
}

export function buildMentionTargetsFromOpenIds(openIds: string[], mentions?: MentionInfo[]): MentionInfo[] {
  const existing = new Map(resolveEffectiveMentions(mentions).map((mention) => [mention.openId, mention]));
  return dedupeMentions(
    openIds
      .filter((openId) => openId && openId !== 'all')
      .map((openId, index) =>
        existing.get(openId) ?? {
          key: `proxy-mention-${index}`,
          openId,
          name: openId,
          isBot: true,
        },
      ),
  );
}

function jsonBlock(value: Record<string, unknown>): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function truncateForProxy(text: string, maxLength = 4000): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

export function buildProxyBotHeader(meta: ProxyBotMetadata): string {
  const trimmedName = meta.name?.trim();
  const namePart = trimmedName ? ` name=${jsonStringValue(trimmedName)}` : '';
  return `—— ${PROXY_HEADER_PREFIX}: from_bot=${meta.openId}${namePart}`;
}

export function parseProxyBotHeader(text: string): { metadata?: ProxyBotMetadata; text: string } {
  if (!text.trim()) return { text };

  const lines = text.split(/\r?\n/u);
  const candidates = [
    { index: 0, line: lines[0] ?? '' },
    { index: lines.length - 1, line: lines[lines.length - 1] ?? '' },
  ];
  const headerRe =
    /^(?:\[(?:OpenClaw-Proxy|Bot2Bot-Proxy):\s+from_bot=([^\s\]]+)(?:\s+name=("(?:\\.|[^"\\])*"))?\]|——\s+Bot2Bot-Proxy:\s+from_bot=([^\s]+)(?:\s+name=("(?:\\.|[^"\\])*"))?)$/u;

  let matchedIndex = -1;
  let match: RegExpMatchArray | null = null;
  for (const candidate of candidates) {
    match = candidate.line.match(headerRe);
    if (match) {
      matchedIndex = candidate.index;
      break;
    }
  }
  if (!match || matchedIndex < 0) return { text };

  let name: string | undefined;
  const rawName = match[2] ?? match[4];
  if (rawName) {
    try {
      name = JSON.parse(rawName) as string;
    } catch {
      name = undefined;
    }
  }

  return {
    metadata: {
      openId: match[1] ?? match[3],
      name,
    },
    text: lines
      .filter((_, index) => index !== matchedIndex)
      .join('\n')
      .trim(),
  };
}

function appendProxyHeader(text: string, meta: ProxyBotMetadata): string {
  return `${text}\n${buildProxyBotHeader(meta)}`;
}

function extractInlineMentionOpenIds(text: string): string[] {
  const result = new Set<string>();
  for (const match of text.matchAll(INLINE_MENTION_RE)) {
    const openId = match[1]?.trim();
    if (!openId || openId === 'all') continue;
    result.add(openId);
  }
  return [...result];
}

function collectMentionOpenIds(params: {
  text?: string;
  mentions?: MentionInfo[];
  i18nTexts?: Record<string, string>;
}): string[] {
  const ids = new Set<string>();

  for (const mention of resolveEffectiveMentions(params.mentions)) {
    if (mention.openId && mention.openId !== 'all') ids.add(mention.openId);
  }

  if (params.text) {
    for (const openId of extractInlineMentionOpenIds(params.text)) ids.add(openId);
  }

  for (const localeText of Object.values(params.i18nTexts ?? {})) {
    for (const openId of extractInlineMentionOpenIds(localeText)) ids.add(openId);
  }

  return [...ids];
}

function collectInlineMentionOpenIdsFromUnknown(value: unknown, ids: Set<string>): void {
  if (typeof value === 'string') {
    for (const openId of extractInlineMentionOpenIds(value)) ids.add(openId);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectInlineMentionOpenIdsFromUnknown(item, ids);
    return;
  }

  if (!value || typeof value !== 'object') return;

  for (const nested of Object.values(value as Record<string, unknown>)) {
    collectInlineMentionOpenIdsFromUnknown(nested, ids);
  }
}

export function collectCardMentionOpenIds(card: unknown, mentions?: MentionInfo[]): string[] {
  const ids = new Set<string>();

  for (const mention of resolveEffectiveMentions(mentions)) {
    if (mention.openId && mention.openId !== 'all') ids.add(mention.openId);
  }

  collectInlineMentionOpenIdsFromUnknown(card, ids);
  return [...ids];
}

function extractCardMarkdownSnippets(card: unknown): string[] {
  const snippets: string[] = [];

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    if (!value || typeof value !== 'object') return;

    const record = value as Record<string, unknown>;
    const tag = typeof record.tag === 'string' ? record.tag : undefined;
    const content = typeof record.content === 'string' ? record.content : undefined;
    if ((tag === 'markdown' || tag === 'lark_md') && content) {
      snippets.push(content);
    }

    const i18nContent = record.i18n_content;
    if (i18nContent && typeof i18nContent === 'object') {
      for (const localeText of Object.values(i18nContent as Record<string, unknown>)) {
        if (typeof localeText === 'string') snippets.push(localeText);
      }
    }

    for (const nested of Object.values(record)) visit(nested);
  };

  visit(card);
  return [...new Set(snippets.filter(Boolean))];
}

export function buildProxyCardDescriptorText(params: {
  nativeMessageId: string;
  card: Record<string, unknown>;
}): string {
  const markdown = truncateForProxy(extractCardMarkdownSnippets(params.card).join('\n\n').trim());
  const payload: Record<string, unknown> = {
    kind: 'interactive_card',
    native_message_id: params.nativeMessageId,
    card_schema: params.card.schema === '2.0' ? '2.0' : '1.0',
  };

  if (markdown) {
    payload.card_markdown = markdown;
  } else {
    payload.card_excerpt = truncateForProxy(JSON.stringify(params.card));
  }

  return [
    'OpenClaw proxy notice: the source bot sent an interactive card in Feishu.',
    'Humans can see the native card nearby; bot receivers should use the descriptor below.',
    '',
    jsonBlock(payload),
  ].join('\n');
}

export function buildProxyMediaDescriptorText(params: {
  nativeMessageId: string;
  mediaType: 'image' | 'file' | 'audio' | 'video';
  imageKey?: string;
  fileKey?: string;
  fileName?: string;
  duration?: number;
}): string {
  const payload: Record<string, unknown> = {
    kind: params.mediaType,
    native_message_id: params.nativeMessageId,
    ...(params.imageKey ? { image_key: params.imageKey } : {}),
    ...(params.fileKey ? { file_key: params.fileKey } : {}),
    ...(params.fileName ? { file_name: params.fileName } : {}),
    ...(params.duration !== undefined ? { duration_ms: params.duration } : {}),
  };

  return [
    `OpenClaw proxy notice: the source bot sent a ${params.mediaType} message in Feishu.`,
    'Humans can see the native media nearby; bot receivers should use the descriptor below.',
    '',
    jsonBlock(payload),
  ].join('\n');
}

async function resolveKnownBotOpenIds(cfg: ClawdbotConfig): Promise<Set<string>> {
  const cacheKey = 'all';
  const cached = knownBotIdsCache.get(cacheKey);
  if (cached && cached.expireAt > Date.now()) return new Set(cached.ids);

  const ids = new Set<string>();
  const accounts = getEnabledLarkAccounts(cfg);
  for (const account of accounts) {
    try {
      const probe = await LarkClient.fromAccount(account).probe({ maxAgeMs: BOT_ID_CACHE_TTL_MS });
      if (probe.ok && probe.botOpenId) ids.add(probe.botOpenId);
    } catch (err) {
      log.warn(`failed to probe bot identity for account ${account.accountId}: ${String(err)}`);
    }
  }

  knownBotIdsCache.set(cacheKey, { ids, expireAt: Date.now() + BOT_ID_CACHE_TTL_MS });
  return new Set(ids);
}

async function resolveHumanMemberOpenIds(params: {
  cfg: ClawdbotConfig;
  chatId: string;
  accountId?: string;
}): Promise<Set<string> | null> {
  const key = `${params.accountId ?? 'default'}:${params.chatId}`;
  const cached = humanMembersCache.get(key);
  if (cached && cached.expireAt > Date.now()) return new Set(cached.ids);

  try {
    const ids = new Set<string>();
    let pageToken: string | undefined;
    do {
      const page = await listChatMembersFeishu({
        cfg: params.cfg,
        chatId: params.chatId,
        accountId: params.accountId,
        pageToken,
      });

      for (const member of page.members) {
        if (member.memberId) ids.add(member.memberId);
      }
      pageToken = page.hasMore ? page.pageToken : undefined;
    } while (pageToken);

    humanMembersCache.set(key, { ids, expireAt: Date.now() + CHAT_MEMBER_CACHE_TTL_MS });
    return new Set(ids);
  } catch (err) {
    log.warn(`failed to resolve human chat members for ${params.chatId}: ${String(err)}`);
    return null;
  }
}

async function shouldProxyBotMention(params: {
  cfg: ClawdbotConfig;
  to: string;
  accountId?: string;
  mentionOpenIds: string[];
}): Promise<boolean> {
  if (params.mentionOpenIds.length === 0) {
    log.info('proxy-send decision: skipped (no mention open_ids)');
    return false;
  }

  const knownBotIds = await resolveKnownBotOpenIds(params.cfg);
  const knownBotHits = params.mentionOpenIds.filter((openId) => knownBotIds.has(openId));
  if (knownBotHits.length > 0) {
    log.info('proxy-send decision: proxy via known bot hit', {
      target: params.to,
      accountId: params.accountId,
      mentionOpenIds: params.mentionOpenIds,
      knownBotHits,
    });
    return true;
  }

  const target = normalizeFeishuTarget(params.to);
  if (!target?.startsWith('oc_')) {
    log.info('proxy-send decision: skipped (target is not a group chat)', {
      target: params.to,
      normalizedTarget: target,
      accountId: params.accountId,
      mentionOpenIds: params.mentionOpenIds,
    });
    return false;
  }

  const humanMemberIds = await resolveHumanMemberOpenIds({
    cfg: params.cfg,
    chatId: target,
    accountId: params.accountId,
  });
  if (!humanMemberIds) {
    log.info('proxy-send decision: proxy via fallback (group member API unavailable)', {
      target,
      accountId: params.accountId,
      mentionOpenIds: params.mentionOpenIds,
    });
    return true;
  }

  const nonHumanMentionOpenIds = params.mentionOpenIds.filter((openId) => !humanMemberIds.has(openId));
  log.info('proxy-send decision: group-member fallback evaluated', {
    target,
    accountId: params.accountId,
    mentionOpenIds: params.mentionOpenIds,
    humanMemberCount: humanMemberIds.size,
    nonHumanMentionOpenIds,
  });

  return nonHumanMentionOpenIds.length > 0;
}

function hasRequiredProxyScopes(scope: string | undefined): boolean {
  if (!scope) return false;
  const granted = new Set(scope.split(/\s+/).filter(Boolean));
  return PROXY_AUTH_SCOPES.every((item) => granted.has(item));
}

async function sendOwnerAuthTextFallback(params: {
  account: ConfiguredLarkAccount;
  ownerOpenId: string;
  text: string;
}): Promise<void> {
  const client = LarkClient.fromAccount(params.account).sdk;
  await client.im.v1.message.create({
    params: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      receive_id_type: 'open_id' as any,
    },
    data: {
      receive_id: params.ownerOpenId,
      msg_type: 'text',
      content: JSON.stringify({ text: params.text }),
    },
  });
}

async function promptOwnerForProxyAuthorization(params: {
  cfg: ClawdbotConfig;
  account: ConfiguredLarkAccount;
  ownerOpenId: string;
}): Promise<void> {
  const { account, ownerOpenId } = params;
  const cooldownKey = `${account.appId}:${ownerOpenId}:proxy-auth`;
  const lastPromptAt = authPromptCooldowns.get(cooldownKey) ?? 0;
  if (Date.now() - lastPromptAt < AUTH_PROMPT_COOLDOWN_MS) return;

  authPromptCooldowns.set(cooldownKey, Date.now());

  const flowKey = `${account.appId}:${ownerOpenId}`;
  if (pendingOwnerAuthFlows.has(flowKey)) return;

  try {
    const deviceAuth = await requestDeviceAuthorization({
      appId: account.appId,
      appSecret: account.appSecret,
      brand: account.brand,
      scope: PROXY_AUTH_SCOPES.join(' '),
    });

    pendingOwnerAuthFlows.add(flowKey);

    const card = buildAuthCard({
      verificationUriComplete: deviceAuth.verificationUriComplete,
      expiresMin: Math.round(deviceAuth.expiresIn / 60),
      scope: PROXY_AUTH_SCOPES.join(' '),
      appId: account.appId,
      brand: account.brand,
    });

    const client = LarkClient.fromAccount(account).sdk;
    await client.im.v1.message.create({
      params: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        receive_id_type: 'open_id' as any,
      },
      data: {
        receive_id: ownerOpenId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });

    void pollDeviceToken({
      appId: account.appId,
      appSecret: account.appSecret,
      brand: account.brand,
      deviceCode: deviceAuth.deviceCode,
      interval: deviceAuth.interval,
      expiresIn: deviceAuth.expiresIn,
    })
      .then(async (result) => {
        if (!result.ok) {
          const failure = result as { ok: false; error: string; message: string };
          log.warn(`proxy auth polling ended without token: ${failure.error} (${failure.message})`);
          return;
        }

        const now = Date.now();
        await setStoredToken({
          userOpenId: ownerOpenId,
          appId: account.appId,
          accessToken: result.token.accessToken,
          refreshToken: result.token.refreshToken,
          expiresAt: now + result.token.expiresIn * 1000,
          refreshExpiresAt: now + result.token.refreshExpiresIn * 1000,
          scope: result.token.scope,
          grantedAt: now,
        });
        log.info(`proxy auth completed for owner ${ownerOpenId}`);
      })
      .catch((err) => {
        log.warn(`proxy auth polling failed: ${String(err)}`);
      })
      .finally(() => {
        pendingOwnerAuthFlows.delete(flowKey);
      });
  } catch (err) {
    pendingOwnerAuthFlows.delete(flowKey);
    log.warn(`failed to send owner auth card, falling back to text: ${String(err)}`);
    await sendOwnerAuthTextFallback({
      account,
      ownerOpenId,
      text:
        'OpenClaw needs App Owner authorization before it can proxy bot-to-bot @mentions. ' +
        `Please authorize these scopes: ${PROXY_AUTH_SCOPES.join(', ')}`,
    });
  }
}

function preparePostText(text: string, mentions?: MentionInfo[]): string {
  let processed = normalizeAtMentions(text);

  if (mentions && mentions.length > 0) {
    processed = buildMentionedMessage(mentions, processed);
  }

  try {
    const runtime = LarkClient.runtime;
    if (runtime?.channel?.text?.convertMarkdownTables) {
      processed = runtime.channel.text.convertMarkdownTables(processed, 'bullets');
    }
  } catch {
    // Runtime not available.
  }

  return optimizeMarkdownStyle(processed, 1);
}

export function buildPostContentPayload(params: {
  text: string;
  mentions?: MentionInfo[];
  i18nTexts?: Record<string, string>;
}): string {
  const { text, mentions, i18nTexts } = params;

  if (i18nTexts && Object.keys(i18nTexts).length > 0) {
    const postBody: Record<string, { content: Array<Array<{ tag: string; text: string }>> }> = {};
    for (const [locale, localeText] of Object.entries(i18nTexts)) {
      postBody[locale] = {
        content: [[{ tag: 'md', text: preparePostText(localeText, mentions) }]],
      };
    }
    return JSON.stringify(postBody);
  }

  return JSON.stringify({
    zh_cn: {
      content: [[{ tag: 'md', text: preparePostText(text, mentions) }]],
    },
  });
}

function normalizeProxyError(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const code = (err as { code?: number }).code;
  if (typeof code === 'number') return code;
  const responseCode = (err as { response?: { data?: { code?: number } } }).response?.data?.code;
  return typeof responseCode === 'number' ? responseCode : undefined;
}

async function resolveCurrentBotMetadata(account: ConfiguredLarkAccount): Promise<ProxyBotMetadata | null> {
  try {
    const probe = await LarkClient.fromAccount(account).probe({ maxAgeMs: BOT_ID_CACHE_TTL_MS });
    if (!probe.ok || !probe.botOpenId) return null;
    return { openId: probe.botOpenId, name: probe.botName ?? account.name ?? probe.botOpenId };
  } catch (err) {
    log.warn(`failed to resolve current bot metadata: ${String(err)}`);
    return null;
  }
}

export { shouldProxyBotMention, resolveCurrentBotMetadata };

export interface PreparedProxyPostSend {
  account: ConfiguredLarkAccount;
  ownerOpenId: string;
  botMeta: ProxyBotMetadata;
}

export async function prepareProxyPostMessage(params: {
  cfg: ClawdbotConfig;
  to: string;
  accountId?: string;
  mentionOpenIds: string[];
}): Promise<PreparedProxyPostSend | null> {
  if (params.mentionOpenIds.length === 0) return null;

  const account = getLarkAccount(params.cfg, params.accountId);
  if (!account.configured) return null;

  const shouldProxy = await shouldProxyBotMention({
    cfg: params.cfg,
    to: params.to,
    accountId: params.accountId,
    mentionOpenIds: params.mentionOpenIds,
  });
  if (!shouldProxy) return null;

  const botMeta = await resolveCurrentBotMetadata(account);
  if (!botMeta?.openId) {
    log.warn(`proxy-send skipped: current bot metadata unavailable for account ${account.accountId}`);
    return null;
  }

  const sdk = LarkClient.fromAccount(account).sdk;
  const ownerOpenId = await getAppOwnerFallback(account, sdk);
  if (!ownerOpenId) {
    throw new Error(`Cannot proxy bot mention: failed to resolve App Owner for account ${account.accountId}`);
  }

  const stored = await getStoredToken(account.appId, ownerOpenId);
  const hasUsableToken = !!stored && tokenStatus(stored) !== 'expired' && hasRequiredProxyScopes(stored.scope);
  if (!hasUsableToken) {
    await promptOwnerForProxyAuthorization({
      cfg: params.cfg,
      account,
      ownerOpenId,
    });
    throw new ProxySendPausedError(ownerOpenId);
  }

  return { account, ownerOpenId, botMeta };
}

export async function sendPreparedProxyPostMessage(params: {
  prepared: PreparedProxyPostSend;
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  replyToMessageId?: string;
  mentions?: MentionInfo[];
  replyInThread?: boolean;
  i18nTexts?: Record<string, string>;
}): Promise<FeishuSendResult> {
  const { prepared } = params;
  const mentions = resolveEffectiveMentions(params.mentions);
  const proxiedText = appendProxyHeader(params.text, prepared.botMeta);
  const proxiedI18nTexts = params.i18nTexts
    ? Object.fromEntries(
        Object.entries(params.i18nTexts).map(([locale, localeText]) => [locale, appendProxyHeader(localeText, prepared.botMeta)]),
      )
    : undefined;
  const contentPayload = buildPostContentPayload({
    text: proxiedText,
    mentions,
    i18nTexts: proxiedI18nTexts,
  });

  const normalizedReplyToMessageId = normalizeMessageId(params.replyToMessageId);
  const normalizedTarget = normalizeFeishuTarget(params.to);
  if (!normalizedTarget) {
    throw new Error(`[proxy-send] Invalid target: "${params.to}"`);
  }

  const sdk = LarkClient.fromAccount(prepared.account).sdk;

  try {
    return await callWithUAT(
      {
        userOpenId: prepared.ownerOpenId,
        appId: prepared.account.appId,
        appSecret: prepared.account.appSecret,
        domain: prepared.account.brand,
      },
      async (accessToken) => {
        const opts = Lark.withUserAccessToken(accessToken);
        if (normalizedReplyToMessageId) {
          const response = await sdk.im.v1.message.reply(
            {
              path: { message_id: normalizedReplyToMessageId },
              data: {
                content: contentPayload,
                msg_type: 'post',
                reply_in_thread: params.replyInThread,
              },
            },
            opts,
          );

          if (response?.code && response.code !== 0) {
            const error = new Error(response.msg || `Lark API error ${response.code}`);
            (error as { code?: number }).code = response.code;
            throw error;
          }

          return {
            messageId: response?.data?.message_id ?? '',
            chatId: response?.data?.chat_id ?? '',
          };
        }

        const response = await sdk.im.v1.message.create(
          {
            params: {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              receive_id_type: resolveReceiveIdType(normalizedTarget) as any,
            },
            data: {
              receive_id: normalizedTarget,
              msg_type: 'post',
              content: contentPayload,
            },
          },
          opts,
        );

        if (response?.code && response.code !== 0) {
          const error = new Error(response.msg || `Lark API error ${response.code}`);
          (error as { code?: number }).code = response.code;
          throw error;
        }

        return {
          messageId: response?.data?.message_id ?? '',
          chatId: response?.data?.chat_id ?? '',
        };
      },
    );
  } catch (err) {
    const errorCode = normalizeProxyError(err);
    if (
      err instanceof NeedAuthorizationError ||
      errorCode === LARK_ERROR.USER_SCOPE_INSUFFICIENT ||
      errorCode === LARK_ERROR.TOKEN_INVALID ||
      errorCode === LARK_ERROR.TOKEN_EXPIRED
    ) {
      await promptOwnerForProxyAuthorization({
        cfg: params.cfg,
        account: prepared.account,
        ownerOpenId: prepared.ownerOpenId,
      });
      throw new ProxySendPausedError(prepared.ownerOpenId);
    }
    throw err;
  }
}

export async function maybeSendProxyPostMessage(params: {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  replyToMessageId?: string;
  mentions?: MentionInfo[];
  accountId?: string;
  replyInThread?: boolean;
  i18nTexts?: Record<string, string>;
}): Promise<FeishuSendResult | null> {
  const mentions = resolveEffectiveMentions(params.mentions);
  const mentionOpenIds = collectMentionOpenIds({
    text: params.text,
    mentions,
    i18nTexts: params.i18nTexts,
  });
  log.info('proxy-send candidate detected', {
    target: params.to,
    accountId: params.accountId,
    replyToMessageId: params.replyToMessageId,
    mentionOpenIds,
    mentionCount: mentions.length,
    hasI18nTexts: Boolean(params.i18nTexts && Object.keys(params.i18nTexts).length > 0),
    textPreview: params.text.slice(0, 120),
  });
  const prepared = await prepareProxyPostMessage({
    cfg: params.cfg,
    to: params.to,
    accountId: params.accountId,
    mentionOpenIds,
  });
  if (!prepared) {
    log.info('proxy-send candidate not proxied', {
      target: params.to,
      accountId: params.accountId,
      mentionOpenIds,
    });
    return null;
  }

  log.info('proxy-send candidate approved', {
    target: params.to,
    accountId: params.accountId,
    mentionOpenIds,
    ownerOpenId: prepared.ownerOpenId,
    sourceBotOpenId: prepared.botMeta.openId,
  });

  return sendPreparedProxyPostMessage({
    prepared,
    cfg: params.cfg,
    to: params.to,
    text: params.text,
    replyToMessageId: params.replyToMessageId,
    mentions,
    replyInThread: params.replyInThread,
    i18nTexts: params.i18nTexts,
  });
}

export function buildProxyAuthDedupKey(): string {
  const ticket = getTicket();
  return ticket ? `${ticket.accountId}:${ticket.chatId}:${ticket.messageId}` : `standalone:${Date.now()}`;
}
