import { AsyncLocalStorage } from 'node:async_hooks';

export interface AuthResumeTarget {
  agentId: string;
  sessionKey: string;
  accountId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  threadId?: string;
}

const store = new AsyncLocalStorage<AuthResumeTarget>();

export function withAuthResumeTarget<T>(target: AuthResumeTarget, fn: () => T | Promise<T>): T | Promise<T> {
  return store.run(target, fn);
}

export function getAuthResumeTarget(): AuthResumeTarget | undefined {
  return store.getStore();
}
