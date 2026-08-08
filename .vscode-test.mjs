import { defineConfig } from '@vscode/test-cli';
import { fileURLToPath } from 'node:url';

const fixtureExtension = fileURLToPath(
  new URL('./tests/fixtures/lm-provider-extension', import.meta.url),
);

const shared = {
  version: '1.130.0',
  launchArgs: ['--disable-extensions'],
  env: {
    VSCODE_EX_TEST: '1',
  },
  mocha: {
    ui: 'tdd',
    timeout: 60000,
    color: true,
  },
};

// Official VS Code integration-test runner. Tests run inside a real Extension Development Host
// with the full `vscode` API — the only tier that can prove anything about activation, the
// contributed command surface, or `vscode.lm` registration.
// `VSCODE_EX_TEST` enables the in-memory `testLogCapture` log buffer (utils/log.ts).
//
// Every lane uses public, stable VS Code API only. No `--remote-debugging-port`, no CDP, no
// internal `workbench.action.*` command, and no undocumented environment switch: `participant-turn`
// drives the participant through `activate()`'s exported `participant` handle instead.
export default defineConfig([
  {
    ...shared,
    label: 'ai-backend',
    // tsconfig.integration.json compiles production imports under the repository
    // root so TS6059 cannot reject test-to-source imports.
    files: 'out/test/tests/integration/ai-backend.test.js',
    launchArgs: [
      '--disable-extensions',
      `--extensionDevelopmentPath=${fixtureExtension}`,
    ],
  },
  {
    ...shared,
    label: 'bare-environment',
    files: 'out/test/tests/integration/bare-environment.test.js',
    // Deliberately NO `--extensionDevelopmentPath` for the language-model provider fixture: this
    // lane exists to prove the extension survives a host with no chat model, no Copilot and no
    // mssql. Adding the fixture here would silently supply a model and void the whole proof.
    launchArgs: ['--disable-extensions'],
  },
  {
    ...shared,
    label: 'tools',
    files: 'out/test/tests/integration/tools-invoke.test.js',
    // Also deliberately NO fixture: the point of this lane is that the whole lineage tool surface
    // is exercisable through `vscode.lm.invokeTool` with no model in the host at all. Supplying a
    // model here would make a green result unattributable.
    launchArgs: ['--disable-extensions'],
  },
  {
    ...shared,
    label: 'participant-turn',
    files: 'out/test/tests/integration/participant-turn.test.js',
    launchArgs: [
      '--disable-extensions',
      `--extensionDevelopmentPath=${fixtureExtension}`,
    ],
  },
  {
    ...shared,
    label: 'scenario-matrix',
    files: 'out/test/tests/integration/scenario-matrix.test.js',
    // The provider fixture is mandatory here: this lane exists to drive the fixture's scripted
    // T1-T7 scenario matrix (`lineageTestModel.setCase`) through the production LineageRuntime.
    launchArgs: [
      '--disable-extensions',
      `--extensionDevelopmentPath=${fixtureExtension}`,
    ],
    // A SEPARATE label rather than more cases inside `ai-backend`, for two reasons — neither of
    // which is runtime. Measured, the whole suite is ~3s of assertions inside the usual multi-second
    // host boot, so folding it into `ai-backend` would cost that lane almost nothing in wall time.
    // What it WOULD cost is the diagnostic: `ai-backend` answers "is the selected-model adapter and
    // canonical dispatcher intact", a fast structural question, while this lane answers "does a full
    // approve-gate → multi-hop → synthesis loop over the real AdventureWorks dacpac still agree with
    // structural ground truth". A red run means very different things, and merging them would lose
    // the ability to say which. Second, this lane is run ON DEMAND — it is deliberately outside
    // `npm run gate` (see tests/tools/gate.mjs's NOT-covered footer) — so it needs its own name to
    // be invokable on its own.
    mocha: {
      ...shared.mocha,
      // Per-TEST, not per-suite, and pure headroom rather than a measured need: the slowest case
      // today (T6) finishes in well under a second. The generous budget covers the two things that
      // legitimately scale here and that the shared 60s does not — the suite-level dacpac extraction
      // on a cold/slow machine, and T6/T7's hop count growing with the fixture graph — while still
      // failing a genuinely hung turn rather than stalling the lane indefinitely.
      timeout: 180000,
    },
  },
]);
