import * as esbuild from 'esbuild';
import { glob } from 'glob';

const testFiles = await glob('src/test/**/*.test.ts');

/** @type {import('esbuild').BuildOptions} */
const config = {
  entryPoints: testFiles,
  bundle: true,
  outdir: 'out/test',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
};

await esbuild.build(config);
console.log('Tests compiled to out/test');
