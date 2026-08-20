import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { announceLaneTier } from './laneTier';

/**
 * Drives a real `@lineage` participant turn through public API and observes what it streams.
 *
 * @remarks
 * Replaces the former `chat-automation` lane, which reached the same conclusion through the
 * internal `workbench.action.chat.open` command and a CDP scrape of the rendered chat panel. The
 * seam used here needs no production change and no internal API: `activate()` returns the
 * participant ({@link file://./../../src/extensionRuntime.ts} `:278`) and `handleChatRequest` is
 * public ({@link file://./../../src/ai/participant/lineageParticipant.ts} `:213`).
 *
 * Known limit, stated rather than hidden: the recording stream below is a double, so this asserts
 * that the participant *called* `stream.markdown` / `progress` / `button`, not that VS Code
 * rendered them. The deleted CDP probe was the only check that ever observed the real renderer;
 * that specific observation is now UAT-only. Everything it asserted that did not depend on CDP —
 * that Copilot is genuinely absent, and that the fixture model resolves from the public API — is
 * preserved below.
 */
suite('Participant turn — public API, no CDP', () => {
  const EXTENSION_ID = 'datahelper-chwagner.data-lineage-viz';

  suiteSetup(() => announceLaneTier(
    'participant-turn',
    'scripted',
    'a real handleChatRequest turn streams progress and settles with a terminal ChatResult',
  ));
  const FIXTURE_ID = 'data-lineage-test.data-lineage-test-model-provider';
  const TEST_VENDOR = 'lineage-test';
  const TEST_MODEL_ID = 'lineage-deterministic-v1';

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
    } as unknown as vscode.ChatRequest;
  }

  async function fixtureModel(): Promise<vscode.LanguageModelChat> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const models = await vscode.lm.selectChatModels({ vendor: TEST_VENDOR });
      if (models.length > 0) return models[0];
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return assert.fail('scripted language model was not available from the public VS Code API');
  }

  async function waitForDemoModel(): Promise<void> {
    const deadline = Date.now() + 60_000;
    let lastProbe = '';
    while (Date.now() < deadline) {
      const result = await vscode.lm.invokeTool('lineage_search_objects', {
        input: { query: 'Sales' },
        toolInvocationToken: undefined,
      });
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
    assert.ok(fixture, 'scripted provider fixture must be installed in this lane');
    await fixture.activate();
  });

  // Preserved from the deleted chat-automation lane (its S2) — a positive control proving the
  // lane can tell absence from presence, so "works without Copilot" is not vacuous.
  test('Copilot really is absent, and the probe can tell absence from presence', async () => {
    assert.ok(
      (await vscode.lm.selectChatModels({ vendor: TEST_VENDOR })).length > 0,
      'the fixture vendor must resolve, or this test cannot distinguish absence from a broken query',
    );
    assert.strictEqual(
      (await vscode.lm.selectChatModels({ vendor: 'copilot' })).length,
      0,
      'no copilot-vendor model may be available in this lane',
    );
  });

  // Preserved from the deleted chat-automation lane (its S4).
  test('the fixture BYOK model resolves from the public API with the expected identity', async () => {
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
        { history: [] } as unknown as vscode.ChatContext,
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
        { history: [] } as unknown as vscode.ChatContext,
        stream,
        source.token,
      );

      assert.ok(calls.some((call) => call.kind === 'progress'), 'a turn must report progress');
      const metadata = (result as vscode.ChatResult)?.metadata as
        | { requestId?: string; status?: string; modelCalls?: number }
        | undefined;
      assert.ok(metadata?.requestId, 'the turn must return a correlated requestId');
      assert.strictEqual(metadata?.status, 'ok', 'the scripted turn must settle ok');
      assert.ok((metadata?.modelCalls ?? 0) > 0, 'the turn must have reached the model');
    } finally {
      source.dispose();
    }
  });
});
