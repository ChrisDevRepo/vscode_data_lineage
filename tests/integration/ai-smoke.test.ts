/** Exercises one real provider-backed @lineage turn through VS Code's public model API. */
import * as assert from 'node:assert';
import * as vscode from 'vscode';

suite('Real provider smoke', () => {
  const EXTENSION_ID = 'datahelper-chwagner.data-lineage-viz';
  const FIXTURE_ID = 'data-lineage-test.data-lineage-test-model-provider';
  const TEST_VENDOR = 'lineage-test';
  const TEST_TIMEOUT_MS = 290_000;
  const PROVIDER_REQUEST_TIMEOUT_MS = 120_000;
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
    this.timeout(TEST_TIMEOUT_MS);
    const startedAt = Date.now();
    const testDeadline = startedAt + TEST_TIMEOUT_MS;
    for (const name of ['AI_TEST_PROVIDER', 'AI_TEST_ENDPOINT', 'AI_TEST_API_KEY', 'AI_TEST_MODEL']) {
      assert.ok(process.env[name], `Set ${name} in .env before running npm run test:ai:smoke.`);
    }

    const fixture = vscode.extensions.getExtension(FIXTURE_ID);
    assert.ok(fixture, 'the language-model adapter fixture must be installed in this lane');
    await fixture.activate();
    const deadline = Math.min(testDeadline - 150_000, Date.now() + 20_000);
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
    await vscode.commands.executeCommand('dataLineageViz.openDemo');
    const readyBy = Math.min(testDeadline - 130_000, Date.now() + 45_000);
    let demoLoaded = false;
    while (Date.now() < readyBy && !demoLoaded) {
      const probe = await vscode.lm.invokeTool('lineage_search_objects', {
        input: { query: 'Sales' },
        toolInvocationToken: undefined,
      });
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
    // A provider request can remain in flight for 120 seconds. Cancel early enough for that
    // request and host teardown to finish before Mocha's hard deadline.
    const cancelAt = testDeadline - PROVIDER_REQUEST_TIMEOUT_MS - DEADLINE_MARGIN_MS;
    assert.ok(cancelAt > Date.now(), 'setup left no safe time for a provider turn');
    const cancelTimer = setTimeout(() => cancellation.cancel(), cancelAt - Date.now());
    let finalStatus = 'error';
    let modelCalls = 0;
    try {
      const result = await exports.participant.handleChatRequest(
        {
          prompt: 'Which tables feed Sales? Name the sources you can verify from the loaded lineage data.',
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
      console.log(
        `[ai-smoke] provider=${process.env.AI_TEST_PROVIDER} model=${process.env.AI_TEST_MODEL} `
        + `adapter=${model.vendor}/${model.family}/${model.version} elapsedMs=${Date.now() - startedAt} `
        + `status=${finalStatus} modelCalls=${modelCalls}`,
      );
    }
  });
});
