/**
 * Native VS Code chat boundary and history projection for the provider-neutral runtime: detects the
 * host's new-chat boundary and converts message shapes. It retains no history and does not select a
 * model, count tokens or define reset behavior (owned by `AiSession`).
 *
 * Prior turns are projected as user and assistant text only. Tool calls and results are never
 * replayed across turns: the participant writes no tool rounds into `ChatResult.metadata`, which VS
 * Code persists with the chat, so database content stays out of that store; a later turn re-reads
 * facts through the phase-valid read tools.
 *
 * Replayed history is capped to the turn-count and byte ceilings of the session's discovery
 * transcript ({@link MAX_DISCOVERY_TRANSCRIPT_TURNS} / {@link contextBlockBytes}), evicting oldest
 * whole turns first, so ever-growing native history cannot push a request past the model's input
 * window. A replayed turn also loses host-written UI framing that never passed through the model;
 * see {@link neutralizeGateCardArtifacts}.
 */
import type * as vscode from 'vscode';
import {
  modelAssistantMessage,
  modelUserMessage,
  type ModelMessage,
} from '../model/modelPort';
import {
  MAX_DISCOVERY_TRANSCRIPT_TURNS,
} from '../session/session';
import { contextBlockBytes, type TurnTokenBudget } from '../support/tokenBudget';
import { HOP_PROGRESS_BLOCK, TURN_STOP_LINE_END } from '../support/text';
import { GATE_CARD_HEADER, HOLD_GATE_NOTICE, REPLACE_ANALYSIS_NOTICE, UNREAD_GATE_REPLY } from '../prompting/scopeSummaryRenderer';

/** Replaces evicted turns so the model knows the transcript is a tail, not the whole chat. */
const HISTORY_EVICTION_STUB = '[Earlier turns were evicted to keep the conversation within the model context budget.]';

/**
 * Replaces the approval gate's interactive header ({@link GATE_CARD_HEADER}) when a prior card is
 * replayed into history. The plan content after it stays (a real prior proposal is real context);
 * only the UI-authored framing, not the assistant's own words, is renamed as what it is: a fact
 * about what the user was shown, never a template.
 */
const GATE_CARD_REPLAY_LEAD_IN = '\n\n_An exploration proposal was shown to the user for review:_\n\n';

interface NativeChatBoundarySession {
  readonly id: string;
  beginNativeChatSession(): void;
}

interface NativePendingGate {
  readonly gateId: string;
}

/**
 * Applies the existing new-chat reset when VS Code supplies an empty history. The optional
 * pending-gate cancellation lets the runtime release an old interrupt before the session is reset;
 * memory details stay with `AiSession.resetExploration()`.
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
 * Converts the participant's native chat history into ordered graph messages.
 *
 * @param budget - The calling turn's budget, which bounds the replayed transcript.
 * @param debug - Optional debug sink that reports evicted turns.
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

    const markdown = neutralizeGateCardArtifacts(responseMarkdown(turn.response));
    if (markdown) current.push(modelAssistantMessage(markdown));
  }
  if (current.length > 0) groups.push(current);

  return boundReplayedHistory(groups, budget, debug);
}

/** `ChatResult.metadata` key set on the reply of a turn that rendered an approval card. */
export const GATE_SHOWN_METADATA = 'gateShown';

/**
 * Names the slash command a plain-text reply continues: the command of the latest request turn when
 * its reply put no approval card in front of the user (a clarifying question, a decline), so the
 * answer stays inside the command the user chose. `undefined` when that request carried no command
 * or its reply's metadata sets {@link GATE_SHOWN_METADATA}, whose next reply belongs to the gate.
 *
 * `ChatRequest.command` is empty on the reply turn though the conversation is still the command's
 * own, and a command is the one mechanical statement of intent the runtime has
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
 * Applies the history budget: keeps the newest whole turns that fit both ceilings, evicting
 * oldest-first, and replaces anything evicted with one stub message. The newest turn is exempt: a
 * follow-up without its antecedent is worse than a one-turn byte overshoot.
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

/** Byte weight of one replayed turn: the UTF-8 size of its message text. */
function groupBytes(group: readonly ModelMessage[]): number {
  return group.reduce((total, message) => {
    const content = message.content;
    return total + utf8Bytes(typeof content === 'string' ? content : JSON.stringify(content) ?? '');
  }, 0);
}

/**
 * Strips the approval gate's UI-only framing from a turn's replayed text. `lineageParticipant.ts`
 * writes {@link GATE_CARD_HEADER} and {@link HOLD_GATE_NOTICE} around a pending card, and a gate
 * reply may write {@link UNREAD_GATE_REPLY}, straight to the chat stream; the model never generated
 * it, but `ChatResponseTurn.response` carries it verbatim into {@link chatHistoryToModelMessages}
 * via {@link responseMarkdown}. Replayed unchanged it reads as the assistant's own utterance, a
 * template ("Approve, change or cancel with the buttons below") with no origin, columns or tool
 * call, which the model then completes as text instead of calling `lineage_start_exploration`
 * again. The plan between header and trailer is kept; only the interactive frame is not context.
 * A recoverable stop line (ends in {@link TURN_STOP_LINE_END}) quotes provider text: it is dropped
 * too, and so is each per-hop progress block ({@link HOP_PROGRESS_BLOCK}): its `Hop n/m` count
 * shifts as scope prunes and the report below carries the findings.
 */
function neutralizeGateCardArtifacts(markdown: string): string {
  if (!markdown) return markdown;
  return markdown
    .replace(HOP_PROGRESS_BLOCK, '')
    .split(GATE_CARD_HEADER).join(GATE_CARD_REPLAY_LEAD_IN)
    .split(HOLD_GATE_NOTICE).join('')
    .split(REPLACE_ANALYSIS_NOTICE).join('')
    .split(UNREAD_GATE_REPLY).join('')
    .split('\n').filter(line => !line.endsWith(TURN_STOP_LINE_END)).join('\n');
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
