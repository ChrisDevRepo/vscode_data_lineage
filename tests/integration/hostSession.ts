/**
 * In-host setup shared by every AI test that runs the shipped extension in a real VS Code host
 * through vscode.lm only: the provider fixture, its model, a loaded project and a recording chat
 * stream. GUI suites add their UI on top.
 */
import * as assert from 'node:assert';
import * as vscode from 'vscode';

/** @internal */
export const EXTENSION_ID = 'datahelper-chwagner.data-lineage-viz';
/** @internal */
export const FIXTURE_ID = 'data-lineage-test.data-lineage-test-model-provider';
/** @internal */
export const TEST_VENDOR = 'lineage-test';
/** @internal */
export const TEST_MODEL_ID = 'lineage-smoke-model';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stands in for VS Code's chat renderer: records everything the participant emits. */
export function recordingStream() {
  const calls: Array<{ kind: string; value: string }> = [];
  const stream = {
    progress: (value: string) => void calls.push({ kind: 'progress', value }),
    markdown: (value: unknown) =>
      void calls.push({
        kind: 'markdown',
        value:
          typeof value === 'string'
            ? value
            : String((value as { value?: string })?.value ?? value),
      }),
    button: (value: unknown) =>
      void calls.push({ kind: 'button', value: JSON.stringify(value) }),
    anchor: () => {},
    filetree: () => {},
    reference: () => {},
    push: () => {},
  } as unknown as vscode.ChatResponseStream;
  const markdown = () =>
    calls
      .filter((call) => call.kind === 'markdown')
      .map((call) => call.value)
      .join('');
  return { stream, calls, markdown };
}

/** The request VS Code builds for one user turn. */
export function chatRequest(
  prompt: string,
  model: vscode.LanguageModelChat,
  command?: string,
): vscode.ChatRequest {
  return {
    prompt,
    command,
    references: [],
    toolReferences: [],
    toolInvocationToken: undefined as never,
    model,
  };
}

/** The fixture's model, once the provider has registered it. @internal */
export async function fixtureModel(
  timeoutMs = 20_000,
): Promise<vscode.LanguageModelChat> {
  for (const until = Date.now() + timeoutMs; Date.now() < until; ) {
    const model = (
      await vscode.lm.selectChatModels({ vendor: TEST_VENDOR })
    )[0];
    if (model) return model;
    await sleep(250);
  }
  return assert.fail(
    'the language-model fixture did not register through the public VS Code API',
  );
}

/** Activates the provider fixture and the shipped extension and resolves the fixture model. */
export async function activateHost() {
  const fixtureExtension = vscode.extensions.getExtension(FIXTURE_ID);
  assert.ok(
    fixtureExtension,
    'the language-model fixture must be installed in this lane',
  );
  const fixture = await fixtureExtension.activate();
  const model = await fixtureModel();
  assert.strictEqual(model.vendor, TEST_VENDOR);
  assert.strictEqual(model.id, TEST_MODEL_ID);
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, 'the extension under test must be installed');
  const exports = await extension.activate();
  assert.ok(exports?.participant, 'activate() must export the participant');
  return { fixture, model, exports, extensionPath: extension.extensionPath };
}

/** Waits until the loaded project answers a search through the public tool API. @internal */
export async function waitForSearchable(timeoutMs = 60_000): Promise<void> {
  let last = 'no project loaded';
  for (const until = Date.now() + timeoutMs; Date.now() < until; ) {
    // A rejection reaches a vscode.lm caller as a thrown error; only no-project means "not yet".
    const result = await Promise.resolve(
      vscode.lm.invokeTool('lineage_search_objects', {
        input: { query: 'Sales' },
        toolInvocationToken: undefined,
      }),
    ).catch((error: unknown) => {
      if (error instanceof Error && /no project is loaded/i.test(error.message))
        return null;
      throw error;
    });
    if (result) {
      last = result.content
        .map((part) => (part as { value?: unknown }).value ?? '')
        .join('');
      try {
        const payload = JSON.parse(last) as { results?: unknown[] };
        if (Array.isArray(payload.results) && payload.results.length > 0)
          return;
      } catch {
        /* not yet a search payload */
      }
    }
    await sleep(250);
  }
  assert.fail(
    `project not queryable within ${timeoutMs} ms; last probe: ${last}`,
  );
}

/** Loads the public demo project and waits until it is searchable. */
export async function openDemo(timeoutMs = 60_000): Promise<void> {
  await vscode.commands.executeCommand('dataLineageViz.openDemo');
  await waitForSearchable(timeoutMs);
}

/** Loads a DACPAC as the chat-UI suites do (`openExternalProject`). @internal */
export async function openProject(
  dacpac: string,
  session: () => { model: unknown },
  timeoutMs = 120_000,
): Promise<void> {
  await vscode.commands.executeCommand(
    'dataLineageViz.openExternalProject',
    vscode.Uri.file(dacpac),
  );
  for (
    const until = Date.now() + timeoutMs;
    !session().model && Date.now() < until;

  )
    await sleep(250);
  assert.ok(session().model, `the DACPAC did not load: ${dacpac}`);
}
