import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import plugin from '../index.ts';

describe('plugin metadata', () => {
  it('keeps manifest id and exported plugin id in sync', () => {
    const manifest = JSON.parse(
      readFileSync(resolve('openclaw.plugin.json'), 'utf8'),
    ) as { id: string };

    expect(plugin.id).toBe(manifest.id);
  });
});
