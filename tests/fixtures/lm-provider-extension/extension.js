const vscode = require('vscode');
const {
  createProviderFetch,
  isResponsesEndpoint,
  sendProviderRequest,
} = require('./live-provider-adapter');

const VENDOR = 'lineage-test';
const MODEL_ID = 'lineage-smoke-model';
let replay;
let replayIndex = 0;
function replayAnalysis(request, progress) {
  const path = process.env.DLV_CHAT_UI_REPLAY_TRACE;
  if (!path) return false;
  replay ??= require('node:fs')
    .readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter(
      (row) => row.type === 'wire-response' && row.phase !== 'suggestions',
    );
  if (replayIndex === replay.length) {
    if (request.tools.length)
      throw new Error(
        'Recorded analysis exhausted before a tool-free suggestion request.',
      );
    return false;
  }
  const response = replay[replayIndex++];
  for (const call of response.toolCalls ?? []) {
    if (!request.tools.some((tool) => tool.name === call.name))
      throw new Error(`Recorded ${call.name} is not offered during replay.`);
    progress.report(
      new vscode.LanguageModelToolCallPart(call.callId, call.name, call.input),
    );
  }
  if (response.text)
    progress.report(new vscode.LanguageModelTextPart(response.text));
  return true;
}

function normalizePart(part) {
  if (part instanceof vscode.LanguageModelTextPart)
    return { type: 'text', value: part.value };
  if (part instanceof vscode.LanguageModelToolCallPart) {
    return {
      type: 'tool-call',
      callId: part.callId,
      name: part.name,
      input: part.input,
    };
  }
  if (part instanceof vscode.LanguageModelToolResultPart) {
    return {
      type: 'tool-result',
      callId: part.callId,
      content: part.content.map(normalizePart),
    };
  }
  return { type: part?.constructor?.name ?? typeof part };
}

function liveProviderProfile() {
  const configured = process.env.DLV_CHAT_UI_PROVIDER_PROFILE;
  if (!configured && process.env.DLV_CHAT_UI_REAL === '1')
    throw new Error(
      'Native AI verification requires its launcher provider profile.',
    );
  return configured
    ? JSON.parse(configured)
    : {
        provider: process.env.AI_TEST_PROVIDER?.trim().toLowerCase(),
        model: process.env.AI_TEST_MODEL,
        reasoningEffort: process.env.AI_TEST_REASONING_EFFORT,
      };
}

async function callLiveProvider(
  request,
  progress,
  token,
  transports,
  uiResponses,
) {
  const requestIndex = require('./chat-ui-provider').requests.length;
  const endpoint = process.env.AI_TEST_ENDPOINT;
  const apiKey = process.env.AI_TEST_API_KEY;
  const { model, provider, reasoningEffort } = liveProviderProfile();
  if (!endpoint || !apiKey || !model || !provider) {
    throw new Error(
      'AI smoke requires AI_TEST_PROVIDER, AI_TEST_ENDPOINT, AI_TEST_API_KEY, and AI_TEST_MODEL.',
    );
  }
  if (token.isCancellationRequested) return;
  const controller = new AbortController();
  const timeoutMs = Number(process.env.AI_TEST_REQUEST_TIMEOUT_MS);
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2_147_423_647
  )
    throw new Error(
      'Configure AI_TEST_REQUEST_TIMEOUT_MS through the test launcher.',
    );
  let transport = transports.get(timeoutMs);
  if (!transport) {
    transport = createProviderFetch(timeoutMs, {
      captureTiming: process.env.DLV_CHAT_UI_REAL === '1',
    });
    transports.set(timeoutMs, transport);
  }
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const cancellation = token.onCancellationRequested(() => controller.abort());
  try {
    const response = await sendProviderRequest(
      request,
      {
        endpoint,
        apiKey,
        model,
        provider,
        reasoningEffort,
        ...(process.env.DLV_CHAT_UI_REAL === '1' ? { temperature: 0.1 } : {}),
        // The headless port's Responses codec, compiled by `pretest:integration`.
        ...(isResponsesEndpoint(endpoint)
          ? {
              responsesWire: require('../../../out/test/tests/harness/openAiCompatiblePort.js'),
            }
          : {}),
      },
      transport,
      controller.signal,
    );
    if (process.env.DLV_CHAT_UI_REAL === '1')
      uiResponses.push({
        requestIndex,
        usage: response.usage ?? null,
        timing: response.timing ?? null,
      });
    if (token.isCancellationRequested) return;
    for (const call of response.toolCalls) {
      progress.report(
        new vscode.LanguageModelToolCallPart(call.id, call.name, call.input),
      );
    }
    if (response.text)
      progress.report(new vscode.LanguageModelTextPart(response.text));
  } catch (error) {
    if (token.isCancellationRequested) return;
    if (controller.signal.aborted)
      throw new Error(
        `AI provider request timed out after ${timeoutMs / 1000} seconds.`,
      );
    throw error;
  } finally {
    clearTimeout(timeout);
    cancellation.dispose();
  }
}

function hasToolResult(request, callId) {
  return request.messages.some((message) =>
    message.content.some(
      (part) =>
        (part.type === 'tool-result' && part.callId === callId) ||
        (part.type === 'text' && String(part.value).includes(callId)),
    ),
  );
}

function activate(context) {
  const transports = new Map();
  const uiResponses = [];
  context.subscriptions.push({
    dispose: () => {
      for (const transport of transports.values())
        void transport
          .close()
          .catch(() => console.error('AI provider transport cleanup failed.'));
      transports.clear();
    },
  });
  const uiErrors = [];
  let interruption;
  const provider = {
    provideLanguageModelChatInformation() {
      return [
        {
          id: MODEL_ID,
          name: 'Lineage Smoke Model',
          family: MODEL_ID,
          version: '1.0.0',
          maxInputTokens:
            process.env.DLV_CHAT_UI_REAL === '1' ? 128_000 : 32_000,
          maxOutputTokens:
            process.env.DLV_CHAT_UI_REAL === '1' ? 16_384 : 4_000,
          capabilities: { toolCalling: true },
        },
      ];
    },
    async provideLanguageModelChatResponse(
      _model,
      messages,
      options,
      progress,
      token,
    ) {
      if (token.isCancellationRequested) return;
      if (
        interruption &&
        (!interruption.toolName ||
          options.tools?.some((tool) => tool.name === interruption.toolName))
      ) {
        const request = JSON.stringify(messages);
        interruption.request ??= request;
        if (interruption.request === request) interruption.attempts += 1;
        if (
          interruption.request === request &&
          interruption.attempts <= interruption.failures
        ) {
          if (interruption.afterReply) {
            progress.report(new vscode.LanguageModelTextPart('Partial reply.'));
            await new Promise((resolve) => {
              interruption.release = resolve;
            });
          }
          throw Object.assign(
            new Error('ECONNRESET: fixture connection interrupted'),
            { code: 'ECONNRESET' },
          );
        }
      }
      const request = {
        messages: messages.map((message) => ({
          role:
            message.role === vscode.LanguageModelChatMessageRole.User
              ? 'user'
              : 'assistant',
          content: message.content.map(normalizePart),
        })),
        tools: (options.tools ?? []).map((tool) => ({
          name: tool.name,
          description: tool.description,
          schema: tool.inputSchema,
        })),
        toolMode:
          options.toolMode === vscode.LanguageModelChatToolMode.Required
            ? 'required'
            : 'auto',
      };
      if (process.env.DLV_CHAT_UI_REAL === '1')
        require('./chat-ui-provider').requests.push(request);
      if (process.env.DLV_CHAT_UI_FIXTURE === '1') {
        await require('./chat-ui-provider').respond(request, progress);
        return;
      }
      if (process.env.AI_TEST_REAL_PROVIDER === '1') {
        if (replayAnalysis(request, progress)) return;
        const requestIndex = require('./chat-ui-provider').requests.length;
        try {
          await callLiveProvider(
            request,
            progress,
            token,
            transports,
            uiResponses,
          );
        } catch (error) {
          if (process.env.DLV_CHAT_UI_REAL === '1')
            uiErrors.push({
              requestIndex,
              message: error instanceof Error ? error.message : String(error),
            });
          throw error;
        }
        return;
      }

      const names = request.tools.map((tool) => tool.name);
      if (names.includes('structured_output')) {
        progress.report(
          new vscode.LanguageModelToolCallPart(
            'entry-001',
            'structured_output',
            { entry: 'discovery', targetColumns: null },
          ),
        );
        return;
      }
      if (
        names.includes('lineage_search_objects') &&
        !hasToolResult(request, 'search-001')
      ) {
        progress.report(
          new vscode.LanguageModelToolCallPart(
            'search-001',
            'lineage_search_objects',
            { query: 'Sales' },
          ),
        );
        return;
      }
      if (names.includes('lineage_present_result')) {
        throw new Error(
          'The deterministic fixture covers discovery lifecycle only; it does not fabricate a lineage_present_result payload.',
        );
      }
      progress.report(
        new vscode.LanguageModelTextPart(
          'The demo lineage smoke turn completed.',
        ),
      );
    },
    async provideTokenCount(_model, text) {
      return typeof text === 'string' ? text.length : 1;
    },
  };
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
  );
  return {
    uiRequests: require('./chat-ui-provider').requests,
    uiResponses,
    uiErrors,
    providerProfile: liveProviderProfile(),
    setInterruption(value) {
      interruption = value;
    },
  };
}

module.exports = { activate };
