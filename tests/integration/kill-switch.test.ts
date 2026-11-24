import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { announceLaneTier } from './laneTier';

/**
 * Proves the `dataLineageViz.ai.enabled` kill switch: with the setting off, activation completes,
 * the core product registers in full, and the AI runtime (the lineage runtime behind the chat
 * panel) is genuinely not created rather than merely hidden.
 *
 * @remarks
 * The lane launches with a seeded `--user-data-dir` whose user settings carry
 * `"dataLineageViz.ai.enabled": false`, so the branch under test is the one a real user reaches
 * from the Settings UI.
 */
suite('AI disabled by setting — kill switch honours the manifest', () => {
  const EXTENSION_ID = 'datahelper-chwagner.data-lineage-viz';

  suiteSetup(() => { announceLaneTier(
    'kill-switch',
    'none',
    'activation completes with ai.enabled=false; core surface full, AI surface unregistered',
  ); });

  test('the seeded setting is actually in force', () => {
    const enabled = vscode.workspace.getConfiguration('dataLineageViz.ai').get<boolean>('enabled', true);
    assert.strictEqual(enabled, false, 'the lane must run with dataLineageViz.ai.enabled=false, or it proves nothing');
  });

  test('activation completes and reports no error', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'extension is installed in the test host');
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });

  test('the CORE product is fully registered with AI off', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'dataLineageViz.open',
      'dataLineageViz.openDemo',
      'dataLineageViz.refresh',
      'dataLineageViz.openSettings',
      'dataLineageViz.searchObjects',
    ]) {
      assert.ok(commands.includes(id), `core command ${id} must register when AI is disabled`);
    }
  });

  test('the AI runtime is not created', async () => {
    // `activateRuntime` returns `lineageRuntime` only when `ai.enabled` is true, so with the switch
    // off it is the observable proof that the chat controller and its runtime were not loaded.
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'extension is installed in the test host');
    const exported = await ext.activate() as { lineageRuntime?: unknown };
    assert.strictEqual(exported.lineageRuntime, undefined, 'ai.enabled=false must not construct the lineage runtime');
  });
});
