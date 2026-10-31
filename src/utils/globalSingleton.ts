/** Lazily initializes and returns a process-global singleton keyed by `key`. */
export function getGlobalSingleton<T>(key: string, create: () => T): T {
  const store = globalThis as typeof globalThis & Record<string, T | undefined>;
  return (store[key] ??= create());
}
