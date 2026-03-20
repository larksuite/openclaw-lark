import test from 'node:test';
import assert from 'node:assert/strict';

import { getFeishuHelp, registerCommands } from '../src/commands/index.ts';

type RegisteredCommand = {
  acceptsArgs: boolean;
  description: string;
  handler: (ctx: { args?: string; config: object }) => Promise<{ text: string }>;
  name: string;
  requireAuth: boolean;
};

function collectCommands(): Map<string, RegisteredCommand> {
  const commands = new Map<string, RegisteredCommand>();

  registerCommands({
    registerCommand(command: RegisteredCommand) {
      commands.set(command.name, command);
    },
  } as never);

  return commands;
}

test('registerCommands adds auth alias and keeps auth flows aligned', async () => {
  const commands = collectCommands();

  assert.ok(commands.has('auth'));
  assert.ok(commands.has('feishu_auth'));
  assert.ok(commands.has('feishu'));

  const authResult = await commands.get('auth')!.handler({ config: {} });
  const feishuAuthResult = await commands.get('feishu_auth')!.handler({ config: {} });
  const feishuSubcommandResult = await commands.get('feishu')!.handler({ args: 'auth', config: {} });

  assert.deepEqual(authResult, feishuAuthResult);
  assert.deepEqual(authResult, feishuSubcommandResult);
});

test('help text documents the /auth alias', () => {
  assert.match(getFeishuHelp('zh_cn'), /\/auth - 批量授权用户权限/);
  assert.match(getFeishuHelp('en_us'), /\/auth - Batch authorize user permissions/);
});
