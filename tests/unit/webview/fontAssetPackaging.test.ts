import { expect, it } from 'vitest';
import { build, loadConfigFromFile } from 'vite';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { buildWebviewCsp } from '../../../src/utils/cspBuilder';

it('packages KaTeX fonts as files compatible with the strict webview font policy', async () => {
  const config = await loadConfigFromFile({ command: 'build', mode: 'production' }, resolve('vite.config.ts'));
  expect(config).not.toBeNull();
  const outDir = await mkdtemp(join(tmpdir(), 'dlv-font-package-'));
  try {
    await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        outDir,
        assetsInlineLimit: config!.config.build?.assetsInlineLimit,
        rollupOptions: {
          input: resolve('node_modules/katex/dist/katex.css'),
          output: { assetFileNames: '[name][extname]' },
        },
      },
    });
    const files = await readdir(outDir);
    const css = await readFile(join(outDir, files.find(file => file.endsWith('.css'))!), 'utf8');
    expect(/url\([^)]*data:/.test(css)).toBe(false);
    expect(files).toContain('KaTeX_Size3-Regular.woff2');
    expect(css).toMatch(/url\([^)]*KaTeX_Size3-Regular\.woff2/);
    expect(buildWebviewCsp({ nonce: 'fixture', cspSource: 'https://webview.example' }))
      .toContain('font-src https://webview.example;');
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
