'use strict';

/** OpenAI Responses codec of the provider fixture: the one request builder and response reader.
 * Stateless (`store: false`).
 */

/**
 * Chat-shaped messages (`toProviderMessages`) as Responses `input` items; call ids pair calls with
 * outputs. A message may carry opaque `reasoning_details` (`{ before?, item }`), which stay
 * directly ahead of the call they preceded: the fixture's messages never do, a replay may.
 * @internal Read by replay tooling.
 */
function toResponsesInput(messages) {
  return messages.flatMap((message) => {
    if (message.role === 'tool') {
      return [
        {
          type: 'function_call_output',
          call_id: message.tool_call_id ?? '',
          output: message.content ?? '',
        },
      ];
    }
    const reasoning = message.reasoning_details ?? [];
    return [
      ...reasoning
        .filter(({ before }) => before === undefined)
        .map(({ item }) => item),
      ...(message.content
        ? [{ role: message.role, content: message.content }]
        : []),
      ...(message.tool_calls ?? []).flatMap((call) => [
        ...reasoning
          .filter(({ before }) => before === call.id)
          .map(({ item }) => item),
        {
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        },
      ]),
    ];
  });
}

/** One Responses request body from chat-shaped messages and function tools. */
function responsesRequestBody(
  model,
  messages,
  tools,
  toolChoice,
  reasoningEffort,
) {
  return {
    model,
    input: toResponsesInput(messages),
    store: false,
    ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
    ...(tools.length > 0
      ? {
          tools: tools.map(({ function: fn }) => ({
            type: 'function',
            ...fn,
            strict: false,
          })),
          tool_choice: toolChoice,
        }
      : {}),
  };
}

/** Decodes a `/responses` body into `{ toolCalls, text }`; an error envelope or no output throws */
function readResponse(body) {
  if (body?.error)
    throw new Error(
      `AI provider returned an error envelope: ${String(body.error.message ?? body.error.code ?? 'unknown')}.`,
    );
  if (!Array.isArray(body?.output))
    throw new Error('AI provider response carried no output.');
  const toolCalls = [];
  let text = '';
  for (const item of body.output) {
    if (item?.type === 'message') {
      for (const content of Array.isArray(item.content) ? item.content : [])
        if (content?.type === 'output_text' && typeof content.text === 'string')
          text += content.text;
    } else if (item?.type === 'function_call') {
      if (typeof item.call_id !== 'string' || typeof item.name !== 'string')
        throw new Error(
          'AI provider returned a tool call without an identifier or name.',
        );
      let input;
      try {
        input = JSON.parse(item.arguments || '{}');
      } catch {
        throw new Error(
          `AI provider tool call ${item.name} contained invalid JSON arguments.`,
        );
      }
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new Error(
          `AI provider tool call ${item.name} arguments must be an object.`,
        );
      toolCalls.push({ id: item.call_id, name: item.name, input });
    }
  }
  return { toolCalls, text };
}

module.exports = { toResponsesInput, responsesRequestBody, readResponse };
