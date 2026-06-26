import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getApi, waitFor } from './helpers/edhUtils';

// Compiled location: <repo>/out/test/integration → ../../../ = <repo>.
const BASELINE = path.resolve(__dirname, '../../../tests/fixtures/engine-parity-baseline.json');

// The parity gate: the engine battery, computed inside the REAL bundled extension
// from the same demo dacpac, must byte-match the golden baseline that the unit
// layer (tests/unit/engine-parity.test.ts) asserts. A unit-pass + electron-fail
// here = an integration/bundling/extraction regression. No GUI, no screenshots.
suite('Engine parity (electron) — same backend output as the unit baseline', () => {
  test('engineReport from the real EDH byte-matches the committed golden baseline', async function () {
    this.timeout(60000);

    const api = await getApi();
    await vscode.commands.executeCommand('dataLineageViz.openDemo');
    await waitFor(() => api.getSession().model, 45000);

    // The gated test command returns the deterministic report (registered only
    // under VSCODE_EX_TEST, which .vscode-test.mjs sets).
    const report = await vscode.commands.executeCommand('dataLineageViz.__test.engineReport');
    assert.ok(report, '__test.engineReport must return a report (is VSCODE_EX_TEST set?)');

    const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf-8'));
    assert.strictEqual(
      JSON.stringify(report),
      JSON.stringify(baseline),
      'electron engine report must byte-match the golden baseline (unit↔electron parity)',
    );
  });
});
