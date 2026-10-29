import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { announceLaneTier } from './laneTier';

/** Drives every externally contributed lineage tool through `vscode.lm.invokeTool` in a host with no model provider fixture. */
suite('Tool surface — invokeTool, no model, no CDP', () => {
  const EXTENSION_ID = 'datahelper-chwagner.data-lineage-viz';

  suiteSetup(() => { announceLaneTier(
    'tools',
    'none',
    'every contributed external lineage tool is registered with vscode.lm and answers through invokeTool',
  ); });

  /** The tools contributed in the installed extension's manifest under `languageModelTools`. */
  const CONTRIBUTED_TOOLS = (vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON.contributes.languageModelTools as Array<{ name: string }> | undefined ?? [])
    .map(tool => tool.name);
  /** The existing read-only tools contributed for other VS Code agents. */
  const READ_TOOLS = CONTRIBUTED_TOOLS;
  /** Mutating and scope tools that remain participant-owned. */
  const CHAT_ONLY_TOOLS = [
    'lineage_start_exploration',
    'lineage_submit_findings',
    'lineage_prune_current',
    'lineage_get_scope_bundle',
    'lineage_present_result',
  ];

  /** The rejection every tool throws before the demo model has loaded. */
  const NO_PROJECT = /no project is loaded/i;

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
    assert.strictEqual((await vscode.lm.selectChatModels()).length, 0,
      'the tool host must have no leaked model provider');
    await vscode.commands.executeCommand('dataLineageViz.openDemo');

    // The demo loads through the webview, so readiness is asynchronous. Poll the tool itself
    // rather than a context key — the tool answering with data is the condition that matters.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      // A rejection reaches a vscode.lm caller as a thrown error; only the no-project one means "not yet".
      const loaded = await invoke('lineage_search_objects', { query: 'Sales' }).then(() => true, (error: unknown) => {
        if (error instanceof Error && NO_PROJECT.test(error.message)) return false;
        throw error;
      });
      if (loaded) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.fail('demo model did not load within 60s');
  });

  test('only public read tools are exposed and answer through actual invocation', async function () {
    this.timeout(60_000);
    assert.ok(READ_TOOLS.length > 0, 'the manifest must contribute public read tools');
    const exposed = new Set(vscode.lm.tools.map(tool => tool.name));
    for (const name of CHAT_ONLY_TOOLS) {
      assert.ok(!exposed.has(name), `${name} must remain participant-owned`);
    }
    const inputs: Record<string, object> = {
      lineage_get_context: {},
      lineage_get_screen_state: {},
      lineage_search_objects: { query: 'Sales' },
      lineage_get_object_detail: { id: '[sales].[salesorderheader]' },
      lineage_get_neighbor_columns: { ids: ['[sales].[salesorderheader]'] },
      lineage_detect_graph_patterns: { type: 'hubs' },
      lineage_search_ddl: { query: 'Sales' },
    };
    for (const name of READ_TOOLS) {
      assert.ok(inputs[name], `${name} is contributed but has no input case here`);
      if (name === 'lineage_get_neighbor_columns') {
        await assert.rejects(async () => invoke(name, inputs[name]), (error: unknown) => {
          assert.ok(error instanceof Error);
          const problem = JSON.parse(error.message) as { code: string; guidance: Array<{ errors: unknown[] }>; resend: string[] };
          assert.strictEqual(problem.code, 'no_active_session');
          assert.ok(problem.guidance.some(group => group.errors.length > 0));
          assert.deepStrictEqual(problem.resend, []);
          return true;
        });
        continue;
      }
      const text = textOf(await invoke(name, inputs[name]));
      assert.ok(text.length > 0, `${name} must return a non-empty payload`);
      assert.doesNotMatch(text, NO_PROJECT, `${name} must see the loaded model`);
    }
  });

});
