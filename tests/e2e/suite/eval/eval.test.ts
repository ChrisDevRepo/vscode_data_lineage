/**
 * AI Eval — VS Code Extension Host Test (Bridge architecture).
 *
 * No tool-execution proxy. The production `@lineage` chat participant runs
 * unmodified inside vscode-tester; its `request.model.sendRequest` calls
 * are intercepted by `evalLmProvider` (registered when EVAL_BRIDGE_HAIKU_URL
 * env var is set), which forwards `messages[]` to an external Haiku endpoint
 * and replays the response. Pure transport — no message rebuilding, no
 * agent-driving loop on the bridge side.
 *
 * Usage:
 *   1. Start the Haiku endpoint (handshake mode by default, or DIRECT mode
 *      if ANTHROPIC_API_KEY is set):
 *        python tests/eval/haiku-server.py 4271
 *   2. Set env vars and run the test:
 *        EVAL_BRIDGE_HAIKU_URL=http://127.0.0.1:4271 \
 *        EVAL_AUTONOMOUS_QUESTION="<the user question>" \
 *        npm run test:eval
 *   3. (Handshake mode only) An orchestrator polls the handshake dir,
 *      dispatches a Haiku Task per pending request, writes the response.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

suite('AI Eval — Bridge', function () {
  this.timeout(20 * 60_000); // 20 min — multi-hop autonomous runs need slack

  let extensionApi: any;

  suiteSetup(async function () {
    // 1. Activate extension — registers participant, tools, and (when env var set) eval-bridge LM provider.
    const ext = vscode.extensions.getExtension('datahelper-chwagner.data-lineage-viz');
    assert.ok(ext, 'Extension must be present');
    extensionApi = await ext.activate();
    assert.ok(extensionApi, 'Extension must return API');
    assert.ok(extensionApi.getSession, 'Extension API must expose getSession');
    assert.ok(extensionApi.participant, 'Extension API must expose participant');

    // 2. Bootstrap the demo so parse rules load.
    await vscode.commands.executeCommand('dataLineageViz.openDemo');
    const sess = extensionApi.getSession();
    let retries = 60;
    while (retries > 0 && (!sess.model || sess.model.edges.length === 0)) {
      await new Promise(resolve => setTimeout(resolve, 300));
      retries--;
    }
    assert.ok(sess.model && sess.model.edges.length > 0, 'Demo model must load with edges (parse rules active)');

    // 3. Swap in the AI dacpac.
    const extPath = ext.extensionPath;
    const dacpacPath = path.join(extPath, 'tests', 'fixtures', 'AdventureWorks2025_AI.dacpac');
    assert.ok(fs.existsSync(dacpacPath), `AI dacpac must exist at ${dacpacPath}`);
    await vscode.commands.executeCommand('dataLineageViz.openExternalProject', vscode.Uri.file(dacpacPath));
    retries = 30;
    while (retries > 0 && sess.projectName !== 'AdventureWorks2025_AI') {
      await new Promise(resolve => setTimeout(resolve, 300));
      retries--;
    }
    assert.strictEqual(sess.projectName, 'AdventureWorks2025_AI');
    console.log(`[eval] AI dacpac loaded: ${sess.model.nodes.length} nodes, ${sess.model.edges.length} edges`);
  });

  test('Eval-bridge LM provider is registered (env-gated)', async function () {
    if (!process.env.EVAL_BRIDGE_HAIKU_URL) {
      console.log('[eval] EVAL_BRIDGE_HAIKU_URL not set — bridge is off; skipping');
      this.skip();
      return;
    }
    const models = await vscode.lm.selectChatModels({ vendor: 'eval-bridge' });
    assert.ok(models.length > 0, 'eval-bridge model must be selectable when EVAL_BRIDGE_HAIKU_URL is set');
    console.log(`[eval] eval-bridge models registered: ${models.map(m => m.id).join(', ')}`);
  });

  test('Eval-bridge round-trip — text response', async function () {
    if (!process.env.EVAL_BRIDGE_HAIKU_URL) { this.skip(); return; }
    this.timeout(2 * 60_000);
    const haiku = (await vscode.lm.selectChatModels({ vendor: 'eval-bridge' }))[0];
    const messages = [vscode.LanguageModelChatMessage.User('smoke probe — text round-trip')];
    const resp = await haiku.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
    const collected: string[] = [];
    for await (const part of resp.stream) {
      if (part instanceof vscode.LanguageModelTextPart) collected.push(part.value);
    }
    console.log(`[eval] text round-trip received: ${collected.join('').slice(0, 200)}`);
    assert.ok(collected.length > 0, 'expected at least one text part from the bridge');
  });

  test('Eval-bridge round-trip — tool_use response', async function () {
    if (!process.env.EVAL_BRIDGE_HAIKU_URL) { this.skip(); return; }
    this.timeout(2 * 60_000);
    const haiku = (await vscode.lm.selectChatModels({ vendor: 'eval-bridge' }))[0];
    const tools: vscode.LanguageModelChatTool[] = [{
      name: 'lineage_start_exploration',
      description: 'Starts a hop-by-hop exploration.',
      inputSchema: { type: 'object', properties: { origin: { type: 'string' } }, required: ['origin'] },
    }];
    const messages = [
      vscode.LanguageModelChatMessage.User('System envelope (synthetic)'),
      vscode.LanguageModelChatMessage.User('Build a graph around [HumanResources].[Employee]'),
    ];
    const resp = await haiku.sendRequest(messages, { tools }, new vscode.CancellationTokenSource().token);
    const calls: { name: string; input: any }[] = [];
    for await (const part of resp.stream) {
      if (part instanceof vscode.LanguageModelToolCallPart) calls.push({ name: part.name, input: part.input as any });
    }
    console.log(`[eval] tool_use round-trip: ${JSON.stringify(calls)}`);
    assert.ok(calls.length > 0, 'expected at least one tool_use part from the bridge');
    assert.strictEqual(calls[0].name, 'lineage_start_exploration');
  });

  test('Autonomous E2E — drive @lineage participant through bridge', async function () {
    if (!process.env.EVAL_BRIDGE_HAIKU_URL || !process.env.EVAL_AUTONOMOUS_QUESTION) {
      console.log('[eval] EVAL_BRIDGE_HAIKU_URL / EVAL_AUTONOMOUS_QUESTION not set — skipping autonomous E2E');
      this.skip();
      return;
    }

    const haiku = (await vscode.lm.selectChatModels({ vendor: 'eval-bridge' }))[0];
    const captured: string[] = [];
    const buttons: any[] = [];
    const stream: vscode.ChatResponseStream = {
      markdown: (v: string | vscode.MarkdownString) => captured.push(`[md] ${typeof v === 'string' ? v : v.value}`),
      anchor: () => { /* ignore */ },
      button: (cmd: vscode.Command) => buttons.push({ command: cmd.command, title: cmd.title, args: cmd.arguments }),
      filetree: () => { /* ignore */ },
      progress: (s: string) => captured.push(`[progress] ${s}`),
      reference: () => { /* ignore */ },
      reference2: () => { /* ignore */ },
      push: () => { /* ignore */ },
      codeCitation: () => { /* ignore */ },
      confirmation: () => { /* ignore */ },
      prepareToolInvocation: () => undefined as any,
    } as any;

    const request: vscode.ChatRequest = {
      prompt: process.env.EVAL_AUTONOMOUS_QUESTION!,
      command: undefined,
      references: [],
      toolReferences: [],
      toolInvocationToken: undefined as any,
      model: haiku,
    } as any;

    console.log(`[autonomous] driving @lineage with: "${request.prompt}"`);
    let result = await extensionApi.participant.handleChatRequest(
      request,
      { history: [] } as any,
      stream,
      new vscode.CancellationTokenSource().token,
    );
    console.log(`[autonomous] turn 1 handler returned. captured=${captured.length} stream-parts.`);

    // ─── Auto-approve hook ─────────────────────────────────────────────────────
    // TEST-ONLY temporal hook. When EVAL_AUTONOMOUS_AUTO_APPROVE_GATE=1, after
    // the first handler return we detect whether the participant emitted a
    // confirm_sm_start gate and auto-resume by re-invoking the handler with
    // "yes" until the conversation drains (synthesis + present_result reached,
    // or max-iterations hit). This substitutes the human button-click that
    // a real user would perform in the chat panel. The hook fires NOTHING
    // when the env var is absent — manual UAT runs are unaffected.
    const sess = extensionApi.getSession();
    const autoApprove = process.env.EVAL_AUTONOMOUS_AUTO_APPROVE_GATE === '1';
    let continuationTurns = 0;
    const MAX_CONTINUATION_TURNS = 30;
    const history: vscode.ChatRequestTurn[] = [
      new vscode.ChatRequestTurn(request.prompt, undefined, [], 'datahelper-chwagner.data-lineage-viz', [], []),
    ];
    while (autoApprove && sess.phase?.kind === 'awaiting_gate' && continuationTurns < MAX_CONTINUATION_TURNS) {
      continuationTurns++;
      console.log(`[autonomous][auto-approve] phase=awaiting_gate — sending "yes" (turn ${continuationTurns + 1})`);
      const followup: vscode.ChatRequest = {
        prompt: 'yes',
        command: undefined,
        references: [],
        toolReferences: [],
        toolInvocationToken: undefined as any,
        model: haiku,
      } as any;
      result = await extensionApi.participant.handleChatRequest(
        followup,
        { history } as any,
        stream,
        new vscode.CancellationTokenSource().token,
      );
      console.log(`[autonomous] turn ${continuationTurns + 1} handler returned. phase=${sess.phase?.kind ?? '?'}; captured=${captured.length}`);
      history.push(new vscode.ChatRequestTurn(followup.prompt, undefined, [], 'datahelper-chwagner.data-lineage-viz', [], []));
      // If neither phase nor stream-progress changed, abort to avoid infinite loop on a stuck gate.
      if (sess.phase?.kind === 'awaiting_gate' && continuationTurns > 1 && !result?.metadata) {
        console.log(`[autonomous] aborting — gate not advancing`);
        break;
      }
    }
    console.log(`[autonomous] final phase=${sess.phase?.kind ?? '?'} after ${continuationTurns + 1} turns; captured=${captured.length}`);

    // Snapshot final SM state for extract.py.
    const ext = vscode.extensions.getExtension('datahelper-chwagner.data-lineage-viz')!;
    const snapshotPath = path.join(ext.extensionPath, 'test-results', 'eval-bridge', 'autonomous-snapshot.json');
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, JSON.stringify({
      ts: new Date().toISOString(),
      question: request.prompt,
      model: { vendor: haiku.vendor, family: haiku.family, id: haiku.id },
      session_id: sess.id,
      sm_state: sess.stateMachine ? sess.stateMachine.toJSON() : null,
      result_graph: sess.resultGraph ?? null,
      hop_log: sess.hopLog ?? [],
      stream_capture: captured,
      buttons,
      handler_result: result,
    }, null, 2), { encoding: 'utf-8' });
    console.log(`[autonomous] snapshot: ${snapshotPath}`);

    assert.ok(captured.length > 0, 'participant produced no stream output');
  });
});
