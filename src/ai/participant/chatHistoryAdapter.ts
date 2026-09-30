/**
 * Native VS Code chat boundary and history projection for the provider-neutral runtime.
 *
 * This adapter detects the host's new-chat boundary and converts message shapes.
 * It does not retain history, select a model, count tokens, or define memory
 * reset behavior; reset semantics remain owned by `AiSession`.
 *
 * The projection is bounded: replayed history is capped to the same turn-count and byte ceilings
 * as the session's canonical discovery transcript ({@link MAX_DISCOVERY_TRANSCRIPT_TURNS} /
 * {@link contextBlockBytes}), evicting oldest whole turns first, so native history —
 * which only grows — can never push the assembled request past a model's input window.
 *
 * A replayed turn is also stripped of host-written UI framing (the approval gate's card header
 * and button-reference notices) that never passed through the model — see
 * {@link neutralizeGateCardArtifacts}.
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
  MAX_DISCOVERY_TRANSCRIPT_TURNS,
} from '../session/session';
import { contextBlockBytes, type TurnTokenBudget } from '../support/tokenBudget';
import { safeIdentifier } from '../support/logIdentifier';
import { GATE_CARD_HEADER, HOLD_GATE_NOTICE, UNREAD_GATE_REPLY } from '../prompting/scopeSummaryRenderer';

/**
 * Maximum UTF-8 bytes of one historical tool result replayed — a single 60 KB DDL payload in an
 * old round must not consume the whole {@link contextBlockBytes} history budget; a larger result
 * is dropped with its call.
 */
const MAX_HISTORY_TOOL_RESULT_BYTES = 8_192;

/** Replaces evicted turns so the model knows the transcript is a tail, not the whole conversation. */
const HISTORY_EVICTION_STUB = '[Earlier turns were evicted to keep the conversation within the model context budget.]';

/**
 * Replaces the native approval gate's interactive header ({@link GATE_CARD_HEADER}) when a prior
 * card is replayed into history — the plan content that follows stays (a real prior proposal is
 * real context); only the UI-authored framing is not the assistant's own words and is renamed as
 * what it is: a fact about what the user was shown, never a template.
 */
const GATE_CARD_REPLAY_LEAD_IN = '\n\n_An exploration proposal was shown to the user for review:_\n\n';

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
 * @param budget - The calling turn's budget, which bounds the replayed transcript.
 * @param debug - Optional debug sink; a malformed history value that degrades to an empty
 *   string must be observable, never a silent skip.
 */
export function chatHistoryToModelMessages(
  history: vscode.ChatContext['history'],
  budget: TurnTokenBudget,
  debug?: (msg: string) => void,
): ModelMessage[] {
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
      const response = neutralizeGateCardArtifacts(typeof round.response === 'string' ? round.response : '');
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
      const markdown = neutralizeGateCardArtifacts(responseMarkdown(turn.response));
      if (markdown) current.push(modelAssistantMessage(markdown));
    }
  }
  if (current.length > 0) groups.push(current);

  return boundReplayedHistory(groups, budget, debug);
}

/** `ChatResult.metadata` key set on the reply of a turn that rendered an approval card. */
export const GATE_SHOWN_METADATA = 'gateShown';

/**
 * Names the slash command a plain-text reply continues.
 *
 * @param history - The native VS Code chat history for this participant.
 * @returns The command of the latest request turn when its reply put no approval card in front of
 *   the user (a clarifying question, a decline), so the answer to that question stays inside the
 *   command the user chose; `undefined` when the latest request carried no command or its reply's
 *   result metadata sets {@link GATE_SHOWN_METADATA}, whose next reply belongs to the gate.
 * @remarks
 * `ChatRequest.command` is empty on the reply turn even though the conversation is still the
 * command's own request, and a command is the one mechanical statement of intent the runtime has
 * (`slashCommands.ts`). The caller applies this only while the session is idle.
 */
export function continuedSlashCommand(history: vscode.ChatContext['history']): string | undefined {
  let latestRequestIndex = -1;
  for (let index = history.length - 1; index >= 0; index--) {
    if (isRequestTurn(history[index])) { latestRequestIndex = index; break; }
  }
  if (latestRequestIndex < 0) return undefined;
  const request = history[latestRequestIndex] as vscode.ChatRequestTurn;
  if (!request.command) return undefined;
  const reply = history[latestRequestIndex + 1];
  const gateShown = reply !== undefined && !isRequestTurn(reply)
    && record(record(reply.result)?.metadata)?.[GATE_SHOWN_METADATA] === true;
  return gateShown ? undefined : request.command;
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
  budget: TurnTokenBudget,
  debug?: (msg: string) => void,
): ModelMessage[] {
  const kept: (readonly ModelMessage[])[] = [];
  let bytes = 0;
  for (let index = groups.length - 1; index >= 0; index--) {
    const size = groupBytes(groups[index]);
    if (
      kept.length > 0
      && (kept.length + 1 > MAX_DISCOVERY_TRANSCRIPT_TURNS || bytes + size > contextBlockBytes(budget))
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
    const result = toolResultText(results[callId], debug);
    if (!fitsHistoryToolResult(result, toolName, debug)) continue;
    calls.push({ callId, toolName, input, result });
  }

  return calls;
}

/**
 * Reports whether one replayed tool result fits {@link MAX_HISTORY_TOOL_RESULT_BYTES}; a result that
 * does not is dropped whole with its call, never cut, and the drop is logged so a reader
 * reconstructing a hop from `host.log` can tell prior-turn evidence was left out.
 */
function fitsHistoryToolResult(text: string, toolName: string, debug?: (msg: string) => void): boolean {
  const bytes = utf8Bytes(text);
  if (bytes <= MAX_HISTORY_TOOL_RESULT_BYTES) return true;
  debug?.(
    `history tool call dropped whole tool=${safeIdentifier(toolName, { extraChars: '.:-', replacement: '_', maxLength: 100, fallback: 'unknown' })}`
    + ` bytes=${bytes} cap=${MAX_HISTORY_TOOL_RESULT_BYTES}`,
  );
  return false;
}

function toolResultText(value: unknown, debug?: (msg: string) => void): string {
  const result = record(value);
  if (!Array.isArray(result?.content)) return stringify(value, debug);
  return result.content.map((part) => {
    const content = record(part);
    return typeof content?.value === 'string' ? content.value : stringify(part, debug);
  }).join('');
}

/**
 * Strips the native approval gate's UI-only framing from a turn's replayed text.
 *
 * @remarks
 * `lineageParticipant.ts` writes {@link GATE_CARD_HEADER} and {@link HOLD_GATE_NOTICE} around a
 * pending card, and a gate reply may write {@link UNREAD_GATE_REPLY}, straight to the chat stream —
 * text the model never generated and never saw as its own. `ChatResponseTurn.response` carries it
 * verbatim regardless, and the `toolCallsMetadata` round that would otherwise describe the
 * exchange structurally is absent for a turn that ends on `hold` (no `toolCalls` array is
 * recorded), so this text reaches {@link chatHistoryToModelMessages} through both the round
 * `response` field and the {@link responseMarkdown} fallback. Replayed unchanged, it reads as the
 * assistant's own prior utterance — a template complete with "Approve, change or cancel with the
 * buttons below" and no origin, columns, or tool call attached to it — and the model then
 * completes that template as text on the next turn instead of calling
 * `lineage_start_exploration` again. The plan content in between the header and the trailer is
 * kept: a real prior proposal is real context, only the interactive frame around it is not.
 */
function neutralizeGateCardArtifacts(markdown: string): string {
  if (!markdown) return markdown;
  return markdown
    .split(GATE_CARD_HEADER).join(GATE_CARD_REPLAY_LEAD_IN)
    .split(HOLD_GATE_NOTICE).join('')
    .split(UNREAD_GATE_REPLY).join('');
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
    debug?.(`history value not serializable — dropped (${err instanceof Error ? err.message : String(err)})`);
    return '';
  }
}
