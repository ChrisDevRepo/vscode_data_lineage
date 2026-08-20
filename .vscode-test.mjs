// Extension Development Host lanes. Rationale for the lane split, what each proves, and the
// scripted-vs-real distinction live in docs/E2E_TESTING.md.
//
// Test files are the tsconfig.integration.json output under `out/test/`, not the TypeScript sources.
import { defineConfig } from '@vscode/test-cli';
import { fileURLToPath } from 'node:url';

const fixtureExtension = fileURLToPath(
  new URL('./tests/fixtures/lm-provider-extension', import.meta.url),
);

const shared = {
  version: '1.130.0',
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
    label: 'scripted-provider',
    files: 'out/test/tests/integration/scripted-provider.test.js',
    launchArgs: withFixture,
  },
  {
    ...shared,
    label: 'bare-environment',
    files: 'out/test/tests/integration/bare-environment.test.js',
    // No provider fixture, deliberately: this lane proves the extension survives a host with no
    // chat model, no Copilot and no mssql. Adding the fixture supplies a model and voids the proof.
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
    // No provider fixture, deliberately: a model in the host would make a green result
    // unattributable to `vscode.lm.invokeTool`.
    launchArgs: ['--disable-extensions'],
  },
  {
    ...shared,
    label: 'participant-turn',
    files: 'out/test/tests/integration/participant-turn.test.js',
    launchArgs: withFixture,
  },
  {
    ...shared,
    label: 'scenario-matrix',
    files: 'out/test/tests/integration/scenario-matrix.test.js',
    // The provider fixture is mandatory: the lane drives its scripted scenario matrix
    // (`lineageTestModel.setCase`) through the production LineageRuntime.
    launchArgs: withFixture,
    mocha: {
      ...shared.mocha,
      // Headroom for suite-level dacpac extraction on a cold machine and for hop counts that grow
      // with the fixture graph, while still failing a hung turn.
      timeout: 180000,
    },
  },
]);
