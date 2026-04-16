import * as esbuild from 'esbuild';
import { glob } from 'glob';

// All extension-host tests live under tests/e2e/ (src/test/ was legacy).
const allTestFiles = await glob('tests/e2e/**/*.ts');

/** @type {import('esbuild').BuildOptions} */
const config = {
  entryPoints: allTestFiles,
  bundle: true,
  outdir: 'out/test',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
};

await esbuild.build(config);
console.log(`Tests compiled to out/test (${allTestFiles.length} entry points)`);
