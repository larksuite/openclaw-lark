#!/usr/bin/env node

import { execFileSync } from "node:child_process";

// --tools-version <ver> lets the user pin a specific version
const args = process.argv.slice(2);
let version = "latest";

const vIdx = args.indexOf("--tools-version");
if (vIdx !== -1) {
  version = args[vIdx + 1];
  // Remove --tools-version <ver> from forwarded args
  args.splice(vIdx, 2);
}

try {
  execFileSync(
    "npx",
    ["--yes", `@larksuite/openclaw-lark-tools@${version}`, ...args],
    { stdio: "inherit" },
  );
} catch (error) {
  process.exit(error.status ?? 1);
}

