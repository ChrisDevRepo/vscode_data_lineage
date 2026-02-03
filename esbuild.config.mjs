import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const config = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify: !watch,
};

if (watch) {
  const ctx = await esbuild.context(config);
  await ctx.watch();
  console.log('Watching for extension changes...');
} else {
  await esbuild.build(config);
  console.log('Extension bundled to out/extension.js');
}
