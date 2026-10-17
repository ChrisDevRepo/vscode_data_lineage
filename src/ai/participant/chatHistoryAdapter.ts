/** Native VS Code chat boundary and history projection for the provider-neutral runtime. */
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
import { GATE_CARD_HEADER, HOLD_GATE_NOTICE, UNREAD_GATE_REPLY } from '../prompting/scopeSummaryRenderer';

/** Replaces evicted turns so the model knows the transcript is a tail, not the whole conversation. */
const HISTORY_EVICTION_STUB = '[Earlier turns were evicted to keep the conversation within the model context budget.]';

/** Replaces the native approval gate's interactive header ({@link GATE_CARD_HEADER}) when a prior card is replayed into history — the plan content that follows stays (a real prior proposal is real context); only the UI-authored framing is not the assistant's own words and is renamed as what it is: a fact about what the user was shown, never a template. */
const GATE_CARD_REPLAY_LEAD_IN = '\n\n_An exploration proposal was shown to the user for review:_\n\n';

interface NativeChatBoundarySession {
  readonly id: string;
  beginNativeChatSession(): void;
}

interface NativePendingGate {
  readonly gateId: string;
}

/** Applies the existing new-chat reset when VS Code supplies an empty history. */
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

/** Converts the current participant's native chat history into ordered graph messages. */
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

/** Names the slash command a plain-text reply continues. */
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

/** Applies the history budget: keeps the newest whole turns that fit both the turn-count and byte ceilings, evicting oldest-first, and replaces anything evicted with one stub message. */
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

/** Strips the native approval gate's UI-only framing from a turn's replayed text. */
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
