import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { announceLaneTier } from './laneTier';

/** Drives a real `@lineage` participant turn through public API and observes what it streams. */
suite('Participant turn — public API, no CDP', () => {
  const EXTENSION_ID = 'datahelper-chwagner.data-lineage-viz';

  suiteSetup(() => { announceLaneTier(
    'participant-turn',
    'fixture',
    'a real handleChatRequest turn streams progress and settles with a terminal ChatResult',
  ); });
  const FIXTURE_ID = 'data-lineage-test.data-lineage-test-model-provider';
  const TEST_VENDOR = 'lineage-test';
  const TEST_MODEL_ID = 'lineage-smoke-model';

  /** Stands in for VS Code's chat renderer and records everything the participant emits. */
  function recordingStream() {
    const calls: Array<{ kind: string; value: string }> = [];
    const stream = {
      progress: (value: string) => { calls.push({ kind: 'progress', value }); },
      markdown: (value: unknown) => {
        const text = typeof value === 'string'
          ? value
          : String((value as { value?: string })?.value ?? value);
        calls.push({ kind: 'markdown', value: text });
      },
      button: (value: unknown) => { calls.push({ kind: 'button', value: JSON.stringify(value) }); },
      anchor: () => {}, filetree: () => {}, reference: () => {}, push: () => {},
    } as unknown as vscode.ChatResponseStream;
    return { stream, calls };
  }

  function chatRequest(prompt: string, model: vscode.LanguageModelChat): vscode.ChatRequest {
    return {
      prompt,
      command: undefined,
      references: [],
      toolReferences: [],
      toolInvocationToken: undefined as never,
      model,
    };
  }

  async function fixtureModel(): Promise<vscode.LanguageModelChat> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const models = await vscode.lm.selectChatModels({ vendor: TEST_VENDOR });
      if (models.length > 0) return models[0];
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return assert.fail('fixture language model was not available from the public VS Code API');
  }

  async function waitForDemoModel(): Promise<void> {
    const deadline = Date.now() + 60_000;
    let lastProbe = '';
    while (Date.now() < deadline) {
      // A rejection reaches a vscode.lm caller as a thrown error; only the no-project one means "not yet".
      const result = await Promise.resolve(vscode.lm.invokeTool('lineage_search_objects', {
        input: { query: 'Sales' },
        toolInvocationToken: undefined,
      })).catch((error: unknown) => {
        if (error instanceof Error && /no project is loaded/i.test(error.message)) return null;
        throw error;
      });
      if (!result) {
        lastProbe = 'no project loaded';
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      lastProbe = result.content
        .map((part) => (part as { value?: unknown }).value ?? '')
        .join('');
      const payload = JSON.parse(lastProbe) as { results?: unknown[] };
      if (Array.isArray(payload.results) && payload.results.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.fail(`demo model did not become queryable within 60s; last probe: ${lastProbe}`);
  }

  suiteSetup(async () => {
    const fixture = vscode.extensions.getExtension(FIXTURE_ID);
    assert.ok(fixture, 'language-model fixture must be installed in this lane');
    await fixture.activate();
    const model = await fixtureModel();
    assert.strictEqual(model.vendor, TEST_VENDOR, 'the fixture must use the declared test vendor');
    assert.strictEqual(model.id, TEST_MODEL_ID, 'the fixture must use the declared model identity');
  });

  test('with no lineage data loaded the turn degrades to a notice rather than throwing', async () => {
    const exports = await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
    assert.ok(exports?.participant, 'activate() must export the participant');
    const { stream, calls } = recordingStream();
    const source = new vscode.CancellationTokenSource();
    try {
      await exports.participant.handleChatRequest(
        chatRequest('trace Sales', undefined as unknown as vscode.LanguageModelChat),
        { history: [] },
        stream,
        source.token,
      );
      assert.match(
        calls.map((call) => call.value).join(' '),
        /No lineage data loaded/i,
        'the no-data branch must tell the user what to do',
      );
    } finally {
      source.dispose();
    }
  });

  test('a full turn streams progress and settles with a terminal ChatResult', async function () {
    this.timeout(120_000);
    const exports = await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
    await vscode.commands.executeCommand('dataLineageViz.openDemo');
    await waitForDemoModel();

    const { stream, calls } = recordingStream();
    const source = new vscode.CancellationTokenSource();
    try {
      const result = await exports.participant.handleChatRequest(
        chatRequest('Which tables feed Sales?', await fixtureModel()),
        { history: [] },
        stream,
        source.token,
      );

      assert.ok(calls.some((call) => call.kind === 'progress'), 'a turn must report progress');
      const metadata = (result as vscode.ChatResult)?.metadata as
        | { requestId?: string; status?: string; modelCalls?: number }
        | undefined;
      assert.ok(metadata?.requestId, 'the turn must return a correlated requestId');
      assert.strictEqual(metadata?.status, 'ok', 'the fixture-backed turn must settle ok');
      assert.ok((metadata?.modelCalls ?? 0) > 0, 'the turn must have reached the model');
    } finally {
      source.dispose();
    }
  });

  // Only a connection interruption before any reply gets one retry.
  for (const scenario of [
    { name: 'retries a dropped connection before the reply', failures: 1, afterReply: false, toolName: 'structured_output', status: 'ok', attempts: 2 },
    { name: 'stops after a second dropped connection', failures: 2, afterReply: false, toolName: 'structured_output', status: 'error', attempts: 2 },
    { name: 'does not retry buffered discovery after a reply starts', failures: 1, afterReply: true, toolName: 'lineage_search_objects', status: 'error', attempts: 1 },
    { name: 'does not retry structured entry after a reply starts', failures: 1, afterReply: true, toolName: 'structured_output', status: 'error', attempts: 1 },
  ]) {
    test(scenario.name, async function () {
      this.timeout(120_000);
      const fixture = await vscode.extensions.getExtension(FIXTURE_ID)!.activate();
      const extension = await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
      await vscode.commands.executeCommand('dataLineageViz.openDemo');
      await waitForDemoModel();
      const interruption = {
        failures: scenario.failures, afterReply: scenario.afterReply, attempts: 0,
        toolName: scenario.toolName,
        release: undefined as (() => void) | undefined,
      };
      fixture.setInterruption(interruption);
      const { stream, calls } = recordingStream();
      const source = new vscode.CancellationTokenSource();
      let replyReceived = false;
      try {
        const nativeModel = await fixtureModel();
        const model: vscode.LanguageModelChat = scenario.afterReply ? {
          ...nativeModel,
          countTokens: nativeModel.countTokens.bind(nativeModel),
          async sendRequest(...args) {
            const response = await nativeModel.sendRequest(...args);
            return {
              text: response.text,
              stream: (async function* () {
                for await (const value of response.stream) {
                  if (value instanceof vscode.LanguageModelTextPart && value.value === 'Partial reply.') {
                    replyReceived = true;
                    interruption.release!();
                  }
                  yield value;
                }
              })(),
            };
          },
        } : nativeModel;
        const result = await extension.participant.handleChatRequest(
          chatRequest('Which tables feed Sales?', model),
          { history: [] }, stream, source.token,
        );
        const metadata = (result as vscode.ChatResult)?.metadata as { status?: string } | undefined;
        if (scenario.afterReply) assert.ok(replyReceived, `native model stream must deliver the partial reply before interruption: ${JSON.stringify({ metadata, calls, attempts: interruption.attempts })}`);
        assert.strictEqual(metadata?.status, scenario.status);
        assert.strictEqual(interruption.attempts, scenario.attempts, 'count retries of the same native request');
      } finally {
        interruption.release?.();
        fixture.setInterruption(undefined);
        source.dispose();
      }
    });
  }
});
