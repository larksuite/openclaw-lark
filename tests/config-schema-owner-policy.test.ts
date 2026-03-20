import test from 'node:test';
import assert from 'node:assert/strict';

import { FeishuConfigSchema } from '../src/core/config-schema.ts';

test('FeishuConfigSchema preserves ownerPolicy when set to multiUser', () => {
  const parsed = FeishuConfigSchema.parse({
    appId: 'cli_a',
    appSecret: 'secret',
    ownerPolicy: 'multiUser',
  });

  assert.equal(parsed.ownerPolicy, 'multiUser');
});

test('FeishuConfigSchema accepts strict as a valid ownerPolicy', () => {
  const parsed = FeishuConfigSchema.parse({
    appId: 'cli_a',
    appSecret: 'secret',
    ownerPolicy: 'strict',
  });

  assert.equal(parsed.ownerPolicy, 'strict');
});
