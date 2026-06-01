import { test, vi } from 'vitest';

test('snapshot-aw-baseline.ts --update', async () => {
  const originalArgv = [...process.argv];
  process.argv = [...originalArgv.filter(arg => arg !== '--update'), '--update'];

  try {
    vi.resetModules();
    await import(new URL('../snapshot-aw-baseline.ts', import.meta.url).href);
  } finally {
    process.argv = originalArgv;
  }
});
