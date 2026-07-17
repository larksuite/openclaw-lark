#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const sourceManifestPath = join(__dirname, '..', 'openclaw.plugin.json');
const homeDir = process.env.USERPROFILE || process.env.HOME;
const defaultTargetManifestPath = homeDir
  ? join(homeDir, '.openclaw', 'extensions', 'openclaw-lark', 'openclaw.plugin.json')
  : null;

function fail(message, code = 1) {
  console.error(`[openclaw-lark-fix-contracts] ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const result = {
    restart: true,
    target: defaultTargetManifestPath,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--no-restart') {
      result.restart = false;
      continue;
    }

    if (arg === '--path') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        fail('missing value for --path');
      }
      result.target = value;
      i += 1;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      console.log(`Usage:
  openclaw-lark-fix-contracts [--path <manifest-path>] [--no-restart]

Options:
  --path <manifest-path>  Target openclaw.plugin.json to patch.
  --no-restart            Do not run \`openclaw gateway restart\` after patching.
`);
      process.exit(0);
    }

    fail(`unknown argument: ${arg}`);
  }

  if (!result.target) {
    fail('cannot resolve default target path; set HOME/USERPROFILE or pass --path');
  }

  return result;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`failed to read JSON at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function writeJson(path, value) {
  try {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } catch (err) {
    fail(`failed to write JSON at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const args = parseArgs(process.argv.slice(2));
const sourceManifest = readJson(sourceManifestPath);
const contractsTools = sourceManifest?.contracts?.tools;

if (!Array.isArray(contractsTools) || contractsTools.length === 0) {
  fail(`source manifest has no contracts.tools: ${sourceManifestPath}`);
}

const targetManifest = readJson(args.target);
targetManifest.contracts = targetManifest.contracts || {};
targetManifest.contracts.tools = contractsTools;
writeJson(args.target, targetManifest);

console.log(`[openclaw-lark-fix-contracts] patched contracts.tools in: ${args.target}`);

if (args.restart) {
  const restart = spawnSync('openclaw', ['gateway', 'restart'], {
    stdio: 'inherit',
  });

  if (restart.error) {
    fail(`failed to restart gateway: ${restart.error.message}`);
  }

  if (typeof restart.status === 'number' && restart.status !== 0) {
    fail(`gateway restart exited with code ${restart.status}`);
  }
}
