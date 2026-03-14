/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Register all chat commands (/feishu_diagnose, /feishu_doctor, /feishu_auth, /feishu).
 */

import type { OpenClawPluginApi, OpenClawConfig } from 'openclaw/plugin-sdk';
import { runDiagnosis, formatDiagReportText } from './diagnose';
import { runFeishuDoctor } from './doctor';
import { runFeishuAuth } from './auth';
import { getPluginVersion } from '../core/version';

import type { FeishuLocale } from './locale';

// ---------------------------------------------------------------------------
// I18n text map for /feishu start, help, and error messages
// ---------------------------------------------------------------------------

const T: Record<FeishuLocale, {
  // start
  legacyNotDisabled: string;
  toolsProfileWarn: (profile: string) => string;
  startFailed: (details: string) => string;
  startWithWarnings: (version: string, details: string) => string;
  startOk: (version: string) => string;
  // help
  helpTitle: (version: string) => string;
  helpUsage: string;
  helpStart: string;
  helpAuth: string;
  helpDoctor: string;
  helpHelp: string;
  // errors
  diagFailed: (msg: string) => string;
  authFailed: (msg: string) => string;
  execFailed: (msg: string) => string;
}> = {
  zh_cn: {
    legacyNotDisabled:
      '❌ 检测到旧版插件未禁用。\n' +
      '👉 请依次运行命令：\n' +
      '```\n' +
      'openclaw config set plugins.entries.feishu.enabled false --json\n' +
      'openclaw gateway restart\n' +
      '```',
    toolsProfileWarn: (profile) =>
      `⚠️ 工具 Profile 当前为 \`${profile}\`，飞书工具可能无法加载。请检查配置是否正确。\n`,
    startFailed: (details) => `❌ 飞书 OpenClaw 插件启动失败：\n\n${details}`,
    startWithWarnings: (version, details) =>
      `⚠️ 飞书 OpenClaw 插件已启动 v${version}（存在警告）\n\n${details}`,
    startOk: (version) => `✅ 飞书 OpenClaw 插件已启动 v${version}`,
    helpTitle: (version) => `飞书OpenClaw插件 v${version}`,
    helpUsage: '用法：',
    helpStart: '/feishu start - 校验插件配置',
    helpAuth: '/feishu auth - 批量授权用户权限',
    helpDoctor: '/feishu doctor - 运行诊断',
    helpHelp: '/feishu help - 显示此帮助',
    diagFailed: (msg) => `诊断执行失败: ${msg}`,
    authFailed: (msg) => `授权执行失败: ${msg}`,
    execFailed: (msg) => `执行失败: ${msg}`,
  },
  en_us: {
    legacyNotDisabled:
      '❌ Legacy plugin is not disabled.\n' +
      '👉 Please run the following commands:\n' +
      '```\n' +
      'openclaw config set plugins.entries.feishu.enabled false --json\n' +
      'openclaw gateway restart\n' +
      '```',
    toolsProfileWarn: (profile) =>
      `⚠️ Tools profile is currently set to \`${profile}\`. Feishu tools may not load properly. Please check your configuration.\n`,
    startFailed: (details) => `❌ Feishu OpenClaw plugin failed to start:\n\n${details}`,
    startWithWarnings: (version, details) =>
      `⚠️ Feishu OpenClaw plugin started v${version} (with warnings)\n\n${details}`,
    startOk: (version) => `✅ Feishu OpenClaw plugin started v${version}`,
    helpTitle: (version) => `Feishu OpenClaw Plugin v${version}`,
    helpUsage: 'Usage:',
    helpStart: '/feishu start - Validate plugin configuration',
    helpAuth: '/feishu auth - Batch authorize user permissions',
    helpDoctor: '/feishu doctor - Run diagnostics',
    helpHelp: '/feishu help - Show this help',
    diagFailed: (msg) => `Diagnostics failed: ${msg}`,
    authFailed: (msg) => `Authorization failed: ${msg}`,
    execFailed: (msg) => `Execution failed: ${msg}`,
  },
};

// ---------------------------------------------------------------------------
// Exported i18n functions
// ---------------------------------------------------------------------------

/**
 * 运行 /feishu start 校验，返回 Markdown 格式结果。
 */
export function runFeishuStart(
  config: OpenClawConfig,
  locale: FeishuLocale = 'zh_cn',
): string {
  const t = T[locale];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg = config as any;
  const errors: string[] = [];
  const warnings: string[] = [];

  // 检查旧版插件是否已禁用 (error)
  const feishuEntry = cfg.plugins?.entries?.feishu;
  if (feishuEntry && feishuEntry.enabled !== false) {
    errors.push(t.legacyNotDisabled);
  }

  // 检查 tools.profile (warning)
  const profile: string | undefined = cfg.tools?.profile;
  const incompleteProfiles = new Set(['minimal', 'coding', 'messaging']);
  if (profile && incompleteProfiles.has(profile)) {
    warnings.push(t.toolsProfileWarn(profile));
  }

  if (errors.length > 0) {
    const all = [...errors, ...warnings];
    return t.startFailed(all.join('\n\n'));
  }

  if (warnings.length > 0) {
    return t.startWithWarnings(getPluginVersion(), warnings.join('\n\n'));
  }

  return t.startOk(getPluginVersion());
}

/**
 * 运行 /feishu start，同时生成中英双语结果。
 */
export function runFeishuStartI18n(config: OpenClawConfig): Record<FeishuLocale, string> {
  return {
    zh_cn: runFeishuStart(config, 'zh_cn'),
    en_us: runFeishuStart(config, 'en_us'),
  };
}

/**
 * 生成 /feishu help 帮助文本。
 */
export function getFeishuHelp(locale: FeishuLocale = 'zh_cn'): string {
  const t = T[locale];
  return (
    `${t.helpTitle(getPluginVersion())}\n\n` +
    `${t.helpUsage}\n` +
    `  ${t.helpStart}\n` +
    `  ${t.helpAuth}\n` +
    `  ${t.helpDoctor}\n` +
    `  ${t.helpHelp}`
  );
}

/**
 * 生成 /feishu help，同时生成中英双语结果。
 */
export function getFeishuHelpI18n(): Record<FeishuLocale, string> {
  return {
    zh_cn: getFeishuHelp('zh_cn'),
    en_us: getFeishuHelp('en_us'),
  };
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerCommands(api: OpenClawPluginApi): void {
  // /feishu_diagnose
  api.registerCommand({
    name: 'feishu_diagnose',
    description: 'Run Feishu plugin diagnostics to check config, connectivity, and permissions',
    acceptsArgs: false,
    requireAuth: true,
    async handler(ctx) {
      try {
        const report = await runDiagnosis({ config: ctx.config });
        return { text: formatDiagReportText(report) };
      } catch (err) {
        return {
          text: T.zh_cn.diagFailed(err instanceof Error ? err.message : String(err)),
        };
      }
    },
  });

  // /feishu_doctor
  api.registerCommand({
    name: 'feishu_doctor',
    description: 'Run Feishu plugin diagnostics',
    acceptsArgs: false,
    requireAuth: true,
    async handler(ctx) {
      try {
        const markdown = await runFeishuDoctor(ctx.config, ctx.accountId);
        return { text: markdown };
      } catch (err) {
        return {
          text: T.zh_cn.diagFailed(err instanceof Error ? err.message : String(err)),
        };
      }
    },
  });

  // /feishu_auth
  api.registerCommand({
    name: 'feishu_auth',
    description: 'Batch authorize user permissions for Feishu',
    acceptsArgs: false,
    requireAuth: true,
    async handler(ctx) {
      try {
        const result = await runFeishuAuth(ctx.config);
        return { text: result };
      } catch (err) {
        return {
          text: T.zh_cn.authFailed(err instanceof Error ? err.message : String(err)),
        };
      }
    },
  });

  // /feishu (统一入口，支持子命令)
  api.registerCommand({
    name: 'feishu',
    description: 'Feishu plugin commands (subcommands: auth, doctor, start)',
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
          return { text: runFeishuStart(ctx.config) };
        }

        // /feishu help 或无效子命令或无参数
        return { text: getFeishuHelp() };
      } catch (err) {
        return {
          text: T.zh_cn.execFailed(err instanceof Error ? err.message : String(err)),
        };
      }
    },
  });
}
