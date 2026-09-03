/**
 * Native VS Code chat boundary and history projection for the provider-neutral runtime.
 *
 * This adapter detects the host's new-chat boundary and converts message shapes.
 * It does not retain history, select a model, count tokens, or define memory
 * reset behavior; reset semantics remain owned by `AiSession`.
 *
 * The projection is bounded: replayed history is capped to the same turn-count and byte ceilings
 * as the session's canonical discovery transcript ({@link MAX_DISCOVERY_TRANSCRIPT_TURNS} /
 * {@link MAX_DISCOVERY_TRANSCRIPT_BYTES}), evicting oldest whole turns first, so native history —
 * which only grows — can never push the assembled request past a model's input window.
 */
import type * as vscode from 'vscode';
import {
  modelAssistantMessage,
  modelToolCallMessage,
  modelToolResultMessage,
  modelUserMessage,
  type ModelMessage,
} from '../model/modelPort';
import {
  MAX_DISCOVERY_TRANSCRIPT_BYTES,
  MAX_DISCOVERY_TRANSCRIPT_TURNS,
} from '../session/session';
import { longestPrefixFitting } from '../support/textTruncation';

/**
 * Maximum UTF-8 bytes replayed from one historical tool result — a single 60 KB DDL payload in an
 * old round must not consume the whole {@link MAX_DISCOVERY_TRANSCRIPT_BYTES} history budget.
 */
const MAX_HISTORY_TOOL_RESULT_BYTES = 8_192;

const HISTORY_TRUNCATION_MARKER = '…[truncated to history memory bound]';

/** Replaces evicted turns so the model knows the transcript is a tail, not the whole conversation. */
const HISTORY_EVICTION_STUB = '[Earlier turns were evicted to keep the conversation within the model context budget.]';

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
  // One group per native request turn (the request plus every response message that follows it),
  // so eviction always removes whole turns and never splits a tool-call/tool-result pair.
  const groups: ModelMessage[][] = [];
  let current: ModelMessage[] = [];

  for (const turn of history) {
    if (isRequestTurn(turn)) {
      if (current.length > 0) groups.push(current);
      current = [modelUserMessage(turn.prompt)];
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
        current.push(modelToolCallMessage(calls, response));
        for (const call of calls) {
          current.push(modelToolResultMessage(
            call.callId,
            call.toolName,
            call.result,
          ));
        }
        emittedMetadata = true;
      } else if (response) {
        current.push(modelAssistantMessage(response));
        emittedMetadata = true;
      }
    }

    if (!emittedMetadata) {
      const markdown = responseMarkdown(turn.response);
      if (markdown) current.push(modelAssistantMessage(markdown));
    }
  }
  if (current.length > 0) groups.push(current);

  return boundReplayedHistory(groups, debug);
}

/**
 * Applies the history budget: keeps the newest whole turns that fit both the turn-count and byte
 * ceilings, evicting oldest-first, and replaces anything evicted with one stub message.
 *
 * @remarks
 * The newest turn is exempt from the ceilings: a follow-up prompt without its antecedent turn is
 * worse than a one-turn byte overshoot, which stays bounded because every replayed tool result is
 * individually capped at {@link MAX_HISTORY_TOOL_RESULT_BYTES}.
 */
function boundReplayedHistory(
  groups: readonly (readonly ModelMessage[])[],
  debug?: (msg: string) => void,
): ModelMessage[] {
  const kept: (readonly ModelMessage[])[] = [];
  let bytes = 0;
  for (let index = groups.length - 1; index >= 0; index--) {
    const size = groupBytes(groups[index]);
    if (
      kept.length > 0
      && (kept.length + 1 > MAX_DISCOVERY_TRANSCRIPT_TURNS || bytes + size > MAX_DISCOVERY_TRANSCRIPT_BYTES)
    ) break;
    kept.unshift(groups[index]);
    bytes += size;
  }
  if (kept.length === groups.length) return kept.flat();
  debug?.(
    `history bound evicted ${groups.length - kept.length} of ${groups.length} turn(s), kept ${bytes} bytes`,
  );
  return [modelUserMessage(HISTORY_EVICTION_STUB), ...kept.flat()];
}

const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/**
 * Byte weight of one replayed turn — message text content plus tool-call arguments; only the
 * structural envelope (roles, ids, JSON punctuation of the request itself) is not counted.
 *
 * @remarks
 * `tool_calls[].args` must be counted: a replayed `present_result` or `submit_findings` call
 * carries its whole envelope there while `content` is a short sentence, so measuring `content`
 * alone reports a turn as small and lets the assembled request overrun the very bound this
 * module exists to enforce. `capHistoryToolResult` covers the result side, not the call side.
 */
function groupBytes(group: readonly ModelMessage[]): number {
  return group.reduce((total, message) => {
    const content = message.content;
    const contentBytes = utf8Bytes(typeof content === 'string' ? content : JSON.stringify(content) ?? '');
    const rawCalls: unknown = (message as { tool_calls?: unknown }).tool_calls;
    // Provider-shaped data: a truthy non-array `tool_calls` counts as nothing rather than throwing.
    const calls: readonly { args?: unknown }[] = Array.isArray(rawCalls) ? rawCalls : [];
    const callBytes = calls.reduce((sum, call) => sum + utf8Bytes(JSON.stringify(call.args) ?? ''), 0);
    return total + contentBytes + callBytes;
  }, 0);
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
      result: capHistoryToolResult(toolResultText(results[callId], debug)),
    });
  }

  return calls;
}

/** Caps one replayed tool result at {@link MAX_HISTORY_TOOL_RESULT_BYTES}, marking the cut. */
function capHistoryToolResult(text: string): string {
  if (utf8Bytes(text) <= MAX_HISTORY_TOOL_RESULT_BYTES) return text;
  const budget = MAX_HISTORY_TOOL_RESULT_BYTES - utf8Bytes(HISTORY_TRUNCATION_MARKER);
  return `${longestPrefixFitting(text, (prefix) => utf8Bytes(prefix) <= budget)}${HISTORY_TRUNCATION_MARKER}`;
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
