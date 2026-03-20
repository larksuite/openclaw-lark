import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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

test('owner-policy keeps the multiUser guard ahead of owner lookup', () => {
  const source = readFileSync(new URL('../src/core/owner-policy.ts', import.meta.url), 'utf8');

  const multiUserGuardIndex = source.indexOf("if (getOwnerPolicyMode(account) === 'multiUser')");
  const ownerLookupIndex = source.indexOf('const ownerOpenId = await getAppOwnerFallback');

  assert.notEqual(multiUserGuardIndex, -1);
  assert.notEqual(ownerLookupIndex, -1);
  assert.ok(multiUserGuardIndex < ownerLookupIndex);
});

test('onboarding-auth branches on ownerPolicy for multi-user OAuth', () => {
  const source = readFileSync(new URL('../src/tools/onboarding-auth.ts', import.meta.url), 'utf8');

  assert.match(source, /if \(getOwnerPolicyMode\(acct\) === 'strict'\)/);
  assert.match(source, /ownerPolicy=multiUser, user \$\{userOpenId\} starting OAuth/);
});
