import { defineConfig } from '@vscode/test-cli';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REQUIRED_AI_KEYS, loadTestEnv } from './tests/tools/load-test-env.mjs';

// Without the AI_TEST_* names the smoke test skips and says so; with them they are validated here.
loadTestEnv();
const configured = ['AI_TEST_PROVIDER', ...REQUIRED_AI_KEYS].every((name) =>
  process.env[name]?.trim(),
);
if (configured) {
  const identity = loadTestEnv({ requireAiProvider: true });
  console.log(
    `[ai-smoke] configured provider=${identity.provider} model=${identity.model}`,
  );
}

const root = fileURLToPath(new URL('.', import.meta.url));
const profile = mkdtempSync(join(tmpdir(), 'dlv-ai-smoke-'));

export default defineConfig({
  version: 'stable',
  label: 'ai-smoke',
  files: 'out/test/tests/integration/ai-smoke.test.js',
  extensionDevelopmentPath: root,
  launchArgs: [
    root,
    `--user-data-dir=${profile}`,
    '--skip-welcome',
    '--skip-release-notes',
    '--log=debug',
  ],
  env: { DLV_AI_SMOKE_PROFILE: profile },
  mocha: {
    ui: 'tdd',
    failZero: true,
    timeout: Number(process.env.AI_TEST_TIMEOUT_MS ?? 0) + 60_000,
    color: true,
  },
});
