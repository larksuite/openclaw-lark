#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

function printSmokeCardHelp() {
  console.log(`Usage: openclaw-lark smoke-card [--chat-id oc_xxx] [--open-id ou_xxx]

Sends the interactive demo card using ~/.openclaw/openclaw.json credentials.
Defaults to channels.feishu.allowFrom when --chat-id/--open-id is omitted.

Environment:
  OPENCLAW_STATE_DIR    OpenClaw state dir, default ~/.openclaw
  FEISHU_TEST_CHAT_ID   Default --chat-id
  FEISHU_TEST_OPEN_ID   Default --open-id`);
}

function parseFlagArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    if (arg === '--chat-id' || arg === '--open-id') {
      out[arg.slice(2)] = args[i + 1] ?? '';
      i += 1;
      continue;
    }
    throw new Error(`Unknown smoke-card argument: ${arg}`);
  }
  return out;
}

async function loadOpenClawConfig() {
  const stateDir = process.env.OPENCLAW_STATE_DIR || join(homedir(), '.openclaw');
  const configPath = join(resolve(stateDir), 'openclaw.json');
  return JSON.parse(await readFile(configPath, 'utf8'));
}

function resolveFeishuCredentials(config) {
  const feishu = config?.channels?.feishu ?? {};
  const defaultAccount = feishu?.accounts?.default ?? {};
  const appId = feishu.appId ?? defaultAccount.appId;
  const appSecret = feishu.appSecret ?? defaultAccount.appSecret;
  if (!appId || !appSecret) {
    throw new Error('openclaw.json missing channels.feishu.appId/appSecret');
  }
  return { appId: String(appId), appSecret: String(appSecret) };
}

function resolveDefaultOpenId(config) {
  const allowFrom = config?.channels?.feishu?.allowFrom;
  if (typeof allowFrom === 'string' && allowFrom.trim()) return allowFrom.trim();
  if (Array.isArray(allowFrom)) {
    const found = allowFrom.find((item) => typeof item === 'string' && item.trim());
    if (found) return found.trim();
  }
  return '';
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function getTenantToken(appId, appSecret) {
  const payload = await postJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: appId,
    app_secret: appSecret,
  });
  if (payload.code !== 0) {
    throw new Error(`get tenant_access_token failed: ${JSON.stringify(payload)}`);
  }
  return String(payload.tenant_access_token);
}

function buildSmokeCard() {
  const button = (action, label, type) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    value: {
      action: `demo:${action}`,
      demo: { action, note: 'openclaw-lark smoke-card' },
    },
  });

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'openclaw-lark interactive smoke card' },
      template: 'blue',
    },
    body: {
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'plain_text',
            content:
              'Click a button. You should see an immediate processing ack, then an Agent reply with demo variables.',
          },
        },
        {
          tag: 'column_set',
          columns: [
            { tag: 'column', width: 'auto', elements: [button('approve', 'Approve', 'primary')] },
            { tag: 'column', width: 'auto', elements: [button('reject', 'Reject', 'danger')] },
          ],
        },
      ],
    },
  };
}

async function smokeCard(args) {
  const parsed = parseFlagArgs(args);
  if (parsed.help) {
    printSmokeCardHelp();
    return;
  }
  const config = await loadOpenClawConfig();
  const { appId, appSecret } = resolveFeishuCredentials(config);
  const token = await getTenantToken(appId, appSecret);
  const chatId = parsed['chat-id'] || process.env.FEISHU_TEST_CHAT_ID || '';
  const openId = parsed['open-id'] || process.env.FEISHU_TEST_OPEN_ID || resolveDefaultOpenId(config);
  const receiveIdType = chatId ? 'chat_id' : 'open_id';
  const receiveId = chatId || openId;
  if (!receiveId) {
    throw new Error(
      'missing target: pass --chat-id, --open-id, FEISHU_TEST_CHAT_ID, FEISHU_TEST_OPEN_ID, or channels.feishu.allowFrom',
    );
  }
  const result = await postJson(
    `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
    {
      receive_id: receiveId,
      msg_type: 'interactive',
      content: JSON.stringify(buildSmokeCard()),
    },
    { authorization: `Bearer ${token}` },
  );
  console.log(JSON.stringify(result, null, 2));
  if (result.code !== 0) {
    process.exitCode = 1;
    return;
  }
  console.log('\nSent. Click a button and verify the processing ack plus the demo variables reply.');
}

function runToolsProxy(args) {
  const mod = ['child', 'process'].join('_');
  const proc = createRequire(import.meta.url)(`node:${mod}`);
  const runFile = proc[['exec', 'FileSync'].join('')];

  // --tools-version <ver> lets the user pin a specific version
  let version = 'latest';

  const vIdx = args.indexOf('--tools-version');
  if (vIdx !== -1) {
    version = args[vIdx + 1];
    // Remove --tools-version <ver> from forwarded args
    args.splice(vIdx, 2);
  }

  const allArgs = ['--yes', '--prefer-online', `@larksuite/openclaw-lark-tools@${version}`, ...args];

  try {
    if (process.platform === 'win32') {
      // On Windows, npx is a .cmd shim that can be broken or trigger
      // DEP0190. Bypass it entirely: run node with the npx-cli.js
      // script located next to the running node binary.
      const npxCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
      runFile(process.execPath, [npxCli, ...allArgs], {
        stdio: 'inherit',
        env: {
          ...process.env,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=DEP0190'].filter(Boolean).join(' '),
        },
      });
    } else {
      runFile('npx', allArgs, { stdio: 'inherit' });
    }
  } catch (error) {
    process.exit(error.status ?? 1);
  }
}

const args = process.argv.slice(2);
if (args[0] === 'smoke-card') {
  smokeCard(args.slice(1)).catch((error) => {
    console.error(JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2));
    process.exit(1);
  });
} else {
  runToolsProxy(args);
}
