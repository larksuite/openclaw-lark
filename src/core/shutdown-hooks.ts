// SPDX-License-Identifier: MIT

/**
 * Process-level graceful shutdown hook registry.
 *
 * Provides a singleton Map of async cleanup callbacks, drained
 * during graceful shutdown by the channel monitor.
 */

const hooks = new Map<string, () => Promise<void>>();

/** @internal — test-only reset. */
export function _resetShutdownHooks(): void {
  hooks.clear();
}

/**
 * Register a cleanup callback to run during graceful shutdown.
 *
 * @param key - Unique identifier for this hook (duplicate keys overwrite).
 * @param cleanup - Async function to execute on shutdown.
 * @returns An unregister function — call it when the resource is
 *          released normally (e.g. card streaming completes).
 */
export function registerShutdownHook(key: string, cleanup: () => Promise<void>): () => void {
  hooks.set(key, cleanup);
  return () => {
    hooks.delete(key);
  };
}

/**
 * Drain all registered shutdown hooks (best-effort, bounded by deadline).
 *
 * @param opts - Optional configuration.
 * @param opts.deadlineMs - Maximum time to wait for all hooks (default 5000).
 * @param opts.log - Logger function for progress/error output.
 */
export async function drainShutdownHooks(opts?: {
  deadlineMs?: number;
  log?: (...args: unknown[]) => void;
}): Promise<void> {
  if (hooks.size === 0) return;

  const log = opts?.log;
  const deadline = opts?.deadlineMs ?? 5000;

  log?.(`graceful shutdown: draining ${hooks.size} cleanup hook(s)`);

  const entries = Array.from(hooks.entries());
  hooks.clear();

  const promises = entries.map(async ([key, cleanup]) => {
    try {
      await cleanup();
      log?.(`graceful shutdown: hook "${key}" done`);
    } catch (err) {
      log?.(`graceful shutdown: hook "${key}" failed: ${String(err)}`);
    }
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deadline);
  });

  await Promise.race([Promise.allSettled(promises).then(() => clearTimeout(timer)), timeoutPromise]);
}
