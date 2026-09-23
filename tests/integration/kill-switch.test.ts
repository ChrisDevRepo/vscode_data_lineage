import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { announceLaneTier } from './laneTier';

/**
 * Proves the `dataLineageViz.ai.enabled` kill switch: with the setting off, activation completes,
 * the core product registers in full, and the AI surface — participant commands and language-model
 * tools — is genuinely not registered rather than merely hidden.
 *
 * @remarks
 * The lane launches with a seeded `--user-data-dir` whose user settings carry
 * `"dataLineageViz.ai.enabled": false`, so the branch under test is the one a real user reaches
 * from the Settings UI. What the chat picker *shows* for a contributed-but-unregistered
 * participant is host UI, unreachable from this API surface, and stays with the manual matrix.
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

  test('the participant surface is not registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      !commands.includes('dataLineageViz.aiResumeNativeGate'),
      'the participant gate command must be absent when ai.enabled=false',
    );
  });

  test('contributed tools stay listed from the manifest, but invoking one fails cleanly', async () => {
    // `vscode.lm.tools` reflects the static `languageModelTools` contribution, not runtime
    // registration — the listing survives the kill switch by host design. The enforced contract
    // is therefore at invocation: no handler is registered, so the call rejects and nothing hangs.
    const lineageTools = vscode.lm.tools.filter(t => t.name.startsWith('lineage_'));
    assert.ok(
      lineageTools.length > 0,
      'the manifest contribution should keep the tools listed; an empty list means the host semantics changed and the FEATURES.md wording must be revisited',
    );
    await assert.rejects(
      () => Promise.resolve(vscode.lm.invokeTool('lineage_search_objects', {
        input: { query: 'x' },
        toolInvocationToken: undefined,
      })),
      'invoking an unregistered tool must reject, never hang or crash the host',
    );
  });
});
