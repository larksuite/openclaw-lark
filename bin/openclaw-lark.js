#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const FORK_PLUGIN_ID = 'openclaw-lark-realguan';
const DEFAULT_NPM_SPEC = '@realguan/openclaw-lark';
const ORIGINAL_PLUGIN_IDS = ['openclaw-lark', 'feishu'];

function printHelp() {
  console.log(`
openclaw-lark-realguan <command> [options]

Commands:
  install [path-or-spec]   Install fork plugin (default: ${DEFAULT_NPM_SPEC})
  update [path-or-spec]    Update fork plugin (or reinstall from path/spec)
  uninstall                Uninstall fork plugin
  enable                   Enable fork plugin and disable official Feishu plugins
  disable                  Disable fork plugin
  status                   Show fork/original plugin status
  help                     Show this help

Compatibility:
  --tools-version <ver> is accepted and ignored (kept for old scripts).
  Unknown commands are forwarded to: openclaw plugins <command> ...
`.trim());
}

function normalizeArgs(argv) {
  const args = [...argv];
  const vIdx = args.indexOf('--tools-version');
  if (vIdx !== -1) {
    args.splice(vIdx, 2);
  }
  return args;
}

function isOption(value) {
  return value.startsWith('-');
}

function isPathLike(value) {
  return value.startsWith('.') || value.startsWith('/') || value.startsWith('~');
}

function runOpenclaw(args, opts = {}) {
  const { allowFailure = false, stdio = 'inherit' } = opts;
  try {
    execFileSync(process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw', args, { stdio });
    return true;
  } catch (error) {
    if (allowFailure) return false;
    process.exit(error.status ?? 1);
  }
}

function disableOriginalPlugins() {
  for (const pluginId of ORIGINAL_PLUGIN_IDS) {
    runOpenclaw(['plugins', 'disable', pluginId], { allowFailure: true });
  }
}

function normalizeNoRestartFlag(rest) {
  const next = [];
  let noRestart = false;
  for (const arg of rest) {
    if (arg === '--no-restart') {
      noRestart = true;
      continue;
    }
    next.push(arg);
  }
  return { args: next, noRestart };
}

function postInstallSetup({ restart }) {
  disableOriginalPlugins();
  runOpenclaw(['plugins', 'enable', FORK_PLUGIN_ID], { allowFailure: true });
  if (restart) {
    runOpenclaw(['gateway', 'restart'], { allowFailure: true });
  }
}

function installCommand(rest) {
  const { args, noRestart } = normalizeNoRestartFlag(rest);
  const forwarded = [];
  let spec;

  for (const arg of args) {
    if (arg === '--link' || arg === '--pin') {
      forwarded.push(arg);
      continue;
    }
    if (!isOption(arg) && !spec) {
      spec = arg;
      continue;
    }
    forwarded.push(arg);
  }

  const installSpec = spec ?? DEFAULT_NPM_SPEC;
  if (forwarded.includes('--link') && !isPathLike(installSpec)) {
    console.warn(`[openclaw-lark-realguan] ignoring --link for non-local spec: ${installSpec}`);
    const index = forwarded.indexOf('--link');
    forwarded.splice(index, 1);
  }

  runOpenclaw(['plugins', 'install', installSpec, ...forwarded]);
  postInstallSetup({ restart: !noRestart });
}

function updateCommand(rest) {
  const { args, noRestart } = normalizeNoRestartFlag(rest);
  const positional = args.find((arg) => !isOption(arg));
  if (positional) {
    installCommand(args);
    return;
  }

  if (args.includes('--all')) {
    runOpenclaw(['plugins', 'update', '--all', ...args.filter((arg) => arg !== '--all')]);
  } else {
    runOpenclaw(['plugins', 'update', FORK_PLUGIN_ID, ...args]);
  }
  postInstallSetup({ restart: !noRestart });
}

function uninstallCommand(rest) {
  const { args, noRestart } = normalizeNoRestartFlag(rest);
  const forwarded = args.includes('--force') ? [...args] : ['--force', ...args];
  runOpenclaw(['plugins', 'uninstall', FORK_PLUGIN_ID, ...forwarded]);
  if (!noRestart) {
    runOpenclaw(['gateway', 'restart'], { allowFailure: true });
  }
}

function enableCommand(rest) {
  const { args, noRestart } = normalizeNoRestartFlag(rest);
  disableOriginalPlugins();
  runOpenclaw(['plugins', 'enable', FORK_PLUGIN_ID, ...args]);
  if (!noRestart) {
    runOpenclaw(['gateway', 'restart'], { allowFailure: true });
  }
}

function disableCommand(rest) {
  const { args, noRestart } = normalizeNoRestartFlag(rest);
  runOpenclaw(['plugins', 'disable', FORK_PLUGIN_ID, ...args]);
  if (!noRestart) {
    runOpenclaw(['gateway', 'restart'], { allowFailure: true });
  }
}

function statusCommand() {
  runOpenclaw(['config', 'get', 'plugins.entries', '--json']);
}

const args = normalizeArgs(process.argv.slice(2));
const [command = 'help', ...rest] = args;

switch (command) {
  case 'help':
  case '--help':
  case '-h':
    printHelp();
    break;
  case 'install':
    installCommand(rest);
    break;
  case 'update':
    updateCommand(rest);
    break;
  case 'uninstall':
    uninstallCommand(rest);
    break;
  case 'enable':
    enableCommand(rest);
    break;
  case 'disable':
    disableCommand(rest);
    break;
  case 'status':
    statusCommand();
    break;
  default:
    runOpenclaw(['plugins', command, ...rest]);
    break;
}
