import { defineConfig } from '@vscode/test-cli';
import { fileURLToPath } from 'node:url';
import { loadTestEnv } from './tests/tools/load-test-env.mjs';

const identity = loadTestEnv({ requireAiProvider: true });
process.env.AI_TEST_REAL_PROVIDER = '1';
console.log(`[ai-smoke] configured provider=${identity.provider} model=${identity.model}`);

const fixtureExtension = fileURLToPath(
  new URL('./tests/fixtures/lm-provider-extension', import.meta.url),
);

export default defineConfig({
  version: 'stable',
  label: 'ai-smoke',
  files: 'out/test/tests/integration/ai-smoke.test.js',
  launchArgs: ['--disable-extensions', `--extensionDevelopmentPath=${fixtureExtension}`],
  mocha: { ui: 'tdd', timeout: 300_000, color: true },
});
