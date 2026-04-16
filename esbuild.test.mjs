import * as esbuild from 'esbuild';
import { glob } from 'glob';

// Compile both existing src/test/ and new tests/e2e/ files
const srcTestFiles = await glob('src/test/**/*.test.ts');
const e2eTestFiles = await glob('tests/e2e/**/*.ts');
const allTestFiles = [...srcTestFiles, ...e2eTestFiles];

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
