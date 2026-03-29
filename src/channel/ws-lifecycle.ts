/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Attach lightweight lifecycle callbacks to the Feishu SDK WS client.
 *
 * The upstream SDK handles reconnects internally but does not expose a
 * high-level readiness lifecycle to plugin code. This helper wraps the
 * relevant internal methods so the channel monitor can observe:
 * - connect attempt start
 * - successful readiness
 * - connect failures before ready
 * - socket close and error events
 */

export interface FeishuWsLifecycle {
  onConnectAttempt?: () => void;
  onReady?: () => void;
  onConnectFailure?: () => void;
  onClose?: () => void;
  onError?: (err: Error) => void;
}

interface SocketLike {
  on?: (event: 'close' | 'error', listener: (...args: unknown[]) => void) => unknown;
}

interface WsClientWithInternals {
  reConnect?: (...args: unknown[]) => Promise<unknown>;
  connect?: (...args: unknown[]) => Promise<boolean>;
  communicate?: (...args: unknown[]) => unknown;
  wsConfig?: {
    getWSInstance?: () => SocketLike | null | undefined;
  };
}

export function attachWsLifecycle<T>(wsClient: T, lifecycle: FeishuWsLifecycle = {}): T {
  if (!wsClient || typeof wsClient !== "object") {
    return wsClient;
  }

  const client = wsClient as WsClientWithInternals;
  const attachedSockets = new WeakSet<object>();

  const attachSocketListeners = (): void => {
    const socket = client.wsConfig?.getWSInstance?.();
    if (!socket || typeof socket !== 'object' || attachedSockets.has(socket)) {
      return;
    }

    attachedSockets.add(socket);
    socket.on?.('close', () => {
      lifecycle.onClose?.();
    });
    socket.on?.('error', (err) => {
      lifecycle.onError?.(err instanceof Error ? err : new Error(String(err)));
    });
  };

  if (typeof client.reConnect === 'function') {
    const originalReConnect = client.reConnect.bind(client);
    client.reConnect = async (...args: unknown[]) => {
      lifecycle.onConnectAttempt?.();
      return await originalReConnect(...args);
    };
  }

  if (typeof client.connect === 'function') {
    const originalConnect = client.connect.bind(client);
    client.connect = async (...args: unknown[]) => {
      const ok = await originalConnect(...args);
      if (ok) {
        lifecycle.onReady?.();
      } else {
        lifecycle.onConnectFailure?.();
      }
      return ok;
    };
  }

  if (typeof client.communicate === 'function') {
    const originalCommunicate = client.communicate.bind(client);
    client.communicate = (...args: unknown[]) => {
      const result = originalCommunicate(...args);
      attachSocketListeners();
      return result;
    };
  }

  return wsClient;
}
