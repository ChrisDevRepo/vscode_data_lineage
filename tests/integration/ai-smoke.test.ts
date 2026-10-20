/** Exercises one real provider-backed @lineage turn through VS Code's public model API. */
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { resolveLangfuseConfig } from '../harness/langfuseExport';
import { copyNativeHostLog, exportNativeEvidence } from '../harness/nativeEvidence';
import { parseTrace } from '../harness/traceModel';

suite('Real provider smoke', () => {
  const EXTENSION_ID = 'datahelper-chwagner.data-lineage-viz';
  const FIXTURE_ID = 'data-lineage-test.data-lineage-test-model-provider';
  const TEST_VENDOR = 'lineage-test';
  const TEST_TIMEOUT_MS = Number(process.env.AI_TEST_TIMEOUT_MS);
  const DEADLINE_MARGIN_MS = 10_000;

  function recordingStream() {
    const markdown: string[] = [];
    const stream = {
      progress: () => {},
      markdown: (value: unknown) => {
        markdown.push(typeof value === 'string' ? value : String((value as { value?: string })?.value ?? value));
      },
      button: () => {}, anchor: () => {}, filetree: () => {}, reference: () => {}, push: () => {},
    } as unknown as vscode.ChatResponseStream;
    return { stream, markdown };
  }

  test('a configured provider completes a public demo-data question', async function () {
    this.timeout(TEST_TIMEOUT_MS + 60_000);
    const startedAt = Date.now();
    const testDeadline = startedAt + TEST_TIMEOUT_MS;
    for (const name of ['AI_TEST_PROVIDER', 'AI_TEST_ENDPOINT', 'AI_TEST_API_KEY', 'AI_TEST_MODEL']) {
      assert.ok(process.env[name], `Set ${name} in .env before running npm run test:ai:smoke.`);
    }

    assert.ok(resolveLangfuseConfig(process.env), 'Set all LANGFUSE_* connection variables before a real-provider VS Code smoke.');
    const fixture = vscode.extensions.getExtension(FIXTURE_ID);
    assert.ok(fixture, 'the language-model adapter fixture must be installed in this lane');
    await fixture.activate();
    const deadline = Math.min(testDeadline - DEADLINE_MARGIN_MS, Date.now() + 20_000);
    let model: vscode.LanguageModelChat | undefined;
    while (Date.now() < deadline && !model) {
      model = (await vscode.lm.selectChatModels({ vendor: TEST_VENDOR }))[0];
      if (!model) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(model, 'the VS Code language-model adapter did not register');

    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    const exports = await extension.activate();
    assert.ok(exports?.participant);
    const directory = join(extension.extensionPath, 'test-results', 'ai-smoke', randomUUID());
    mkdirSync(directory, { recursive: true });
    const tracePath = await vscode.commands.executeCommand<string>('dataLineageViz.enableAiTraceLogging', true);
    assert.ok(tracePath, 'real-provider smoke requires a fresh verbose trace');
    await vscode.commands.executeCommand('dataLineageViz.openDemo');
    const readyBy = Math.min(testDeadline - DEADLINE_MARGIN_MS, Date.now() + 45_000);
    let demoLoaded = false;
    while (Date.now() < readyBy && !demoLoaded) {
      const probe = await Promise.resolve(vscode.lm.invokeTool('lineage_search_objects', {
        input: { query: 'Sales' },
        toolInvocationToken: undefined,
      })).catch((error: unknown) => {
        if (error instanceof Error && /no project is loaded/i.test(error.message)) return null;
        throw error;
      });
      if (!probe) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      const resultText = probe.content
        .map((part) => (part as { value?: unknown }).value ?? '')
        .join('');
      try {
        const result = JSON.parse(resultText) as { results?: unknown[] };
        demoLoaded = Array.isArray(result.results) && result.results.length > 0;
      } catch {
        demoLoaded = false;
      }
      if (!demoLoaded) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(demoLoaded, 'the public demo DACPAC must be searchable before the provider turn starts');

    const { stream, markdown } = recordingStream();
    const cancellation = new vscode.CancellationTokenSource();
    // Cancellation aborts the provider request; reserve only teardown time.
    const cancelAt = testDeadline - DEADLINE_MARGIN_MS;
    assert.ok(cancelAt > Date.now(), 'setup left no safe time for a provider turn');
    const cancelTimer = setTimeout(() => cancellation.cancel(), cancelAt - Date.now());
    let finalStatus = 'error';
    let modelCalls = 0;
    const question = 'Which tables feed Sales? Name the sources you can verify from the loaded lineage data.';
    try {
      const result = await exports.participant.handleChatRequest(
        {
          prompt: question,
          command: undefined,
          references: [],
          toolReferences: [],
          toolInvocationToken: undefined as never,
          model,
        },
        { history: [] },
        stream,
        cancellation.token,
      );
      const metadata = (result as vscode.ChatResult)?.metadata as { status?: string; modelCalls?: number } | undefined;
      finalStatus = metadata?.status ?? 'missing';
      modelCalls = metadata?.modelCalls ?? 0;
      assert.strictEqual(metadata?.status, 'ok', 'the real-provider turn must settle successfully');
      assert.ok(modelCalls > 0, 'the participant must call the configured provider');
      assert.ok(markdown.some((part) => part.trim().length > 0), 'the participant must produce an answer');
    } finally {
      clearTimeout(cancelTimer);
      cancellation.dispose();
      let trace = '';
      let parsed = parseTrace(trace);
      const drainBy = Date.now() + 2000;
      do {
        trace = existsSync(tracePath) ? readFileSync(tracePath, 'utf8') : '';
        parsed = parseTrace(trace);
        if (parsed.turns.some(turn => turn.type === 'turn-terminal')) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (Date.now() < drainBy);
      writeFileSync(join(directory, 'trace.ndjson'), trace);
      copyNativeHostLog(process.env.DLV_AI_SMOKE_PROFILE, directory);
      const statePaths = new Map<string, string>();
      const captureErrors: string[] = [];
      const starts = parsed.turns.filter(turn => turn.type === 'turn-start');
      const answerPath = join(directory, 'answer.txt');
      writeFileSync(answerPath, markdown.join('\n'));
      const session = exports.getSession();
      const reportPath = join(directory, 'report.md');
      const finalSnapshotPath = join(directory, 'final-snapshot.json');
      if (session.lastPresentResultDescription) writeFileSync(reportPath, session.lastPresentResultDescription);
      if (session.resultGraph) writeFileSync(finalSnapshotPath, JSON.stringify({
        nodes: session.resultGraph.nodeIds, columnEdges: session.resultGraph.columnAspect?.edges ?? null,
      }, null, 2) + '\n');
      const questionHash = createHash('sha256').update(question).digest('hex');
      const fixtureHash = createHash('sha256').update(readFileSync(join(extension.extensionPath, 'assets', 'demo.dacpac'))).digest('hex');
      writeFileSync(join(directory, 'metrics-manifest.json'), JSON.stringify({
        catalogId: 'real-provider-smoke', question, questionHash, fixtureHash,
        caseIdentity: `real-provider-smoke:${questionHash}:${fixtureHash}`, outcome: finalStatus,
        requestIds: starts.map(turn => turn.requestId), tracePath: join(directory, 'trace.ndjson'),
        answerPath, answerRepresentation: 'streamed_markdown',
        reportPath, reportRepresentation: 'markdown', finalSnapshotPath,
      }, null, 2) + '\n');
      if (starts.length === 1) {
        const turnDirectory = join(directory, 'turn-1');
        mkdirSync(turnDirectory, { recursive: true });
        const statePath = join(turnDirectory, 'sm-state.json');
        const machine = exports.getSession().stateMachine;
        writeFileSync(statePath, JSON.stringify(machine ? machine.toJSON() : { explorationOpened: false }, null, 2) + '\n');
        statePaths.set(starts[0].requestId, statePath);
      } else captureErrors.push('Real-provider smoke must capture exactly one native request; historical state was not reconstructed.');
      await exportNativeEvidence({ trace, directory, sessionId: directory.split(/[\\/]/).pop()!,
        promptId: 'real-provider-smoke', statePaths, captureErrors });
      console.log(
        `[ai-smoke] provider=${process.env.AI_TEST_PROVIDER} model=${process.env.AI_TEST_MODEL} `
        + `adapter=${model.vendor}/${model.family}/${model.version} elapsedMs=${Date.now() - startedAt} `
        + `status=${finalStatus} modelCalls=${modelCalls}`,
      );
    }
  });
});
