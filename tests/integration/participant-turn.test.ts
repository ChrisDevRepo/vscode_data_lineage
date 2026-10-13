import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { announceLaneTier } from './laneTier';

/**
 * Drives a real `@lineage` participant turn through public API and observes what it streams.
 *
 * The recording stream is a test double, so this asserts emitted responses, not rendered UI.
 */
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
  });

  test('the fixture model resolves from the public API with the expected identity', async () => {
    const model = await fixtureModel();
    assert.strictEqual(model.vendor, TEST_VENDOR);
    assert.strictEqual(model.id, TEST_MODEL_ID);
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
});
