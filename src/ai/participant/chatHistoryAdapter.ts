/**
 * Native VS Code chat boundary and history projection for the provider-neutral runtime.
 *
 * This adapter detects the host's new-chat boundary and converts message shapes.
 * It does not retain history, select a model, count tokens, or define memory
 * reset behavior; reset semantics remain owned by `AiSession`.
 */
import type * as vscode from 'vscode';
import {
  modelAssistantMessage,
  modelToolCallMessage,
  modelToolResultMessage,
  modelUserMessage,
  type ModelMessage,
} from '../model/modelPort';

interface HistoryToolCall {
  readonly callId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly result: string;
}

interface NativeChatBoundarySession {
  readonly id: string;
  beginNativeChatSession(): void;
}

interface NativePendingGate {
  readonly gateId: string;
}

/**
 * Applies the existing new-chat reset when VS Code supplies an empty history.
 *
 * The optional pending-gate cancellation lets the new runtime release an old
 * interrupt before the session is reset. Memory implementation details remain
 * owned by `AiSession.resetExploration()`.
 */
export function applyNativeChatBoundary(
  history: vscode.ChatContext['history'],
  session: NativeChatBoundarySession,
  pendingGate: NativePendingGate | null,
  cancelPendingGate: (gateId: string) => void,
): boolean {
  if (history.length > 0) return false;
  if (pendingGate) cancelPendingGate(pendingGate.gateId);
  session.beginNativeChatSession();
  return true;
}

/**
 * Converts the current participant's native chat history into ordered graph messages.
 *
 * @param history - The native VS Code chat history for this participant.
 * @param debug - Optional debug sink; a malformed history value that degrades to an empty
 *   string must be observable, never a silent skip.
 */
export function chatHistoryToModelMessages(
  history: vscode.ChatContext['history'],
  debug?: (msg: string) => void,
): ModelMessage[] {
  const messages: ModelMessage[] = [];

  for (const turn of history) {
    if (isRequestTurn(turn)) {
      messages.push(modelUserMessage(turn.prompt));
      continue;
    }

    const metadata = record(record(turn.result)?.metadata);
    const toolMetadata = record(metadata?.toolCallsMetadata);
    const rounds = Array.isArray(toolMetadata?.toolCallRounds)
      ? toolMetadata.toolCallRounds
      : [];
    const results = record(toolMetadata?.toolCallResults);
    let emittedMetadata = false;

    for (const rawRound of rounds) {
      const round = record(rawRound);
      if (!round) continue;
      const response = typeof round.response === 'string' ? round.response : '';
      const calls = pairedToolCalls(round.toolCalls, results, debug);

      if (calls.length > 0) {
        messages.push(modelToolCallMessage(calls, response));
        for (const call of calls) {
          messages.push(modelToolResultMessage(
            call.callId,
            call.toolName,
            call.result,
          ));
        }
        emittedMetadata = true;
      } else if (response) {
        messages.push(modelAssistantMessage(response));
        emittedMetadata = true;
      }
    }

    if (!emittedMetadata) {
      const markdown = responseMarkdown(turn.response);
      if (markdown) messages.push(modelAssistantMessage(markdown));
    }
  }

  return messages;
}

function pairedToolCalls(
  rawCalls: unknown,
  results: Record<string, unknown> | undefined,
  debug?: (msg: string) => void,
): HistoryToolCall[] {
  if (!Array.isArray(rawCalls) || !results) return [];
  const calls: HistoryToolCall[] = [];

  for (const rawCall of rawCalls) {
    const call = record(rawCall);
    const callId = typeof call?.callId === 'string' ? call.callId : '';
    const toolName = typeof call?.name === 'string' ? call.name : '';
    const input = record(call?.input);
    if (
      !callId
      || !toolName
      || !input
      || !Object.prototype.hasOwnProperty.call(results, callId)
    ) continue;
    calls.push({
      callId,
      toolName,
      input,
      result: toolResultText(results[callId], debug),
    });
  }

  return calls;
}

function toolResultText(value: unknown, debug?: (msg: string) => void): string {
  const result = record(value);
  if (!Array.isArray(result?.content)) return stringify(value, debug);
  return result.content.map((part) => {
    const content = record(part);
    return typeof content?.value === 'string' ? content.value : stringify(part, debug);
  }).join('');
}

function responseMarkdown(response: vscode.ChatResponseTurn['response']): string {
  return response.map((part) => {
    const value = record(part)?.value;
    if (typeof value === 'string') return value;
    const markdown = record(value);
    return typeof markdown?.value === 'string' ? markdown.value : '';
  }).join('');
}

function isRequestTurn(
  turn: vscode.ChatRequestTurn | vscode.ChatResponseTurn,
): turn is vscode.ChatRequestTurn {
  return typeof record(turn)?.prompt === 'string';
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringify(value: unknown, debug?: (msg: string) => void): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch (err) {
    // Circular structure / BigInt in a history value: the empty-string fallback keeps the turn
    // alive, but the degradation must be observable, not a silent skip.
    debug?.(`history value not serializable — dropped (${err instanceof Error ? err.message : String(err)})`);
    return '';
  }
}
