import { defineConfig } from '@vscode/test-cli';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTestEnv } from './tests/tools/load-test-env.mjs';

const identity = loadTestEnv({ requireAiProvider: true });
if (process.env.AI_TEST_BASELINE !== undefined && !['0', '1'].includes(process.env.AI_TEST_BASELINE)) {
  throw new Error('AI_TEST_BASELINE must be 0 or 1.');
}
if (process.env.AI_TEST_BASELINE === '1' && !process.env.AI_TEST_BRANCH?.trim()) {
  throw new Error('AI_TEST_BASELINE=1 requires AI_TEST_BRANCH.');
}
for (const key of ['LANGFUSE_BASE_URL', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY']) {
  if (!process.env[key]?.trim()) throw new Error(`Set ${key} before a real-provider VS Code smoke.`);
}
process.env.AI_TEST_REAL_PROVIDER = '1';
console.log(`[ai-smoke] configured provider=${identity.provider} model=${identity.model}`);

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
  launchArgs: [root, `--user-data-dir=${profile}`, '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--log=debug'],
  env: { DLV_AI_SMOKE_PROFILE: profile },
  mocha: { ui: 'tdd', failZero: true, timeout: Number(process.env.AI_TEST_TIMEOUT_MS) + 60_000, color: true },
});
