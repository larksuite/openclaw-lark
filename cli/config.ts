import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { ClawdbotConfig } from 'openclaw/plugin-sdk';

export interface CliConfig {
  appId: string;
  appSecret: string;
  domain: string;
  userOpenId?: string;
  chatId?: string;
  mcpEndpoint?: string;
  mcpBearerToken?: string;
  accountId: string;
}

interface LoadCliConfigOptions {
  configPath?: string;
  allowMissingFile?: boolean;
  requireUserContext?: boolean;
}

interface PartialCliConfig {
  appId?: string;
  appSecret?: string;
  domain?: string;
  userOpenId?: string;
  chatId?: string;
  mcpEndpoint?: string;
  mcpBearerToken?: string;
  accountId?: string;
}

const DEFAULT_ACCOUNT_ID = 'default';
const DEFAULT_CONFIG_PATH = resolve(homedir(), '.feishu-cli.json');

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseConfigFile(raw: string, filePath: string): PartialCliConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in config file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Config file ${filePath} must contain a JSON object`);
  }

  const record = parsed as Record<string, unknown>;
  return {
    appId: normalizeNonEmptyString(record.appId),
    appSecret: normalizeNonEmptyString(record.appSecret),
    domain: normalizeNonEmptyString(record.domain),
    userOpenId: normalizeNonEmptyString(record.userOpenId),
    chatId: normalizeNonEmptyString(record.chatId),
    mcpEndpoint: normalizeNonEmptyString(record.mcpEndpoint) ?? normalizeNonEmptyString(record.mcp_url),
    mcpBearerToken:
      normalizeNonEmptyString(record.mcpBearerToken) ?? normalizeNonEmptyString(record.mcp_token),
    accountId: normalizeNonEmptyString(record.accountId),
  };
}

function readEnvConfig(): PartialCliConfig {
  return {
    appId: normalizeNonEmptyString(process.env.FEISHU_APP_ID),
    appSecret: normalizeNonEmptyString(process.env.FEISHU_APP_SECRET),
    domain: normalizeNonEmptyString(process.env.FEISHU_DOMAIN),
    userOpenId: normalizeNonEmptyString(process.env.FEISHU_USER_OPEN_ID),
    chatId: normalizeNonEmptyString(process.env.FEISHU_CHAT_ID),
    mcpEndpoint: normalizeNonEmptyString(process.env.FEISHU_MCP_ENDPOINT),
    mcpBearerToken:
      normalizeNonEmptyString(process.env.FEISHU_MCP_BEARER_TOKEN) ?? normalizeNonEmptyString(process.env.FEISHU_MCP_TOKEN),
    accountId: normalizeNonEmptyString(process.env.FEISHU_ACCOUNT_ID),
  };
}

function buildPlaceholderConfig(): CliConfig {
  return {
    appId: 'cli_placeholder_app',
    appSecret: 'cli_placeholder_secret',
    domain: 'feishu',
    accountId: DEFAULT_ACCOUNT_ID,
  };
}

export async function loadCliConfig(options: LoadCliConfigOptions = {}): Promise<CliConfig> {
  const { configPath, allowMissingFile = false, requireUserContext = true } = options;
  const filePath = resolve(configPath ?? DEFAULT_CONFIG_PATH);

  let fileConfig: PartialCliConfig = {};
  try {
    const raw = await readFile(filePath, 'utf8');
    fileConfig = parseConfigFile(raw, filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'ENOENT') {
      throw error;
    }
    if (!allowMissingFile) {
      throw new Error(`Config not found: ${filePath}`);
    }
  }

  const envConfig = readEnvConfig();
  const merged = {
    ...fileConfig,
    ...Object.fromEntries(Object.entries(envConfig).filter(([, value]) => value !== undefined)),
  } as PartialCliConfig;

  if (!merged.appId) {
    if (allowMissingFile) return buildPlaceholderConfig();
    throw new Error('appId is required');
  }

  if (!merged.appSecret) {
    throw new Error('appSecret is required');
  }

  if (requireUserContext && !merged.userOpenId) {
    throw new Error('userOpenId is required');
  }

  if (requireUserContext && !merged.chatId) {
    throw new Error('chatId is required');
  }

  return {
    appId: merged.appId,
    appSecret: merged.appSecret,
    domain: merged.domain ?? 'feishu',
    userOpenId: merged.userOpenId,
    chatId: merged.chatId,
    mcpEndpoint: merged.mcpEndpoint,
    mcpBearerToken: merged.mcpBearerToken,
    accountId: merged.accountId ?? DEFAULT_ACCOUNT_ID,
  };
}

export function buildClawdbotConfig(cliConfig: CliConfig): ClawdbotConfig {
  const feishuConfig: Record<string, unknown> = {
    appId: cliConfig.appId,
    appSecret: cliConfig.appSecret,
    domain: cliConfig.domain,
    enabled: true,
  };

  if (cliConfig.mcpEndpoint) {
    feishuConfig.mcpEndpoint = cliConfig.mcpEndpoint;
  }

  return {
    channels: {
      feishu: feishuConfig,
    },
    plugins: {
      entries: {},
    },
  } as ClawdbotConfig;
}

export function getDefaultConfigPath(): string {
  return DEFAULT_CONFIG_PATH;
}
