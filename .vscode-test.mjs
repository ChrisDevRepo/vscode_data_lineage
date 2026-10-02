// Extension Development Host smoke lanes and their limits are documented in docs/EDH_TESTING.md.
//
// Test files are the tsconfig.integration.json output under `out/test/`, not the TypeScript sources.
import { defineConfig } from '@vscode/test-cli';
import { fileURLToPath } from 'node:url';

const fixtureExtension = fileURLToPath(
  new URL('./tests/fixtures/lm-provider-extension', import.meta.url),
);

const shared = {
  version: 'stable',
  launchArgs: ['--disable-extensions'],
  mocha: {
    ui: 'tdd',
    timeout: 60000,
    color: true,
  },
};

const withFixture = ['--disable-extensions', `--extensionDevelopmentPath=${fixtureExtension}`];

const killSwitchUserData = fileURLToPath(
  new URL('./tests/fixtures/kill-switch-user-data', import.meta.url),
);

export default defineConfig([
  {
    ...shared,
    label: 'bare-environment',
    files: 'out/test/tests/integration/bare-environment.test.js',
    // No model provider fixture or database extension is installed in this lane.
    launchArgs: ['--disable-extensions'],
  },
  {
    ...shared,
    label: 'kill-switch',
    files: 'out/test/tests/integration/kill-switch.test.js',
    // No provider fixture and a seeded user-data-dir: the lane proves the ai.enabled=false branch
    // as a real user reaches it — settings on disk before activation, not flipped at runtime.
    launchArgs: ['--disable-extensions', `--user-data-dir=${killSwitchUserData}`],
  },
  {
    ...shared,
    label: 'tools',
    files: 'out/test/tests/integration/tools-invoke.test.js',
    // No provider fixture: a model in the host would make this result unattributable to
    // `vscode.lm.invokeTool`.
    launchArgs: ['--disable-extensions'],
  },
  {
    ...shared,
    label: 'participant-turn',
    files: 'out/test/tests/integration/participant-turn.test.js',
    launchArgs: withFixture,
  },
]);
