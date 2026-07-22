import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FEISHU_OAUTH_BATCH_AUTH_DESCRIPTION } from '../src/tools/oauth-batch-auth';

describe('lark-cli authorization routing contract', () => {
  it('keeps explicit CLI requests away from the plugin batch OAuth tool', () => {
    expect(FEISHU_OAUTH_BATCH_AUTH_DESCRIPTION).toContain('lark-cli');
    expect(FEISHU_OAUTH_BATCH_AUTH_DESCRIPTION).toContain('严禁调用');
    expect(FEISHU_OAUTH_BATCH_AUTH_DESCRIPTION).toContain('exec');
  });

  it('keeps plugin OAuth distinct and keyless-capable', () => {
    expect(FEISHU_OAUTH_BATCH_AUTH_DESCRIPTION).toContain('插件自身的 keyless 用户授权');
    expect(FEISHU_OAUTH_BATCH_AUTH_DESCRIPTION).toContain('不要求配置 app secret');
  });

  it('keeps the CLI routing rule in the always-active Feishu skill', () => {
    const skill = readFileSync(join(process.cwd(), 'skills/feishu-channel-rules/SKILL.md'), 'utf8');

    expect(skill).toContain('alwaysActive: true');
    expect(skill).toContain('Never replace an explicit CLI authentication request');
    expect(skill).toContain('lark-cli auth login --recommend --no-wait --json');
    expect(skill).toContain('lark-cli auth login --domain all --no-wait --json');
  });
});
