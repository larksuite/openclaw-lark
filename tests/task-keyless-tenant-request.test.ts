import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  client: undefined as any,
  tools: {} as Record<string, any>,
}));

vi.mock('../src/tools/oapi/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tools/oapi/helpers')>();
  return {
    ...actual,
    createToolContext: () => ({
      toolClient: () => state.client,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }),
    registerTool: (_api: unknown, tool: { name: string }) => {
      state.tools[tool.name] = tool;
      return true;
    },
  };
});

import { registerFeishuTaskAttachmentTool } from '../src/tools/oapi/task/attachment';
import { registerFeishuTaskTaskTool } from '../src/tools/oapi/task/task';
import { registerFeishuTaskAgentTool } from '../src/tools/oapi/task/task_agent';

describe('Task tenant requests use the SDK token chain', () => {
  let invoke: ReturnType<typeof vi.fn>;
  let request: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    state.tools = {};
    request = vi.fn().mockResolvedValue({ code: 0, data: { ok: true } });
    invoke = vi.fn(async (_action: string, fn: (sdk: unknown) => Promise<unknown>, _opts: unknown) => fn({ request }));
    state.client = { invoke };

    const api = { config: {}, logger: {}, registerTool: vi.fn() } as any;
    registerFeishuTaskAttachmentTool(api);
    registerFeishuTaskTaskTool(api);
    registerFeishuTaskAgentTool(api);
  });

  it('uploads attachments through client.invoke and sdk.request', async () => {
    await state.tools.feishu_task_attachment.execute('call-1', {
      action: 'upload',
      resource_id: 'task-1',
      resource_type: 'task',
      file: Buffer.from('hello').toString('base64'),
      name: 'hello.txt',
    });

    expect(invoke).toHaveBeenCalledWith('feishu_task_attachment.upload', expect.any(Function), { as: 'tenant' });
    expect(request).toHaveBeenCalledOnce();
    const payload = request.mock.calls[0][0];
    expect(payload).toMatchObject({
      method: 'POST',
      url: '/open-apis/task/v2/attachments/upload',
    });
    expect(payload.headers).toBeUndefined();
    expect(payload.data).toBeInstanceOf(FormData);
    expect(payload.data.get('resource_id')).toBe('task-1');
  });

  it('appends task steps through client.invoke and sdk.request', async () => {
    await state.tools.feishu_task_task.execute('call-2', {
      action: 'append_steps',
      task_guid: 'task-guid',
      idempotent_key: 'idem-1',
      task_steps: [{ summary: 'step-1' }],
    });

    expect(invoke).toHaveBeenCalledWith('feishu_task_task.append_steps', expect.any(Function), { as: 'tenant' });
    expect(request).toHaveBeenCalledWith({
      method: 'POST',
      url: '/open-apis/task/v2/agent_task_step_info/append_task_steps',
      data: {
        task_guid: 'task-guid',
        idempotent_key: 'idem-1',
        task_steps: [{ summary: 'step-1' }],
      },
    });
  });

  it('registers and updates a task agent through tenant SDK requests', async () => {
    await state.tools.feishu_task_agent.execute('call-3', { action: 'register' });
    await state.tools.feishu_task_agent.execute('call-4', {
      action: 'update_profile',
      profile_content: 'profile',
    });

    expect(invoke).toHaveBeenNthCalledWith(1, 'feishu_task_agent.register', expect.any(Function), { as: 'tenant' });
    expect(invoke).toHaveBeenNthCalledWith(2, 'feishu_task_agent.update_profile', expect.any(Function), {
      as: 'tenant',
    });
    expect(request).toHaveBeenNthCalledWith(1, {
      method: 'POST',
      url: '/open-apis/task/v2/agent/register_agent',
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      method: 'POST',
      url: '/open-apis/task/v2/agent/update_agent_profile',
      data: { profile_content: 'profile' },
    });
  });
});
