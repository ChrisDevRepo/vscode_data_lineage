// Opt-in AI preview lane: shows captured results in the real webview, no model calls.
// Run through tests/tools/ai-preview-sbs.mjs, which writes DLV_AI_PREVIEW_MANIFEST.
import { defineConfig } from '@vscode/test-cli';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const profile = mkdtempSync(join(tmpdir(), 'dlv-ai-preview-'));
const cdpPort = process.env.PLAYWRIGHT_CDP_PORT || '9378';

export default defineConfig({
  version: '1.141.0',
  label: 'ai-preview',
  files: 'out/test/tests/integration/ai-preview.test.js',
  extensionDevelopmentPath: root,
  launchArgs: [
    `--user-data-dir=${profile}`,
    '--disable-extensions',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
    '--window-size=1600,1000',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${cdpPort}`,
  ],
  env: {
    DLV_AI_PREVIEW_MANIFEST: process.env.DLV_AI_PREVIEW_MANIFEST,
    PLAYWRIGHT_CDP_PORT: cdpPort,
  },
  mocha: { ui: 'tdd', failZero: true, timeout: 0, color: true },
});
