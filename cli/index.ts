#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { getLarkAccount } from '../src/core/accounts';
import { getTicket } from '../src/core/lark-ticket';
import { getStoredToken, tokenStatus } from '../src/core/token-store';
import { registerFeishuMcpDocTools } from '../src/tools/mcp/doc/index';
import { registerOapiTools } from '../src/tools/oapi/index';
import { registerFeishuOAuthBatchAuthTool } from '../src/tools/oauth-batch-auth';
import { executeAuthorize } from '../src/tools/oauth';
import { loadCliConfig, getDefaultConfigPath, type CliConfig } from './config';
import { CliPluginShim, type CapturedTool } from './shim';
import { runWithCliTicket } from './ticket-context';

interface ParsedArgs {
  configPath?: string;
  help: boolean;
  version: boolean;
  scope?: string;
  positionals: string[];
}

interface ToolRegistry {
  config: CliConfig;
  shim: CliPluginShim;
  publicTools: Map<string, CapturedTool>;
  internalTools: Map<string, CapturedTool>;
}

interface AuthWaitResult {
  completed: boolean;
  message?: string;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function printFatal(error: string): void {
  printJson({ ok: false, error });
  process.exitCode = 1;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    help: false,
    version: false,
    positionals: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }

    if (arg === '--version' || arg === '-v') {
      parsed.version = true;
      continue;
    }

    if (arg === '--config') {
      parsed.configPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith('--config=')) {
      parsed.configPath = arg.slice('--config='.length);
      continue;
    }

    if (arg === '--scope') {
      parsed.scope = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith('--scope=')) {
      parsed.scope = arg.slice('--scope='.length);
      continue;
    }

    parsed.positionals.push(arg);
  }

  return parsed;
}

async function getVersion(): Promise<string> {
  const packageJsonUrl = new URL('../package.json', import.meta.url);
  const raw = await readFile(packageJsonUrl, 'utf8');
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version ?? '0.0.0';
}

function formatUsage(): string {
  return [
    'Usage:',
    '  node cli/run.mjs list [--config <path>]',
    '  node cli/run.mjs describe <tool_name> [--config <path>]',
    "  node cli/run.mjs <tool_name> '<json_params>' [--config <path>]",
    '  node cli/run.mjs auth [--scope "<scope ...>"] [--config <path>]',
    '',
    `Default config path: ${getDefaultConfigPath()}`,
  ].join('\n');
}

function extractResultPayload(result: unknown): unknown {
  if (!result || typeof result !== 'object') {
    return result;
  }

  const toolResult = result as {
    details?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };

  if (toolResult.details !== undefined) {
    return toolResult.details;
  }

  const text = toolResult.content?.find((item) => item?.type === 'text')?.text;
  if (!text) {
    return result;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function waitForAuthAndCheckToken(config: CliConfig, snapshotGrantedAt: number): Promise<AuthWaitResult> {
  if (!config.userOpenId) {
    return {
      completed: false,
      message: '缺少 userOpenId，无法检查授权结果。',
    };
  }

  return new Promise<AuthWaitResult>((resolve) => {
    let settled = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();

    const cleanup = () => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
      process.off('beforeExit', onBeforeExit);
    };

    const finish = (result: AuthWaitResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const checkToken = async (): Promise<boolean> => {
      const token = await getStoredToken(config.appId, config.userOpenId!);
      if (token && tokenStatus(token) !== 'expired' && (token.grantedAt ?? 0) > snapshotGrantedAt) {
        finish({ completed: true });
        return true;
      }
      return false;
    };

    const scheduleCheck = (delayMs: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        void (async () => {
          if (settled) return;
          if (!(await checkToken())) {
            scheduleCheck(2000);
          }
        })();
      }, delayMs);
      timer.unref();
      timers.add(timer);
    };

    const onBeforeExit = () => {
      void (async () => {
        if (settled) return;
        if (!(await checkToken())) {
          finish({
            completed: false,
            message: '授权未完成（超时、被拒绝或身份不匹配）',
          });
        }
      })();
    };

    process.once('beforeExit', onBeforeExit);
    scheduleCheck(1000);
  });
}

async function loadRegistry(parsedArgs: ParsedArgs, requireUserContext: boolean): Promise<ToolRegistry> {
  const config = await loadCliConfig({
    configPath: parsedArgs.configPath,
    allowMissingFile: !requireUserContext,
    requireUserContext,
  });

  if (config.mcpBearerToken && !process.env.FEISHU_MCP_BEARER_TOKEN && !process.env.FEISHU_MCP_TOKEN) {
    process.env.FEISHU_MCP_BEARER_TOKEN = config.mcpBearerToken;
  }

  const shim = new CliPluginShim(config);
  registerOapiTools(shim.api);
  registerFeishuMcpDocTools(shim.api);
  registerFeishuOAuthBatchAuthTool(shim.api);

  const publicTools = new Map<string, CapturedTool>();
  const internalTools = new Map<string, CapturedTool>();

  for (const [name, tool] of shim.tools) {
    if (name === 'feishu_oauth_batch_auth') {
      internalTools.set(name, tool);
      continue;
    }
    publicTools.set(name, tool);
  }

  return { config, shim, publicTools, internalTools };
}

async function normalizeToolOutput(parsed: unknown, config: CliConfig, snapshotGrantedAt: number): Promise<void> {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;

    if (record.awaiting_authorization) {
      const authResult = await waitForAuthAndCheckToken(config, snapshotGrantedAt);
      if (authResult.completed) {
        printJson({
          ok: false,
          auth_completed: true,
          retryable: true,
          message: '用户授权已完成，token 已保存。请重新调用工具。',
        });
      } else {
        printJson({
          ok: false,
          auth_failed: true,
          message: authResult.message ?? '授权未完成',
        });
      }
      return;
    }

    if (record.awaiting_app_authorization || record.error) {
      printJson({ ok: false, ...record });
      return;
    }
  }

  printJson({ ok: true, data: parsed });
}

async function invokeTool(tool: CapturedTool, params: unknown, config: CliConfig): Promise<void> {
  const tokenSnapshot = config.userOpenId ? await getStoredToken(config.appId, config.userOpenId) : null;
  const snapshotGrantedAt = tokenSnapshot?.grantedAt ?? 0;

  const result = await runWithCliTicket(
    {
      accountId: config.accountId,
      chatId: config.chatId!,
      userOpenId: config.userOpenId,
    },
    () => tool.execute(`cli_${Date.now()}`, params),
  );

  const parsed = extractResultPayload(result);
  await normalizeToolOutput(parsed, config, snapshotGrantedAt);
}

async function runListCommand(parsedArgs: ParsedArgs): Promise<void> {
  const { publicTools } = await loadRegistry(parsedArgs, false);
  printJson([...publicTools.keys()].sort());
}

async function runDescribeCommand(parsedArgs: ParsedArgs): Promise<void> {
  const toolName = parsedArgs.positionals[1];
  if (!toolName) {
    printFatal('describe requires a tool name');
    return;
  }

  const { publicTools } = await loadRegistry(parsedArgs, false);
  const tool = publicTools.get(toolName);
  if (!tool) {
    printFatal(`Unknown tool: ${toolName}`);
    return;
  }

  printJson({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
  });
}

async function runAuthCommand(parsedArgs: ParsedArgs): Promise<void> {
  const { config, shim, internalTools } = await loadRegistry(parsedArgs, true);

  const tokenSnapshot = await getStoredToken(config.appId, config.userOpenId!);
  const snapshotGrantedAt = tokenSnapshot?.grantedAt ?? 0;

  let result: unknown;

  if (parsedArgs.scope) {
    result = await runWithCliTicket(
      {
        accountId: config.accountId,
        chatId: config.chatId!,
        userOpenId: config.userOpenId,
      },
      async () => {
        const ticket = getTicket();
        const account = getLarkAccount(shim.config, config.accountId);
        if (!account.configured) {
          return {
            details: {
              error: `账号 ${config.accountId} 缺少 appId 或 appSecret 配置`,
            },
          };
        }
        return executeAuthorize({
          account,
          senderOpenId: config.userOpenId!,
          scope: parsedArgs.scope!,
          cfg: shim.config,
          ticket,
        });
      },
    );
  } else {
    const tool = internalTools.get('feishu_oauth_batch_auth');
    if (!tool) {
      throw new Error('feishu_oauth_batch_auth is not registered');
    }

    result = await runWithCliTicket(
      {
        accountId: config.accountId,
        chatId: config.chatId!,
        userOpenId: config.userOpenId,
      },
      () => tool.execute(`cli_auth_${Date.now()}`, {}),
    );
  }

  const parsed = extractResultPayload(result);
  await normalizeToolOutput(parsed, config, snapshotGrantedAt);
}

async function runToolCommand(parsedArgs: ParsedArgs): Promise<void> {
  const toolName = parsedArgs.positionals[0];
  const rawParams = parsedArgs.positionals[1];

  if (!toolName) {
    process.stdout.write(`${formatUsage()}\n`);
    return;
  }

  if (rawParams === undefined) {
    printFatal(`Missing JSON params for tool: ${toolName}`);
    return;
  }

  let params: unknown;
  try {
    params = JSON.parse(rawParams) as unknown;
  } catch (error) {
    printFatal(`Invalid JSON params: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const { config, publicTools } = await loadRegistry(parsedArgs, true);
  const tool = publicTools.get(toolName);
  if (!tool) {
    printFatal(`Unknown tool: ${toolName}`);
    return;
  }

  await invokeTool(tool, params, config);
}

async function main(): Promise<void> {
  const parsedArgs = parseArgs(process.argv.slice(2));

  if (parsedArgs.help) {
    process.stdout.write(`${formatUsage()}\n`);
    return;
  }

  if (parsedArgs.version) {
    process.stdout.write(`${await getVersion()}\n`);
    return;
  }

  const command = parsedArgs.positionals[0];
  if (!command) {
    process.stdout.write(`${formatUsage()}\n`);
    return;
  }

  if (command === 'list') {
    await runListCommand(parsedArgs);
    return;
  }

  if (command === 'describe') {
    await runDescribeCommand(parsedArgs);
    return;
  }

  if (command === 'auth') {
    await runAuthCommand(parsedArgs);
    return;
  }

  await runToolCommand(parsedArgs);
}

main().catch((error) => {
  printFatal(error instanceof Error ? error.message : String(error));
});
