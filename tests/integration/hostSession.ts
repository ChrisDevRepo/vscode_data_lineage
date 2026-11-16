/**
 * In-host setup shared by every AI test that runs the shipped extension in a real VS Code host
 * through vscode.lm only: the model behind the cloner's own endpoint (VS Code's built-in custom
 * endpoint provider, configured by the AI_TEST_* names), a loaded project and a recording chat
 * stream. GUI suites add their UI on top.
 */
import * as assert from 'node:assert';
import * as vscode from 'vscode';

/** @internal */
export const EXTENSION_ID = 'datahelper-chwagner.data-lineage-viz';

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

/**
 * Registers the AI_TEST_* endpoint as a built-in custom-endpoint group and returns its one model.
 * The chat extension is first used here, so VS Code must have finished starting. VS Code owns the
 * wire: AI_TEST_ENDPOINT ending in /responses selects the Responses API, anything else Chat
 * Completions.
 */
async function byokModel(
  timeoutMs = 90_000,
): Promise<vscode.LanguageModelChat> {
  const { AI_TEST_ENDPOINT, AI_TEST_API_KEY, AI_TEST_MODEL } = process.env;
  const effort = process.env.AI_TEST_REASONING_EFFORT;
  const apiType = new URL(AI_TEST_ENDPOINT!).pathname
    .replace(/\/+$/u, '')
    .endsWith('/responses')
    ? 'responses'
    : 'chat-completions';
  await vscode.commands.executeCommand('workbench.action.chat.manage');
  for (
    let i = 0;
    i < 60 && !vscode.extensions.getExtension('GitHub.copilot-chat');
    i++
  )
    await sleep(1000);
  const chat = vscode.extensions.getExtension('GitHub.copilot-chat');
  assert.ok(
    chat,
    'the built-in chat extension is missing from this VS Code build',
  );
  await chat.activate();
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('lm.addLanguageModelsProviderGroup', {
    name: 'ai-test',
    vendor: 'customendpoint',
    apiKey: AI_TEST_API_KEY,
    apiType,
    ...(effort
      ? { settings: { [AI_TEST_MODEL!]: { reasoningEffort: effort } } }
      : {}),
    models: [
      {
        id: AI_TEST_MODEL,
        name: AI_TEST_MODEL,
        url: AI_TEST_ENDPOINT,
        toolCalling: true,
        vision: false,
        maxInputTokens: Number(process.env.AI_TEST_MAX_INPUT_TOKENS),
        maxOutputTokens: Number(process.env.AI_TEST_MAX_OUTPUT_TOKENS),
        ...(effort
          ? {
              supportsReasoningEffort: [effort],
              reasoningEffortFormat: apiType,
            }
          : {}),
      },
    ],
  });
  for (
    const until = Date.now() + timeoutMs;
    Date.now() < until;
    await sleep(1000)
  ) {
    const models = (
      await vscode.lm.selectChatModels({ vendor: 'customendpoint' })
    ).filter((model) => model.id === AI_TEST_MODEL);
    if (models.length === 1) return models[0];
  }
  return assert.fail(
    `the custom endpoint did not list model ${AI_TEST_MODEL} exactly once`,
  );
}

/** Registers the endpoint's model and activates the shipped extension. */
export async function activateHost() {
  const model = await byokModel();
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, 'the extension under test must be installed');
  const api = await extension.activate();
  assert.ok(api?.participant, 'activate() must export the participant');
  return { model, exports: api, extensionPath: extension.extensionPath };
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
