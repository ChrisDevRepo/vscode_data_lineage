/**
 * AI Eval Loop — VS Code Extension Host Test
 *
 * Starts the tool proxy on :3271, loads the AI dacpac, and keeps the
 * proxy alive for the eval-loop skill to spawn Haiku agents against.
 *
 * The proxy routes all tool calls through vscode.lm.invokeTool() —
 * hitting the REAL toolProvider.ts, real SM, real session. Zero duplication.
 *
 * Usage:
 *   npm run test:eval     (from package.json — builds, compiles, runs via vscode-test)
 *   /eval-loop            (from Claude Code — skill starts this, then spawns agents)
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { startToolProxy, type ToolProxyHandle } from './toolProxy';

suite('AI Eval Proxy', function () {
  this.timeout(300_000); // 5 min — proxy stays alive for agent interaction

  let extensionApi: any;
  let proxy: ToolProxyHandle;

  suiteSetup(async function () {
    // 1. Activate extension
    const ext = vscode.extensions.getExtension('datahelper-chwagner.data-lineage-viz');
    assert.ok(ext, 'Extension must be present');
    extensionApi = await ext.activate();
    assert.ok(extensionApi, 'Extension must return API');
    assert.ok(extensionApi.getSession, 'Extension API must expose getSession');

    // 2. Open demo first — this triggers webview → panelProvider → loadRules (parse rules get loaded)
    await vscode.commands.executeCommand('dataLineageViz.openDemo');

    // Poll for demo model loading (proves parse rules are loaded)
    const sess = extensionApi.getSession();
    let retries = 60;
    while (retries > 0 && (!sess.model || sess.model.edges.length === 0)) {
      await new Promise(resolve => setTimeout(resolve, 300));
      retries--;
    }
    assert.ok(sess.model, 'Demo model must be loaded (parse rules initialization)');
    assert.ok(sess.model.edges.length > 0, `Demo must have edges (parse rules applied), got ${sess.model.edges.length}`);
    console.log(`[eval] Demo loaded: ${sess.model.nodes.length} nodes, ${sess.model.edges.length} edges — parse rules active`);

    // 3. Replace with AI dacpac (parse rules stay loaded)
    const extPath = ext.extensionPath;
    const dacpacPath = path.join(extPath, 'tests', 'fixtures', 'AdventureWorks2025_AI.dacpac');
    assert.ok(fs.existsSync(dacpacPath), `AI dacpac must exist at ${dacpacPath}`);
    const dacpacUri = vscode.Uri.file(dacpacPath);
    await vscode.commands.executeCommand('dataLineageViz.openExternalProject', dacpacUri);

    // Poll for AI model loading
    retries = 30;
    while (retries > 0 && sess.projectName !== 'AdventureWorks2025_AI') {
      await new Promise(resolve => setTimeout(resolve, 300));
      retries--;
    }
    assert.strictEqual(sess.projectName, 'AdventureWorks2025_AI', 'AI dacpac must be loaded');
    // Verify AI schema is present AND edges exist
    const schemas = sess.model.schemas.map((s: any) => s.name);
    assert.ok(schemas.includes('ai'), `AI schema must be present, got: ${schemas.join(', ')}`);
    assert.ok(sess.model.edges.length > 0, `AI dacpac must have edges, got ${sess.model.edges.length}`);
    console.log(`[eval] AI dacpac loaded: ${sess.model.nodes.length} nodes, ${sess.model.edges.length} edges, schemas: ${schemas.join(', ')}`);

    // 4. Start tool proxy
    proxy = await startToolProxy({
      getSession: extensionApi.getSession,
      port: 3271,
    });
    console.log(`[eval] Tool proxy started on port ${proxy.port}`);
  });

  suiteTeardown(async function () {
    if (proxy) {
      await proxy.close();
      console.log('[eval] Tool proxy stopped');
    }
  });

  test('Proxy health check', async function () {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/health`);
    const data = await res.json();
    assert.strictEqual(data.status, 'ok');
    assert.ok(data.model.nodes > 0, 'Model should have nodes');
    console.log(`[eval] Health: ${data.model.nodes} nodes, ${data.model.schemas} schemas`);
  });

  test('Proxy tool list matches registered tools', async function () {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/tools`);
    const data = await res.json();
    assert.ok(Array.isArray(data.tools), 'Should return tools array');
    assert.ok(data.tools.includes('lineage_search_objects'), 'Should include search_objects');
    assert.ok(data.tools.includes('lineage_start_exploration'), 'Should include start_exploration');
    console.log(`[eval] ${data.tools.length} tools registered`);
  });

  test('Proxy prompts endpoint returns real prompts', async function () {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/prompts`);
    const data = await res.json();
    assert.ok(data.system, 'Should have system prompt');
    assert.ok(data.bb_mode, 'Should have BB mode prompt');
    assert.ok(data.ct_mode_columns, 'Should have CT columns mode prompt');
    assert.ok(data.tool_descriptions, 'Should have tool descriptions');
    console.log(`[eval] System prompt: ${data.system.length} chars`);
  });

  test('Proxy tool call works — search_objects', async function () {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'lineage_search_objects', input: { query: 'employee' } }),
    });
    const data = await res.json();
    assert.ok(data.result, 'Should have result');
    assert.ok(Array.isArray(data.result.results), 'Should return results array');
    assert.ok(data.result.results.length > 0, 'Should find employee objects');
    assert.ok(data._meta.durationMs >= 0, 'Should have timing');
    console.log(`[eval] search_objects: ${data.result.results.length} hits in ${data._meta.durationMs}ms`);
  });

  test('Proxy SM state capture — start_exploration + session state', async function () {
    this.timeout(30_000);

    // Create fresh session
    const sessRes = await fetch(`http://127.0.0.1:${proxy.port}/session`, { method: 'POST' });
    const sessData = await sessRes.json();
    assert.ok(sessData.sessionId, 'Should return sessionId');

    // Start BB exploration
    const toolRes = await fetch(`http://127.0.0.1:${proxy.port}/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'lineage_start_exploration',
        input: {
          origin: '[HumanResources].[Employee]',
          question: 'Test — list direct readers/writers',
          scope_direction: 'bidirectional',
        },
      }),
    });
    const toolData = await toolRes.json();
    assert.ok(toolData.result, 'Should have exploration result');
    assert.ok(!toolData.result.error, `Should not error: ${JSON.stringify(toolData.result.error)}`);

    // Verify SM state is accessible
    const stateRes = await fetch(`http://127.0.0.1:${proxy.port}/session/${sessData.sessionId}/state`);
    const stateData = await stateRes.json();
    assert.ok(stateData.sm_state, 'Should have SM state');
    assert.ok(stateData.sm_state.scopeSize > 0, 'Scope should be populated');
    assert.ok(stateData.hop_log.length > 0, 'hopLog should have entries');
    console.log(`[eval] SM state: scope=${stateData.sm_state.scopeSize}, hops=${stateData.sm_state.hopCount}, hopLog=${stateData.hop_log.length} entries`);

    // Verify detail is available (no "not captured" gaps)
    assert.ok(stateData.sm_state.shortMemory, 'Short memory should exist');
    assert.ok(stateData.sm_state.detailSlots, 'Detail slots should exist');
    assert.ok(stateData.sm_state.scopeNodeIds.length > 0, 'Scope node IDs should be populated');
  });

  test('Eval-bridge LM provider routes messages end-to-end', async function () {
    // Activates only when EVAL_BRIDGE_HAIKU_URL env var is set. The provider
    // forwards messages[] to that URL and replays the response. This test
    // points the bridge at a mock haiku endpoint (started externally on :4271)
    // and confirms the round-trip: model selectable, sendRequest reaches the
    // provider, mock returns canned response, participant-side stream
    // yields that response.
    if (!process.env.EVAL_BRIDGE_HAIKU_URL) {
      console.log('[eval] EVAL_BRIDGE_HAIKU_URL not set — skipping LM-provider mockup test');
      this.skip();
      return;
    }
    this.timeout(20_000);

    // 1. Provider should expose exactly one model under vendor `eval-bridge`.
    const models = await vscode.lm.selectChatModels({ vendor: 'eval-bridge' });
    assert.ok(models.length > 0, `Expected eval-bridge model registered; got 0. Selectable models: ${(await vscode.lm.selectChatModels({})).map(m => m.vendor + '/' + m.id).join(', ')}`);
    const haiku = models[0];
    assert.strictEqual(haiku.vendor, 'eval-bridge');
    assert.strictEqual(haiku.family, 'haiku');
    console.log(`[eval-bridge-test] selected model: ${haiku.vendor}/${haiku.family}/${haiku.id}`);

    // 2. Send a synthetic conversation through the provider.
    const messages = [
      vscode.LanguageModelChatMessage.User('System envelope from synthetic test'),
      vscode.LanguageModelChatMessage.User('What is the lineage of vEmployee?'),
    ];
    const resp = await haiku.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

    // 3. Drain the response stream — should contain the mock-haiku canned text.
    const collected: string[] = [];
    for await (const part of resp.stream) {
      if (part instanceof vscode.LanguageModelTextPart) collected.push(part.value);
    }
    const fullText = collected.join('');
    console.log(`[eval-bridge-test] received: ${fullText}`);
    assert.ok(fullText.includes('[mock-haiku] received'), `Expected mock-haiku canned response; got: ${fullText}`);
    assert.ok(fullText.includes('What is the lineage of vEmployee'), `Expected last user text echoed back; got: ${fullText}`);
  });

  test('Proxy server mode — wait for eval-loop agents', async function () {
    // This test keeps the proxy alive for external agents (eval-loop skill).
    // It polls for a signal file that the skill writes when done.
    // Skip in standalone mode (no EVAL_WAIT env var).
    if (!process.env.EVAL_WAIT) {
      console.log('[eval] EVAL_WAIT not set — skipping server-wait mode');
      this.skip();
      return;
    }

    this.timeout(3_600_000); // 60 min max for full eval run (allow multiple test cases sequentially)

    const ext = vscode.extensions.getExtension('datahelper-chwagner.data-lineage-viz');
    const signalFile = path.join(
      process.env.EVAL_SIGNAL_DIR ?? path.join(ext!.extensionPath, 'test-results'),
      'eval-done.signal'
    );

    console.log(`[eval] Proxy alive on :${proxy.port} — waiting for agents...`);
    console.log(`[eval] Signal file: ${signalFile}`);

    // Poll for signal file
    while (!fs.existsSync(signalFile)) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Clean up signal
    fs.unlinkSync(signalFile);
    console.log('[eval] Signal received — agents done');
  });
});
