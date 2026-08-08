import * as assert from 'node:assert';
import * as vscode from 'vscode';

/**
 * Drives every externally contributed read-only lineage tool through `vscode.lm.invokeTool` in a host with no chat
 * model, no Copilot, no fixture extension and no CDP.
 *
 * @remarks
 * This is the tier that makes the AI surface automatically testable rather than UAT-only. It is
 * public stable API, not a workaround: `ChatParticipantToolToken` is `never`
 * (`@types/vscode` `index.d.ts:20630`), so `undefined` is the only token an extension can
 * construct, and the typings state a tool may be invoked "globally by any extension in any custom
 * flow". `registerAiTools` declares no `confirmationMessages`
 * ({@link file://./../../src/ai/tools/toolProvider.ts} `:481`), which is what keeps the path free
 * of UI.
 *
 * Why it matters beyond coverage: only snapshot-read tools are registered with
 * `vscode.lm.registerTool`, so external callers cannot mutate the participant-owned exploration.
 * This lane exercises the same read-only entry point an agent would use.
 */
suite('Tool surface — invokeTool, no model, no CDP', () => {
  const EXTENSION_ID = 'datahelper-chwagner.data-lineage-viz';

  /** Every read-only tool contributed in `package.json` under `languageModelTools`. */
  const READ_TOOLS = [
    'lineage_get_context',
    'lineage_search_objects',
    'lineage_get_object_detail',
    'lineage_get_neighbor_columns',
    'lineage_detect_graph_patterns',
    'lineage_search_ddl',
  ];
  /** Participant-owned state mutations that must never be externally addressable. */
  const MUTATING_TOOLS = [
    'lineage_get_scope_bundle',
    'lineage_start_exploration',
    'lineage_submit_findings',
    'lineage_present_result',
  ];

  const invoke = (name: string, input: object) => vscode.lm.invokeTool(name, {
    input,
    toolInvocationToken: undefined,
  });

  const textOf = (result: vscode.LanguageModelToolResult) => result.content
    .map((part) => (part as { value?: unknown }).value ?? '')
    .join('');

  suiteSetup(async function () {
    this.timeout(90_000);
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'product extension must be present');
    await extension.activate();
    await vscode.commands.executeCommand('dataLineageViz.openDemo');

    // The demo loads through the webview, so readiness is asynchronous. Poll the tool itself
    // rather than a context key — the tool answering with data is the condition that matters.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const probe = textOf(await invoke('lineage_search_objects', { query: 'Sales' }));
      if (!/no database loaded/i.test(probe)) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.fail('demo model did not load within 60s');
  });

  test('the host is bare — a green result cannot be explained by a leaked model', async () => {
    assert.strictEqual((await vscode.lm.selectChatModels()).length, 0);
  });

  test('only the six read-only lineage tools are registered with VS Code', () => {
    const registered = new Set(vscode.lm.tools.map((tool) => tool.name));
    for (const name of READ_TOOLS) {
      assert.ok(registered.has(name), `${name} must be registered via vscode.lm.registerTool`);
    }
    for (const name of MUTATING_TOOLS) {
      assert.ok(!registered.has(name), `${name} must remain participant-owned`);
    }
  });

  test('every read tool answers with a payload', async function () {
    this.timeout(60_000);
    const inputs: Record<string, object> = {
      lineage_get_context: {},
      lineage_search_objects: { query: 'Sales' },
      lineage_get_object_detail: { node_id: '[sales].[salesorderheader]' },
      lineage_get_neighbor_columns: { node_id: '[sales].[salesorderheader]' },
      lineage_detect_graph_patterns: {},
      lineage_search_ddl: { query: 'Sales' },
    };
    for (const name of READ_TOOLS) {
      const text = textOf(await invoke(name, inputs[name]));
      assert.ok(text.length > 0, `${name} must return a non-empty payload`);
      assert.doesNotMatch(text, /no database loaded/i, `${name} must see the loaded model`);
    }
  });

});
