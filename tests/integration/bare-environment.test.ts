import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { announceLaneTier } from './laneTier';

/** One bare-host startup journey; optional integrations cannot prevent core activation. */
suite('Bare environment — no chat model', () => {
  const EXTENSION_ID = 'datahelper-chwagner.data-lineage-viz';

  suiteSetup(async () => {
    announceLaneTier('bare-environment', 'none',
      'activation completes and the core command surface registers with every optional integration absent');
    assert.strictEqual((await vscode.lm.selectChatModels()).length, 0,
      'the bare host must have no leaked model provider');
  });

  test('activates the core and AI command surfaces without optional integrations', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'extension must be present in the Extension Development Host');
    await extension.activate();
    assert.strictEqual(extension.isActive, true, 'activation must succeed in the bare host');
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      'dataLineageViz.open',
      'dataLineageViz.openDemo',
      'dataLineageViz.refresh',
      'dataLineageViz.createParseRules',
      'dataLineageViz.createDmvQueries',
    ]) {
      assert.ok(commands.includes(command), `core command ${command} must register in a bare host`);
    }
    assert.ok(commands.includes('dataLineageViz.enableAiTraceLogging'),
      'the AI trace command must register without a model provider');
    assert.ok(commands.includes('dataLineageViz.aiResumeNativeGate'),
      'the participant must register without a model provider');
  });
});
