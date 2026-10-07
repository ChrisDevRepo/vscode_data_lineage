/** Executes the real compiled search worker in Vitest, without depending on a prior extension build. */
import { afterAll, vi } from 'vitest';

vi.mock('node:worker_threads', async importOriginal => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  const { build } = await import('esbuild');
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const directory = await mkdtemp(join(tmpdir(), 'lineage-regex-worker-'));
  const workerFile = join(directory, 'regexSearch.worker.js');
  afterAll(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(directory, { recursive: true, force: true });
  });
  await build({
    entryPoints: [fileURLToPath(new URL('../../src/ai/support/regexSearch.worker.ts', import.meta.url))],
    outfile: workerFile, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  });
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        super(typeof filename === 'string' && /[\\/]regexSearch\.worker\.js$/.test(filename) ? workerFile : filename, options);
      }
    },
  };
});
