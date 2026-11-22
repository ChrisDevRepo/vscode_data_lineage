import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';

const watch = process.argv.includes('--watch');

/**
 * Build stamp derived from source, never from wall-clock time.
 *
 * A wall-clock `new Date()` makes every build byte-different, so the shipped
 * artifact can never be re-verified: two builds of identical source would differ,
 * making build-to-build jitter indistinguishable from a real change. Honour
 * SOURCE_DATE_EPOCH (the reproducible-builds convention) and otherwise fall back
 * to the HEAD commit date, so identical source produces an identical bundle.
 */
function resolveBuildTimestamp() {
  const fromEnv = process.env.SOURCE_DATE_EPOCH;
  if (fromEnv && /^\d+$/.test(fromEnv)) {
    return new Date(Number(fromEnv) * 1000).toISOString();
  }
  try {
    const committed = execFileSync('git', ['log', '-1', '--format=%ct'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (/^\d+$/.test(committed)) {
      return new Date(Number(committed) * 1000).toISOString();
    }
  } catch {
    // No git available (e.g. a source tarball) — fall through.
  }
  // Last resort only: reproducibility is lost, which the stamp itself makes visible.
  return `nonreproducible:${new Date().toISOString()}`;
}

/**
 * LangSmith gateway exclusion. `@langchain/core` >=1.3.4 ships `dist/utils/gateway.js`, whose
 * `DEFAULT_LANGSMITH_GATEWAY` points at a LangSmith host and is only used when the
 * `LANGSMITH_GATEWAY` env var is set (consumed by provider packages this repo does not install);
 * `load/import_map.js` pulls it into every bundle. The `stubs/langsmith` npm override cannot cover
 * it (it is core's own module), so the module is replaced at bundle time, same containment:
 * no LangSmith endpoint in the shipped bundle, and `LANGSMITH_GATEWAY` is ignored. The stub keeps
 * the module's no-gateway behavior (`baseURL` passthrough, never a gateway URL or key).
 * `tests/tools/assert-no-langsmith.mjs` stays the fail-closed gate if this stops matching.
 */
const excludeLangSmithGatewayPlugin = {
  name: 'exclude-langsmith-gateway',
  setup(build) {
    build.onLoad({ filter: /[\\/]@langchain[\\/]core[\\/]dist[\\/]utils[\\/]gateway\.c?js$/ }, () => ({
      contents: [
        'function resolveLangSmithGatewayConfig({ baseURL }) {',
        '  return baseURL === undefined ? {} : { baseURL };',
        '}',
        'const gateway_exports = { resolveLangSmithGatewayConfig };',
        'export { gateway_exports, resolveLangSmithGatewayConfig };',
      ].join('\n'),
      loader: 'js',
    }));
  },
};

/** @type {import('esbuild').BuildOptions} */
const sharedConfig = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  // Tied to `engines.vscode` (^1.101.0): node22 is the oldest runtime this extension can be
  // installed on. Raising `engines.vscode` may allow a newer target; lowering it requires
  // lowering this first.
  target: 'node22',
  sourcemap: true,
  minify: !watch,
  charset: 'utf8',
  plugins: [excludeLangSmithGatewayPlugin],
  legalComments: 'external',
  define: {
    '__BUILD_TIMESTAMP__': JSON.stringify(resolveBuildTimestamp()),
  },
};

const deferredRuntimePlugin = {
  name: 'deferred-extension-runtime',
  setup(build) {
    build.onResolve({ filter: /^\.\/extensionRuntime\.js$/ }, ({ path }) => ({ path, external: true }));
  },
};

const configs = [
  { ...sharedConfig, entryPoints: ['./src/ai/support/regexSearch.worker.ts'], outfile: 'out/regexSearch.worker.js' },
  {
    ...sharedConfig,
    entryPoints: ['./src/extension.ts'],
    outfile: 'out/extension.js',
    external: ['vscode'],
    plugins: [excludeLangSmithGatewayPlugin, deferredRuntimePlugin],
  },
  {
    ...sharedConfig,
    entryPoints: ['./src/extensionRuntime.ts'],
    outfile: 'out/extensionRuntime.js',
    external: ['vscode'],
  },
];

if (watch) {
  const contexts = [];
  for (const config of configs) contexts.push(await esbuild.context(config));
  for (const context of contexts) await context.watch();
  console.log('Watching for extension changes...');
} else {
  for (const config of configs) await esbuild.build(config);
  console.log('Extension bundled to out/extension.js and out/extensionRuntime.js');
}
