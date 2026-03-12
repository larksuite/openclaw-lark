/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Zod-based configuration schema for the OpenClaw Lark/Feishu channel plugin.
 *
 * Provides runtime validation, sensible defaults, and cross-field refinements
 * so that every consuming module can rely on well-typed configuration objects.
 */

import { z, toJSONSchema } from 'zod';

export { z };

// ---------------------------------------------------------------------------
// Shared micro-schemas
// ---------------------------------------------------------------------------

const DmPolicyEnum = z.enum(['open', 'pairing', 'allowlist', 'disabled']);
const GroupPolicyEnum = z.enum(['open', 'allowlist', 'disabled']);
const ConnectionModeEnum = z.enum(['websocket', 'webhook']);
const ReplyModeValue = z.enum(['auto', 'static', 'streaming']);
const ReplyModeSchema = z
  .union([
    ReplyModeValue,
    z.object({
      default: ReplyModeValue.optional(),
      group: ReplyModeValue.optional(),
      direct: ReplyModeValue.optional(),
    }),
  ])
  .optional();
const ChunkModeEnum = z.enum(['newline', 'paragraph', 'none']);

const DomainSchema = z.union([z.literal('feishu'), z.literal('lark'), z.string().regex(/^https:\/\//)]).optional();

const AllowFromSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => {
    if (v === undefined || v === null) return undefined;
    return Array.isArray(v) ? v : [v];
  });

const ToolPolicySchema = z
  .object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  })
  .optional();

const FeishuToolsFlagSchema = z
  .object({
    doc: z.boolean().optional(),
    wiki: z.boolean().optional(),
    drive: z.boolean().optional(),
    perm: z.boolean().optional(),
    scopes: z.boolean().optional(),
  })
  .optional();

const FeishuFooterSchema = z
  .object({
    status: z.boolean().optional(),
    elapsed: z.boolean().optional(),
  })
  .optional();

const BlockStreamingCoalesceSchema = z
  .object({
    minChars: z.number().optional(),
    maxChars: z.number().optional(),
    idleMs: z.number().optional(),
  })
  .optional();

const MarkdownConfigSchema = z
  .object({
    tables: z.enum(['off', 'bullets', 'code']).optional(),
  })
  .optional();

const HeartbeatSchema = z
  .object({
    every: z.string().optional(),
    activeHours: z
      .object({
        start: z.string().optional(),
        end: z.string().optional(),
        timezone: z.string().optional(),
      })
      .optional(),
    target: z.string().optional(),
    to: z.string().optional(),
    prompt: z.string().optional(),
    accountId: z.string().optional(),
  })
  .optional();

const CapabilitiesSchema = z
  .object({
    image: z.boolean().optional(),
    audio: z.boolean().optional(),
    video: z.boolean().optional(),
  })
  .optional();

const DedupSchema = z
  .object({
    ttlMs: z.number().optional(), // default 43200000 (12h)
    maxEntries: z.number().optional(), // default 5000
  })
  .optional();

const ReactionNotificationModeSchema = z.enum(['off', 'own', 'all']).optional();

export const UATConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    allowedScopes: z.array(z.string()).optional(),
    blockedScopes: z.array(z.string()).optional(),
    /** true（默认）= 只有飞书应用 Owner 可以触发 OAuth 授权流程和使用 UAT。
     *  false = 允许非 Owner 用户继续进入 appRoleAuth / accessLevel 判权链路。
     *  启用时 appRoleAuth 和 accessLevel 不生效。 */
    ownerOnly: z.boolean().optional(),
    /** true = 启用应用角色鉴权，按协作者角色放行 UAT 访问。
     *  false（默认）= 在 ownerOnly=false 时，不做额外角色校验。
     *  仅在 ownerOnly=false 时生效。 */
    appRoleAuth: z.boolean().optional(),
    /** 最低准入角色等级（仅在 appRoleAuth=true 时生效）。
     *  1=normal（所有用户）, 2=operator, 3=developer, 4=administrator。
     *  默认 1（不限角色）。 */
    accessLevel: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
    /** true = 配对审批通过后自动向用户推送 OAuth 授权卡片。
     *  false（默认）= 用户需要手动执行 /feishu auth 发起授权。 */
    autoOnboarding: z.boolean().optional(),
  })
  .optional();

const DmConfigSchema = z
  .object({
    historyLimit: z.number().optional(),
  })
  .optional();

// ---------------------------------------------------------------------------
// Group schema
// ---------------------------------------------------------------------------

export const FeishuGroupSchema = z.object({
  groupPolicy: GroupPolicyEnum.optional(),
  requireMention: z.boolean().optional(),
  tools: ToolPolicySchema,
  skills: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  allowFrom: AllowFromSchema,
  systemPrompt: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Account config schema (same shape as top-level minus `accounts`)
// ---------------------------------------------------------------------------

export const FeishuAccountConfigSchema = z.object({
  appId: z.string().optional(),
  appSecret: z.string().optional(),
  encryptKey: z.string().optional(),
  verificationToken: z.string().optional(),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  domain: DomainSchema,
  connectionMode: ConnectionModeEnum.optional(),
  webhookPath: z.string().optional(),
  webhookPort: z.number().optional(),
  dmPolicy: DmPolicyEnum.optional(),
  allowFrom: AllowFromSchema,
  groupPolicy: GroupPolicyEnum.optional(),
  groupAllowFrom: AllowFromSchema,
  requireMention: z.boolean().optional(),
  groups: z.record(z.string(), FeishuGroupSchema).optional(),
  historyLimit: z.number().optional(),
  dmHistoryLimit: z.number().optional(),
  dms: DmConfigSchema,
  textChunkLimit: z.number().optional(),
  chunkMode: ChunkModeEnum.optional(),
  blockStreamingCoalesce: BlockStreamingCoalesceSchema,
  mediaMaxMb: z.number().optional(),
  heartbeat: HeartbeatSchema,
  replyMode: ReplyModeSchema,
  streaming: z.boolean().optional(),
  blockStreaming: z.boolean().optional(),
  tools: FeishuToolsFlagSchema,
  footer: FeishuFooterSchema,
  markdown: MarkdownConfigSchema,
  configWrites: z.boolean().optional(),
  capabilities: CapabilitiesSchema,
  dedup: DedupSchema,
  reactionNotifications: ReactionNotificationModeSchema,
  threadSession: z.boolean().optional(),
  uat: UATConfigSchema,
});

// ---------------------------------------------------------------------------
// Top-level Feishu config schema
// ---------------------------------------------------------------------------

export const FeishuConfigSchema = FeishuAccountConfigSchema.extend({
  accounts: z.record(z.string(), FeishuAccountConfigSchema).optional(),
}).superRefine((data, ctx) => {
  // When dmPolicy is "open", allowFrom must contain the wildcard "*".
  if (data.dmPolicy === 'open') {
    const list = data.allowFrom;
    const hasWildcard = Array.isArray(list) && list.includes('*');

    if (!hasWildcard) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowFrom'],
        message: 'When dmPolicy is "open", allowFrom must include "*" to permit all senders.',
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Auto-generated JSON Schema (single source of truth)
// ---------------------------------------------------------------------------

/**
 * JSON Schema derived from FeishuConfigSchema.
 *
 * - `io: "input"` exposes the input type for `.transform()` schemas (e.g. AllowFromSchema).
 * - `unrepresentable: "any"` degrades `.superRefine()` constraints to `{}`.
 * - `target: "draft-07"` matches the plugin system's expected JSON Schema version.
 */
export const FEISHU_CONFIG_JSON_SCHEMA: Record<string, unknown> = toJSONSchema(FeishuConfigSchema, {
  target: 'draft-07',
  io: 'input',
  unrepresentable: 'any',
});
