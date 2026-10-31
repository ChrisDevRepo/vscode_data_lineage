import { defineConfig } from '@vscode/test-cli';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTestEnv } from './tests/tools/load-test-env.mjs';

const identity = loadTestEnv({ requireAiProvider: true });
process.env.AI_TEST_REAL_PROVIDER = '1';
console.log(
  `[ai-smoke] configured provider=${identity.provider} model=${identity.model}`,
);

const fixtureExtension = fileURLToPath(
  new URL('./tests/fixtures/lm-provider-extension', import.meta.url),
);

const root = fileURLToPath(new URL('.', import.meta.url));
const profile = mkdtempSync(join(tmpdir(), 'dlv-ai-smoke-'));

export default defineConfig({
  version: 'stable',
  label: 'ai-smoke',
  files: 'out/test/tests/integration/ai-smoke.test.js',
  extensionDevelopmentPath: [root, fixtureExtension],
  launchArgs: [
    root,
    `--user-data-dir=${profile}`,
    '--disable-extensions',
    '--skip-welcome',
    '--skip-release-notes',
    '--log=debug',
  ],
  env: { DLV_AI_SMOKE_PROFILE: profile },
  mocha: {
    ui: 'tdd',
    failZero: true,
    timeout: Number(process.env.AI_TEST_TIMEOUT_MS) + 60_000,
    color: true,
  },
});
