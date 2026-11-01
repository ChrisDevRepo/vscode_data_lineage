const vscode = require('vscode');
const {
  createProviderFetch,
  isResponsesEndpoint,
  sendProviderRequest,
} = require('./live-provider-adapter');

const VENDOR = 'lineage-test';
const MODEL_ID = 'lineage-smoke-model';

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

async function callLiveProvider(request, progress, token, transports) {
  const endpoint = process.env.AI_TEST_ENDPOINT;
  const apiKey = process.env.AI_TEST_API_KEY;
  const model = process.env.AI_TEST_MODEL;
  const provider = process.env.AI_TEST_PROVIDER?.trim().toLowerCase();
  const reasoningEffort = process.env.AI_TEST_REASONING_EFFORT;
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
    transport = createProviderFetch(timeoutMs);
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
  context.subscriptions.push({
    dispose: () => {
      for (const transport of transports.values())
        void transport
          .close()
          .catch(() => console.error('AI provider transport cleanup failed.'));
      transports.clear();
    },
  });
  let interruption;
  const provider = {
    provideLanguageModelChatInformation() {
      return [
        {
          id: MODEL_ID,
          name: 'Lineage Smoke Model',
          family: MODEL_ID,
          version: '1.0.0',
          maxInputTokens: 32_000,
          maxOutputTokens: 4_000,
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
      if (process.env.AI_TEST_REAL_PROVIDER === '1') {
        await callLiveProvider(request, progress, token, transports);
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
    setInterruption(value) {
      interruption = value;
    },
  };
}

module.exports = { activate };
