#!/usr/bin/env node

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const cliDir = path.dirname(fileURLToPath(import.meta.url));
const generatedDir = path.join(cliDir, '.generated');
const entryPoint = path.join(cliDir, 'index.ts');
const outFile = path.join(generatedDir, 'index.mjs');

await mkdir(generatedDir, { recursive: true });

await build({
  entryPoints: [entryPoint],
  outfile: outFile,
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: ['node20'],
  sourcemap: 'inline',
  logLevel: 'silent',
});

await import(`${pathToFileURL(outFile).href}?t=${Date.now()}`);
