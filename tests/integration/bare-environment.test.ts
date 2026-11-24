import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { announceLaneTier } from './laneTier';

/**
 * Proves the extension survives a host with NO optional integrations present.
 *
 * @remarks
 * The demo DACPAC → graph flow must keep working when optional model and database integrations are
 * unavailable. An activation failure would also prevent core commands and views from registering.
 *
 * This lane launches with extensions disabled and supplies no language-model fixture. Its
 * assertions verify the absent integrations instead of assuming they are absent. It proves
 * activation completes and the core surface is live in a bare host; the containment for a failing
 * AI block is the `try/catch` around it in `src/extension.ts`.
 */
suite('Bare environment — no model entry or database extension', () => {
  const EXTENSION_ID = 'datahelper-chwagner.data-lineage-viz';

  suiteSetup(() => { announceLaneTier(
    'bare-environment',
    'none',
    'activation completes and the core command surface registers with every optional integration absent',
  ); });

  test('no chat model is available, and asking for one does not throw', async () => {
    const models = await vscode.lm.selectChatModels();
    assert.strictEqual(
      models.length,
      0,
      'a bare host must expose zero chat models; a non-empty result means a provider leaked in',
    );
  });

  test('activation completes and reports no error', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'extension must be present in the Extension Development Host');

    // `activate()` must resolve rather than reject; an optional AI surface failure would surface
    // here.
    await extension.activate();
    assert.strictEqual(extension.isActive, true, 'extension must be active in a bare host');
  });

  test('the CORE product is fully registered despite every integration being absent', async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
    const commands = await vscode.commands.getCommands(true);

    // Core lineage commands depend on neither AI nor a database. `openDemo` is the strongest: it
    // loads a bundled `.dacpac` and renders the graph with no external dependency.
    for (const command of [
      'dataLineageViz.open',
      'dataLineageViz.openDemo',
      'dataLineageViz.refresh',
      'dataLineageViz.createParseRules',
      'dataLineageViz.createDmvQueries',
    ]) {
      assert.ok(
        commands.includes(command),
        `core command ${command} must be registered in a bare host`,
      );
    }
  });

  test('the AI surface degrades without taking the extension down', async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
    const commands = await vscode.commands.getCommands(true);

    assert.ok(
      commands.includes('dataLineageViz.enableAiTraceLogging'),
      'the session-scoped AI trace command must be registered without a model provider',
    );

    assert.ok(
      ['addAiModel', 'editAiModel', 'removeAiModel', 'updateAiModelKey', 'manageAiModels'].every((name) => commands.includes(`dataLineageViz.${name}`)),
      'the AI model commands must be registered without a model entry or key',
    );
  });
});
