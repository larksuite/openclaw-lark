import { describe, expect, it } from 'vitest';
import { runDiagnosis } from '../src/commands/diagnose';

describe('runDiagnosis with SecretRef credentials', () => {
  it('reports the reference and skips connectivity instead of crashing', async () => {
    const report = await runDiagnosis({
      config: {
        channels: {
          feishu: {
            accounts: {
              main: {
                appId: 'cli_main',
                appSecret: { source: 'file', provider: 'filemain', id: '/feishu/main' },
              },
            },
          },
        },
      } as never,
    });

    const main = report.accounts.find((a) => a.accountId === 'main');
    const checks = Object.fromEntries((main?.checks ?? []).map((c) => [c.name, c]));
    expect(checks['凭证完整性']?.message).toBe('appId: cli_main, appSecret: SecretRef(file:filemain:/feishu/main)');
    expect(checks['API 连通性']?.status).toBe('skip');
  });
});
