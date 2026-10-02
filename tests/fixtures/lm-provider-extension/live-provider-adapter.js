'use strict';

function toProviderMessages(messages) {
  const output = [];
  for (const message of messages) {
    const text = [];
    const calls = [];
    const results = [];
    for (const part of message.content) {
      if (part.type === 'text' && typeof part.value === 'string') text.push(part.value);
      if (part.type === 'tool-call') {
        calls.push({
          id: requiredString(part.callId, 'tool call id'),
          type: 'function',
          function: {
            name: requiredString(part.name, 'tool call name'),
            arguments: JSON.stringify(requiredObject(part.input, 'tool call input')),
          },
        });
      }
      if (part.type === 'tool-result') {
        results.push({
          role: 'tool',
          tool_call_id: requiredString(part.callId, 'tool result call id'),
          content: toolResultText(part.content),
        });
      }
    }
    if (text.length > 0 || calls.length > 0) {
      output.push({
        role: message.role === 'user' ? 'user' : 'assistant',
        content: text.join('\n') || null,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
    }
    output.push(...results);
  }
  return output;
}

function buildProviderRequest(request, config) {
  const provider = requiredString(config.provider, 'provider').trim().toLowerCase();
  const model = requiredString(config.model, 'model');
  const apiKey = requiredString(config.apiKey, 'API key');
  const tools = request.tools.map((tool) => ({
    type: 'function',
    function: {
      name: requiredString(tool.name, 'tool name'),
      description: requiredString(tool.description, `description for ${tool.name || 'tool'}`),
      parameters: requiredObject(tool.schema, `schema for ${tool.name || 'tool'}`),
    },
  }));
  if (request.toolMode === 'required' && tools.length === 0) {
    throw new Error('AI provider request cannot require a tool when no tools are available.');
  }
  return {
    url: providerEndpoint(requiredString(config.endpoint, 'endpoint'), provider, model),
    headers: provider === 'azure'
      ? { 'content-type': 'application/json', 'api-key': apiKey }
      : { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: {
      model,
      messages: toProviderMessages(request.messages),
      ...(tools.length > 0 ? {
        tools,
        tool_choice: request.toolMode === 'required' ? 'required' : 'auto',
      } : {}),
      ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
    },
  };
}

async function sendProviderRequest(request, config, fetchImpl, signal) {
  const wire = buildProviderRequest(request, config);
  const response = await fetchImpl(wire.url, {
    method: 'POST',
    headers: wire.headers,
    body: JSON.stringify(wire.body),
    signal,
  });
  if (!response || typeof response.ok !== 'boolean' || typeof response.json !== 'function') {
    throw new Error('AI provider returned an invalid HTTP response.');
  }
  if (!response.ok) {
    throw new Error(`AI provider returned HTTP ${response.status}; check its endpoint, credentials, model and API compatibility.`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('AI provider response was not valid JSON.');
  }
  return parseProviderResponse(payload);
}

function parseProviderResponse(payload) {
  const message = payload?.choices?.[0]?.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error('AI provider response did not contain choices[0].message.');
  }
  if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) {
    throw new Error('AI provider response tool_calls must be an array.');
  }
  const toolCalls = (message.tool_calls ?? []).map((call) => {
    const id = requiredString(call?.id, 'provider tool call id');
    const name = requiredString(call?.function?.name, 'provider tool call name');
    const rawArguments = call?.function?.arguments;
    if (typeof rawArguments !== 'string') {
      throw new Error(`AI provider tool call ${name} did not contain string arguments.`);
    }
    let input;
    try {
      input = JSON.parse(rawArguments || '{}');
    } catch {
      throw new Error(`AI provider tool call ${name} contained invalid JSON arguments.`);
    }
    return { id, name, input: requiredObject(input, `arguments for provider tool call ${name}`) };
  });
  const text = providerText(message.content);
  if (toolCalls.length === 0 && text.length === 0) {
    throw new Error('AI provider response contained neither text nor tool calls.');
  }
  return { toolCalls, text };
}

function providerEndpoint(value, provider, model) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error('AI provider endpoint must be an absolute URL.');
  }
  if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
    throw new Error('AI provider endpoint must use HTTP or HTTPS.');
  }
  if (endpoint.pathname.endsWith('/chat/completions')) return endpoint.toString();
  if (provider === 'azure') {
    if (endpoint.pathname.endsWith('/openai/v1')) {
      endpoint.pathname = `${endpoint.pathname}/chat/completions`;
      return endpoint.toString();
    }
    if (endpoint.pathname.includes('/openai/deployments/')) {
      endpoint.pathname = `${endpoint.pathname.replace(/\/$/u, '')}/chat/completions`;
      if (!endpoint.searchParams.has('api-version')) endpoint.searchParams.set('api-version', '2024-10-21');
      return endpoint.toString();
    }
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/u, '')}/openai/deployments/${encodeURIComponent(model)}/chat/completions`;
    if (!endpoint.searchParams.has('api-version')) endpoint.searchParams.set('api-version', '2024-10-21');
    return endpoint.toString();
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/u, '')}/chat/completions`;
  return endpoint.toString();
}

function toolResultText(content) {
  if (!Array.isArray(content)) throw new Error('Tool result content must be an array.');
  return content
    .filter((part) => part.type === 'text' && typeof part.value === 'string')
    .map((part) => part.value)
    .join('\n');
}

function providerText(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw new Error('AI provider response content must be text, an array or null.');
  return content
    .filter((part) => part && typeof part === 'object' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`AI provider ${label} must be a non-empty string.`);
  }
  return value;
}

function requiredObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`AI provider ${label} must be an object.`);
  }
  return value;
}

module.exports = { buildProviderRequest, parseProviderResponse, providerEndpoint, sendProviderRequest, toProviderMessages };
