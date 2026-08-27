import { describe, expect, it } from 'vitest';
import type { ClawdbotConfig } from '../src/types/plugin-sdk-types';
import { Type } from '@sinclair/typebox';
import { feishuMessageActions } from '../src/messaging/outbound/actions';

function configuredFeishuConfig(): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        appId: 'cli_a',
        appSecret: 'secret',
      },
    },
  } as unknown as ClawdbotConfig;
}

describe('Feishu message action discovery', () => {
  it('guides send text away from duplicate streaming-card final replies', () => {
    const discovery = feishuMessageActions.describeMessageTool({
      cfg: configuredFeishuConfig(),
      currentChannelProvider: 'feishu',
    });

    expect(discovery?.actions).toContain('send');
    expect(discovery?.schema).toMatchObject({
      visibility: 'current-channel',
      properties: {
        message: {
          type: 'string',
          description: expect.stringContaining('do not call send'),
        },
        text: {
          type: 'string',
          description: expect.stringContaining('active card'),
        },
      },
    });
  });

  it('keeps send text fields optional in the composed TypeBox schema', () => {
    const discovery = feishuMessageActions.describeMessageTool({
      cfg: configuredFeishuConfig(),
      currentChannelProvider: 'feishu',
    });
    const schema = discovery?.schema;
    if (!schema || Array.isArray(schema)) {
      throw new Error('expected a single Feishu message tool schema contribution');
    }

    const composedSchema = Type.Object({
      action: Type.String(),
      ...schema.properties,
    });

    expect(composedSchema.required).toContain('action');
    expect(composedSchema.required ?? []).not.toContain('message');
    expect(composedSchema.required ?? []).not.toContain('text');
  });
});
