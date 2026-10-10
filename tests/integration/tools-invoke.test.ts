import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { announceLaneTier } from './laneTier';

/**
 * Drives every externally contributed lineage tool through `vscode.lm.invokeTool` in a host with no model
 * provider fixture, and checks that the MCP kill switch is off by default with none of its code loaded.
 *
 * @remarks
 * This is the tier that makes the AI surface automatically testable rather than UAT-only. It is
 * public stable API, not a workaround: `ChatParticipantToolToken` is `never`
 * (`@types/vscode` `index.d.ts:20630`), so `undefined` is the only token an extension can
 * construct, and the typings state a tool may be invoked "globally by any extension in any custom
 * flow". `registerAiTools` ({@link file://./../../src/ai/tools/toolProvider.ts}) declares no
 * `confirmationMessages`, which is what keeps the path free of UI.
 *
 * Why it matters beyond coverage: only the `external` stage of the tool policy is registered with
 * `vscode.lm.registerTool` — reads, scope walks and AI view rendering on the session's external
 * view slot — so external callers cannot drive the participant-owned exploration. This lane
 * exercises the same entry point an agent would use.
 */
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
  /** Every contributed tool except the one render tool, which has its own cases below. */
  const READ_TOOLS = CONTRIBUTED_TOOLS.filter(name => name !== 'lineage_present_result');
  /** Hop-by-hop tools that must never be externally addressable. */
  const CHAT_ONLY_TOOLS = [
    'lineage_start_exploration',
    'lineage_submit_findings',
    'lineage_get_neighbor_columns',
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

  test('the host is bare — a green result cannot be explained by a leaked model', async () => {
    assert.strictEqual((await vscode.lm.selectChatModels()).length, 0);
  });

  test('only the contributed external lineage tools are registered with VS Code', () => {
    assert.ok(CONTRIBUTED_TOOLS.includes('lineage_present_result'), 'the manifest must contribute the render tool');
    assert.ok(READ_TOOLS.length > 0, 'the manifest must contribute read tools');
    const registered = new Set(vscode.lm.tools.map((tool) => tool.name));
    for (const name of CONTRIBUTED_TOOLS) {
      assert.ok(registered.has(name), `${name} must be registered via vscode.lm.registerTool`);
    }
    for (const name of CHAT_ONLY_TOOLS) {
      assert.ok(!registered.has(name), `${name} must remain participant-owned`);
    }
  });

  test('every read tool answers with a payload', async function () {
    this.timeout(60_000);
    const inputs: Record<string, object> = {
      lineage_get_context: {},
      lineage_get_screen_state: {},
      lineage_search_objects: { query: 'Sales' },
      lineage_get_object_detail: { id: '[sales].[salesorderheader]' },
      lineage_get_scope_bundle: { origin: '[sales].[salesorderheader]', upstream_depth: 1, downstream_depth: 0 },
      lineage_detect_graph_patterns: { type: 'hubs' },
      lineage_search_ddl: { query: 'Sales' },
    };
    for (const name of READ_TOOLS) {
      assert.ok(inputs[name], `${name} is contributed but has no input case here`);
      const text = textOf(await invoke(name, inputs[name]));
      assert.ok(text.length > 0, `${name} must return a non-empty payload`);
      assert.doesNotMatch(text, NO_PROJECT, `${name} must see the loaded model`);
    }
  });

  test('renders a walked scope by scope_id, then prunes the view by view_id', async function () {
    this.timeout(60_000);
    const origin = '[sales].[salesorderheader]';
    const bundle = JSON.parse(textOf(await invoke('lineage_get_scope_bundle', { origin, upstream_depth: 0, downstream_depth: 1 }))) as {
      origin: string; scope_id: string; nodes: Array<{ id: string }>;
    };
    assert.ok(Array.isArray(bundle.nodes), `scope bundle must list nodes: ${JSON.stringify(bundle).slice(0, 600)}`);
    const ids = bundle.nodes.map(node => node.id);
    assert.ok(ids.length >= 2, 'the demo origin must have a downstream reader');
    const render = (extra: object) => ({
      name: 'Sales order readers',
      summary: 'What reads the sales order header.',
      sections: [{ label: 'Scope', node_ids: ids, text: 'Objects one hop downstream of the order header.' }],
      highlight_groups: [{ label: 'Origin', color: 'target', node_ids: [bundle.origin] }],
      ...extra,
    });
    const first = JSON.parse(textOf(await invoke('lineage_present_result', render({ scope_id: bundle.scope_id }))));
    assert.strictEqual(first.success, true, JSON.stringify(first));
    assert.strictEqual(first.node_count, ids.length);
    assert.match(first.view_id, /^view-/);
    const leaf = ids.find(id => id !== bundle.origin)!;
    const pruned = JSON.parse(textOf(await invoke('lineage_present_result', render({
      view_id: first.view_id,
      prune_node_ids: [leaf],
      sections: [{ label: 'Scope', node_ids: ids.filter(id => id !== leaf), text: 'Without one reader.' }],
    }))));
    assert.strictEqual(pruned.success, true, JSON.stringify(pruned));
    assert.strictEqual(pruned.node_count, ids.length - 1);
  });

  test('the MCP kill switch is off by default and none of its code is loaded', async () => {
    assert.strictEqual(vscode.workspace.getConfiguration('dataLineageViz.mcp').get<boolean>('enabled'), false);
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('dataLineageViz.toggleMcpServer'), 'the kill switch command lives in the core bundle');
    assert.ok(!commands.includes('dataLineageViz.copyMcpConfig'), 'the MCP bundle must not load while the switch is off');
  });
});
