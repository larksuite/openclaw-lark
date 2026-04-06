import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { attachWsLifecycle } from '../../src/channel/ws-lifecycle';

function createFakeClient() {
  const socket = new EventEmitter();
  const client = {
    wsConfig: {
      getWSInstance() {
        return socket;
      },
    },
    async reConnect() {
      return true;
    },
    async connect() {
      return true;
    },
    communicate() {},
  };

  return { client, socket };
}

describe('attachWsLifecycle', () => {
  it('reports connect attempts and ready transitions', async () => {
    const events: string[] = [];
    const { client } = createFakeClient();

    attachWsLifecycle(client, {
      onConnectAttempt() {
        events.push('attempt');
      },
      onReady() {
        events.push('ready');
      },
    });

    await client.reConnect();
    await client.connect();

    expect(events).toEqual(['attempt', 'ready']);
  });

  it('reports failed connect attempts', async () => {
    const events: string[] = [];
    const { client } = createFakeClient();
    client.connect = async () => false;

    attachWsLifecycle(client, {
      onConnectFailure() {
        events.push('failed');
      },
    });

    await client.connect();

    expect(events).toEqual(['failed']);
  });

  it('subscribes to socket close and error events', () => {
    const events: string[] = [];
    const { client, socket } = createFakeClient();

    attachWsLifecycle(client, {
      onClose() {
        events.push('close');
      },
      onError(err) {
        events.push(err.message);
      },
    });

    client.communicate();
    socket.emit('error', new Error('boom'));
    socket.emit('close');

    expect(events).toEqual(['boom', 'close']);
  });
});
