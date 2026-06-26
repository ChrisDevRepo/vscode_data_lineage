import * as assert from 'assert';
import * as vscode from 'vscode';
import { getApi, EXT_ID } from './helpers/edhUtils';

// L2 — activation + command registration. Deterministic, no webview needed.
suite('Activation & command registration', () => {
  test('extension activates and exposes the expected API surface', async () => {
    const api = await getApi();
    assert.strictEqual(typeof api.getSession, 'function', 'getSession');
    assert.strictEqual(typeof api.getActivePanel, 'function', 'getActivePanel');
    assert.ok(Array.isArray(api.testLogCapture), 'testLogCapture is an array');
  });

  test('every contributed dataLineageViz.* command is registered', async () => {
    await getApi();
    const ext = vscode.extensions.getExtension(EXT_ID)!;
    const contributed: string[] = (ext.packageJSON.contributes?.commands ?? []).map((c: { command: string }) => c.command);
    assert.ok(contributed.length > 0, 'package.json contributes commands');

    const registered = await vscode.commands.getCommands(true);
    const missing = contributed.filter((c) => !registered.includes(c));
    assert.deepStrictEqual(missing, [], `commands declared but not registered: ${missing.join(', ')}`);
  });

  test('VSCODE_EX_TEST log capture is active (env wired through .vscode-test.mjs)', async () => {
    const api = await getApi();
    // Activation itself logs "[Config] Extension activated …" — proves the buffer is live.
    assert.ok(api.testLogCapture.length > 0, 'expected captured log lines after activation');
  });
});
