/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Register all chat commands (/feishu_diagnose, /feishu_doctor, /feishu_auth, /feishu).
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { runDiagnosis, formatDiagReportText } from './diagnose';
import { runFeishuDoctor } from './doctor';
import { runFeishuAuth } from './auth';
import { getPluginVersion } from '../core/version';


export function registerCommands(api: OpenClawPluginApi): void {
  // /feishu_diagnose
  api.registerCommand({
    name: 'feishu_diagnose',
    description: '运行飞书插件诊断，检查配置、连通性和权限状态',
    acceptsArgs: false,
    requireAuth: true,
    async handler(ctx) {
      try {
        const report = await runDiagnosis({ config: ctx.config });
        return { text: formatDiagReportText(report) };
      } catch (err) {
        return {
          text: `诊断执行失败: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  });

  // /feishu_doctor
  api.registerCommand({
    name: 'feishu_doctor',
    description: '运行飞书插件诊断',
    acceptsArgs: false,
    requireAuth: true,
    async handler(ctx) {
      try {
        const markdown = await runFeishuDoctor(ctx.config, ctx.accountId);
        return { text: markdown };
      } catch (err) {
        return {
          text: `诊断执行失败: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  });

  // /feishu_auth
  api.registerCommand({
    name: 'feishu_auth',
    description: '飞书用户权限批量授权',
    acceptsArgs: false,
    requireAuth: true,
    async handler(ctx) {
      try {
        const result = await runFeishuAuth(ctx.config);
        return { text: result };
      } catch (err) {
        return {
          text: `授权执行失败: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  });

  // /feishu (统一入口，支持子命令)
  api.registerCommand({
    name: 'feishu',
    description: '飞书插件命令（支持子命令: auth, doctor, start）',
    acceptsArgs: true,
    requireAuth: true,
    async handler(ctx) {
      const args = ctx.args?.trim().split(/\s+/) || [];
      const subcommand = args[0]?.toLowerCase();

      try {
        // /feishu auth 或 /feishu onboarding
        if (subcommand === 'auth' || subcommand === 'onboarding') {
          const result = await runFeishuAuth(ctx.config);
          return { text: result };
        }

        // /feishu doctor
        if (subcommand === 'doctor') {
          const markdown = await runFeishuDoctor(ctx.config, ctx.accountId);
          return { text: markdown };
        }

        // /feishu start
        if (subcommand === 'start') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const cfg = ctx.config as any;
          const errors: string[] = [];
          const warnings: string[] = [];

          // 检查旧版插件是否已禁用 (error)
          const feishuEntry = cfg.plugins?.entries?.feishu;
          if (feishuEntry && feishuEntry.enabled !== false) {
            errors.push(
              '❌ 检测到旧版插件未禁用。\n' +
                '👉 请依次运行命令：\n' +
                '```\n' +
                'openclaw config set plugins.entries.feishu.enabled false --json\n' +
                'openclaw gateway restart\n' +
                '```',
            );
          }

          // 检查 tools.profile (warning)
          const profile: string | undefined = cfg.tools?.profile;
          const incompleteProfiles = new Set(['minimal', 'coding', 'messaging']);
          if (profile && incompleteProfiles.has(profile)) {
            warnings.push(`⚠️ 工具 Profile 当前为 \`${profile}\`，飞书工具可能无法加载。请检查配置是否正确。\n`);
          }

          if (errors.length > 0) {
            const all = [...errors, ...warnings];
            return {
              text: `❌ 飞书 OpenClaw 插件启动失败：\n\n${all.join('\n\n')}`,
            };
          }

          if (warnings.length > 0) {
            return {
              text: `⚠️ 飞书 OpenClaw 插件已启动 v${getPluginVersion()}（存在警告）\n\n${warnings.join('\n\n')}`,
            };
          }

          return { text: `✅ 飞书 OpenClaw 插件已启动 v${getPluginVersion()}` };
        }

        // /feishu help 或无效子命令或无参数
        return {
          text:
            `飞书OpenClaw插件 v${getPluginVersion()}\n\n` +
            '用法：\n' +
            '  /feishu start - 校验插件配置\n' +
            '  /feishu auth - 批量授权用户权限\n' +
            '  /feishu doctor - 运行诊断\n' +
            '  /feishu help - 显示此帮助',
        };
      } catch (err) {
        return {
          text: `执行失败: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  });
}
