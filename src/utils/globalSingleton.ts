/**
 * Lazily initializes and returns a process-global singleton keyed by `key`.
 *
 * @remarks
 * The value hangs off `globalThis`, not a module local, so it survives module duplication across
 * entry points (webpack chunk, test harness, extension host can each load a module copy). Reserve
 * this for genuinely process-wide state — e.g. the AI session or the test-log buffer.
 *
 * @param key - A unique, namespaced global key (collisions silently share state).
 * @param create - Factory invoked exactly once, the first time the key is requested.
 * @returns The existing value for `key`, or the freshly created one.
 */
export function getGlobalSingleton<T>(key: string, create: () => T): T {
  const store = globalThis as typeof globalThis & Record<string, T | undefined>;
  return (store[key] ??= create());
}
