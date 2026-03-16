#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const toolsPkg = dirname(require.resolve("@larksuite/openclaw-lark-tools/package.json"));
const bin = join(toolsPkg, "dist", "index.js");

execFileSync(process.execPath, [bin, ...process.argv.slice(2)], {
  stdio: "inherit",
});
