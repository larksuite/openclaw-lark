import type { ClawdbotConfig, OpenClawPluginApi, PluginRuntime, RuntimeLogger } from 'openclaw/plugin-sdk';
import { LarkClient } from '../src/core/lark-client';
import { buildClawdbotConfig, type CliConfig } from './config';

export interface CapturedTool {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  execute: (toolCallId: string, params: unknown) => Promise<unknown>;
}

interface ToolDefinitionLike {
  name?: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  execute: (toolCallId: string, params: unknown) => Promise<unknown>;
}

function createStdErrLogger(enabled: boolean, level: string): (message: unknown, meta?: unknown) => void {
  if (!enabled) {
    return () => {};
  }

  return (message: unknown, meta?: unknown) => {
    if (meta === undefined) {
      // eslint-disable-next-line no-console -- CLI shim logs go to stderr by design
      console.error(level, message);
      return;
    }
    // eslint-disable-next-line no-console -- CLI shim logs go to stderr by design
    console.error(level, message, meta);
  };
}

function createRuntimeLogger(subsystem?: string): RuntimeLogger {
  const prefix = subsystem ? `[${subsystem}]` : '';
  return {
    debug: (message, meta) => {
      if (!process.env.DEBUG) return;
      // eslint-disable-next-line no-console -- CLI shim logs go to stderr by design
      console.error('[DEBUG]', prefix, message, meta ?? '');
    },
    info: (message, meta) => {
      if (!process.env.VERBOSE) return;
      // eslint-disable-next-line no-console -- CLI shim logs go to stderr by design
      console.error('[INFO]', prefix, message, meta ?? '');
    },
    warn: (message, meta) => {
      // eslint-disable-next-line no-console -- CLI shim logs go to stderr by design
      console.error('[WARN]', prefix, message, meta ?? '');
    },
    error: (message, meta) => {
      // eslint-disable-next-line no-console -- CLI shim logs go to stderr by design
      console.error('[ERROR]', prefix, message, meta ?? '');
    },
  };
}

function createRuntime(): PluginRuntime {
  return {
    logging: {
      getChildLogger: ({ subsystem }: { subsystem?: string }) => createRuntimeLogger(subsystem),
    },
  } as PluginRuntime;
}

export class CliPluginShim {
  readonly tools = new Map<string, CapturedTool>();
  readonly config: ClawdbotConfig;
  readonly logger: RuntimeLogger;
  readonly runtime: PluginRuntime;

  constructor(cliConfig: CliConfig) {
    this.config = buildClawdbotConfig(cliConfig);
    this.logger = {
      debug: createStdErrLogger(Boolean(process.env.DEBUG), '[DEBUG]'),
      info: createStdErrLogger(Boolean(process.env.VERBOSE), '[INFO]'),
      warn: createStdErrLogger(true, '[WARN]'),
      error: createStdErrLogger(true, '[ERROR]'),
    };
    this.runtime = createRuntime();
    LarkClient.setRuntime(this.runtime);
  }

  get api(): OpenClawPluginApi {
    return {
      id: 'feishu-cli',
      name: 'feishu-cli',
      config: this.config,
      pluginConfig: {},
      logger: this.logger,
      runtime: this.runtime,
      registerTool: (tool: ToolDefinitionLike, options?: { name?: string }) => {
        const name = options?.name ?? tool.name;
        if (!name) {
          throw new Error('Tool registration missing name');
        }
        this.tools.set(name, {
          name,
          label: tool.label,
          description: tool.description ?? '',
          parameters: tool.parameters,
          execute: tool.execute,
        });
      },
      registerCli: () => {},
      registerChannel: () => {},
      registerCommand: () => {},
      registerContextEngine: () => {},
      registerGatewayMethod: () => {},
      registerHook: () => {},
      registerHttpRoute: () => {},
      registerProvider: () => {},
      registerService: () => {},
      resolvePath: (filePath: string) => filePath,
      on: () => {},
    } as unknown as OpenClawPluginApi;
  }
}
