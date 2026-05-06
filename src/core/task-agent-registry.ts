// SPDX-License-Identifier: MIT

/**
 * In-memory registry tracking which Feishu accounts have had their
 * task agent registered recently. Prevents redundant `register` API
 * calls across sessions.
 *
 * Uses atomic insert-if-not-exists semantics mirroring the SDK's
 * `registerIfAbsent` on `PluginStateKeyedStore`. When the SDK
 * `plugin-state` module becomes available, this store can be upgraded
 * to SQLite-backed persistence via `createPluginStateKeyedStore`.
 */

const registeredAccounts = new Map<string, { registeredAt: number; expiresAt: number }>();

const REGISTRATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Atomically mark an account as having its task agent registered.
 *
 * @returns `true` if the account was newly registered (i.e. not
 *          already present or expired). `false` if already registered
 *          within the TTL window.
 */
export function tryMarkTaskAgentRegistered(accountId: string): boolean {
  const existing = registeredAccounts.get(accountId);
  if (existing && Date.now() < existing.expiresAt) {
    return false;
  }
  registeredAccounts.set(accountId, {
    registeredAt: Date.now(),
    expiresAt: Date.now() + REGISTRATION_TTL_MS,
  });
  return true;
}

/**
 * Check whether a task agent has been registered for this account
 * within the TTL window. Expired entries are lazily evicted.
 */
export function isTaskAgentRegistered(accountId: string): boolean {
  const entry = registeredAccounts.get(accountId);
  if (!entry) return false;
  if (Date.now() >= entry.expiresAt) {
    registeredAccounts.delete(accountId);
    return false;
  }
  return true;
}

/** Clear all registry entries. */
export function clearTaskAgentRegistry(): void {
  registeredAccounts.clear();
}

/** @internal — test-only reset. */
export function _resetForTesting(): void {
  registeredAccounts.clear();
}
