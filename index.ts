/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * OpenClaw Lark/Feishu plugin entry point.
 *
 * Registers the Feishu channel and all tool families:
 * doc, wiki, drive, perm, bitable, task, calendar.
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { feishuPlugin } from './src/channel/plugin';
import { FEISHU_CONFIG_JSON_SCHEMA } from './src/core/config-schema';
import { LarkClient } from './src/core/lark-client';
import { registerOapiTools } from './src/tools/oapi/index';
import { registerFeishuMcpDocTools } from './src/tools/mcp/doc/index';
import { registerFeishuOAuthTool } from './src/tools/oauth';
import { registerFeishuOAuthBatchAuthTool } from './src/tools/oauth-batch-auth';
import { registerAskUserQuestionTool } from './src/tools/ask-user-question';
import {
  analyzeTrace,
  formatDiagReportCli,
  formatTraceOutput,
  runDiagnosis,
  traceByMessageId,
} from './src/commands/diagnose';
import { registerCommands } from './src/commands/index';
import { larkLogger } from './src/core/lark-logger';
import { emitSecurityWarnings } from './src/core/security-check';
import { recordToolUseEnd, recordToolUseStart } from './src/card/tool-use-trace-store';
import { sanitizeParamsForLog } from './src/card/reasoning-utils';

const log = larkLogger('plugin');

// ---------------------------------------------------------------------------
// Re-exports for external consumers
// ---------------------------------------------------------------------------

export { monitorFeishuProvider } from './src/channel/monitor';
export { sendMessageFeishu, sendCardFeishu, updateCardFeishu, editMessageFeishu } from './src/messaging/outbound/send';
export { getMessageFeishu } from './src/messaging/outbound/fetch';
export {
  uploadImageLark,
  uploadFileLark,
  sendImageLark,
  sendFileLark,
  sendAudioLark,
  uploadAndSendMediaLark,
} from './src/messaging/outbound/media';
export {
  sendTextLark,
  sendCardLark,
  sendMediaLark,
  type SendTextLarkParams,
  type SendCardLarkParams,
  type SendMediaLarkParams,
} from './src/messaging/outbound/deliver';
export { type FeishuChannelData } from './src/messaging/outbound/outbound';
export { probeFeishu } from './src/channel/probe';
export {
  addReactionFeishu,
  removeReactionFeishu,
  listReactionsFeishu,
  FeishuEmoji,
  VALID_FEISHU_EMOJI_TYPES,
} from './src/messaging/outbound/reactions';
export { forwardMessageFeishu } from './src/messaging/outbound/forward';
export {
  updateChatFeishu,
  addChatMembersFeishu,
  removeChatMembersFeishu,
  listChatMembersFeishu,
} from './src/messaging/outbound/chat-manage';
export { feishuMessageActions } from './src/messaging/outbound/actions';
export {
  mentionedBot,
  nonBotMentions,
  extractMessageBody,
  formatMentionForText,
  formatMentionForCard,
  formatMentionAllForText,
  formatMentionAllForCard,
  buildMentionedMessage,
  buildMentionedCardContent,
  type MentionInfo,
} from './src/messaging/inbound/mention';
export { feishuPlugin } from './src/channel/plugin';
export type {
  MessageContext,
  RawMessage,
  RawSender,
  FeishuMessageContext,
  FeishuReactionCreatedEvent,
} from './src/messaging/types';
export { handleFeishuReaction } from './src/messaging/inbound/reaction-handler';
export { parseMessageEvent } from './src/messaging/inbound/parse';
export { checkMessageGate } from './src/messaging/inbound/gate';
export { isMessageExpired } from './src/messaging/inbound/dedup';

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = {
  id: 'openclaw-lark',
  name: 'Feishu',
  description: 'Lark/Feishu channel plugin with im/doc/wiki/drive/task/calendar tools',
  configSchema: {
    schema: {
      type: 'object',
      properties: {
        channels: {
          type: 'object',
          properties: {
            feishu: FEISHU_CONFIG_JSON_SCHEMA,
          },
        },
      },
    },
  },
  register(api: OpenClawPluginApi): void {
    LarkClient.setRuntime(api.runtime);
    api.registerChannel({ plugin: feishuPlugin });

    // ========================================

    // Register OAPI tools (calendar, task - using Feishu Open API directly)
    registerOapiTools(api);

    // Register MCP doc tools (using Model Context Protocol)
    registerFeishuMcpDocTools(api);

    // Register OAuth tool (UAT device flow authorization)
    registerFeishuOAuthTool(api);

    // Register OAuth batch auth tool (batch authorization for all app scopes)
    registerFeishuOAuthBatchAuthTool(api);

    // Register AskUserQuestion tool (interactive card-based user prompting)
    registerAskUserQuestionTool(api);

    api.on('before_tool_call', (event, ctx) => {
      recordToolUseStart({
        sessionKey: ctx.sessionKey,
        toolName: event.toolName,
        toolParams: event.params,
        toolCallId: event.toolCallId ?? ctx.toolCallId,
        runId: event.runId ?? ctx.runId,
      });
      if (!event.toolName.startsWith('feishu_')) return;
      const paramsPreview = sanitizeParamsForLog(event.params);
      log.info(`tool call: ${event.toolName} session=${ctx.sessionKey ?? '-'} params=${paramsPreview}`);
    });

    api.on('after_tool_call', (event, ctx) => {
      recordToolUseEnd({
        sessionKey: ctx.sessionKey,
        toolName: event.toolName,
        toolParams: event.params,
        toolCallId: event.toolCallId ?? ctx.toolCallId,
        runId: event.runId ?? ctx.runId,
        result: event.result,
        error: event.error,
        durationMs: event.durationMs,
      });
      if (!event.toolName.startsWith('feishu_')) return;
      if (event.error) {
        log.error(
          `tool fail: ${event.toolName} session=${ctx.sessionKey ?? '-'} ${event.error} (${event.durationMs ?? 0}ms)`,
        );
      } else {
        log.info(`tool done: ${event.toolName} session=${ctx.sessionKey ?? '-'} ok (${event.durationMs ?? 0}ms)`);
      }
    });

    // ---- Diagnostic commands ----

    // CLI: openclaw feishu-diagnose [--trace <messageId>]
    api.registerCli(
      (ctx) => {
        ctx.program
          .command('feishu-diagnose')
          .description('运行飞书插件诊断，检查配置、连通性和权限状态')
          .option('--trace <messageId>', '按 message_id 追踪完整处理链路')
          .option('--analyze', '分析追踪日志（需配合 --trace 使用）')
          .action(async (opts: { trace?: string; analyze?: boolean }) => {
            try {
              if (opts.trace) {
                const lines = await traceByMessageId(opts.trace);
                // eslint-disable-next-line no-console -- CLI 命令直接输出到终端
                console.log(formatTraceOutput(lines, opts.trace));
                if (opts.analyze && lines.length > 0) {
                  // eslint-disable-next-line no-console -- CLI 命令直接输出到终端
                  console.log(analyzeTrace(lines, opts.trace));
                }
              } else {
                const report = await runDiagnosis({
                  config: ctx.config,
                  logger: ctx.logger,
                });
                // eslint-disable-next-line no-console -- CLI 命令直接输出到终端
                console.log(formatDiagReportCli(report));
                if (report.overallStatus === 'unhealthy') {
                  process.exitCode = 1;
                }
              }
            } catch (err) {
              ctx.logger.error(`诊断命令执行失败: ${err}`);
              process.exitCode = 1;
            }
          });
      },
      { commands: ['feishu-diagnose'] },
    );

    // Chat commands: /feishu_diagnose, /feishu_doctor, /feishu_auth, /feishu
    registerCommands(api);

    // ---- Multi-account security checks ----
    if (api.config) {
      emitSecurityWarnings(api.config, api.logger);
    }
  },
};

export default plugin;
