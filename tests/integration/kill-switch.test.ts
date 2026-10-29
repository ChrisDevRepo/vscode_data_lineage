import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { announceLaneTier } from './laneTier';

/** One disabled-AI startup journey: the core remains available and AI handlers stay absent. */
suite('AI disabled by setting — kill switch honours the manifest', () => {
  const EXTENSION_ID = 'datahelper-chwagner.data-lineage-viz';

  suiteSetup(() => {
    announceLaneTier('kill-switch', 'none',
      'activation completes with ai.enabled=false; core surface full, AI surface unregistered');
    assert.strictEqual(vscode.workspace.getConfiguration('dataLineageViz.ai').get<boolean>('enabled', true), false,
      'the fixture must seed ai.enabled=false before activation');
  });

  test('activates the core while participant and tool handlers remain disabled', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'extension must be installed in the test host');
    await extension.activate();
    assert.strictEqual(extension.isActive, true);
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
    assert.ok(!commands.includes('dataLineageViz.aiResumeNativeGate'),
      'the participant gate command must be absent when AI is disabled');
    // VS Code lists static tool contributions even when their runtime handlers are absent.
    assert.ok(vscode.lm.tools.some(tool => tool.name.startsWith('lineage_')),
      'the host must still expose the static manifest contribution');
    await assert.rejects(() => Promise.resolve(vscode.lm.invokeTool('lineage_search_objects', {
      input: { query: 'x' }, toolInvocationToken: undefined,
    })), 'invoking an unregistered handler must reject without hanging or crashing');
  });
});
