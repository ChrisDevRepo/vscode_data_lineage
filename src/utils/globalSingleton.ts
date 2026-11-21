/**
 * Lazily creates and returns a process-global singleton keyed by `key`, held on `globalThis` rather
 * than a module local so it survives module duplication across entry points (webpack chunk, test
 * harness, extension host). Reserve it for genuinely process-wide state, e.g. the AI session or the
 * test-log buffer.
 *
 * @param key - Unique, namespaced key; a collision silently shares state.
 * @param create - Factory invoked once, the first time the key is requested.
 */
export function getGlobalSingleton<T>(key: string, create: () => T): T {
  const store = globalThis as typeof globalThis & Record<string, T | undefined>;
  return (store[key] ??= create());
}
