import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { defineConfig } from 'tsdown';

// Read the package version without `import` attributes (keeps tsconfig
// `module: ES2022` compatible).
const __pkgDir = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(__pkgDir, 'package.json'), 'utf8'),
) as { version: string };

export default defineConfig({
  entry: {
    index: 'index.ts',
    'secret-contract-api': 'secret-contract-api.ts',
  },
  format: 'esm',
  target: 'node22',
  platform: 'node',
  clean: true,
  outDir: 'dist',
  dts: true,
  // Inject the package version as a build-time constant so `src/core/version.ts`
  // does not need to read `package.json` at runtime via `import.meta.url`.
  // See the long comment at the top of `src/core/version.ts` for why a literal
  // `import.meta` token in source breaks any downstream CJS compile under Node 22+.
  define: {
    __PLUGIN_VERSION__: JSON.stringify(pkg.version),
  },
  deps: {
    neverBundle: [
      /^openclaw(\/.*)?$/,
      /^@larksuiteoapi\//,
      /^@sinclair\//,
      'image-size',
      'zod',
      /^node:/,
    ],
  },
});
