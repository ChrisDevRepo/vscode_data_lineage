/**
 * Pure SM sliding-memory policy for the native LangGraph host.
 *
 * @remarks
 * The graph reseeds the thread to a single continuation anchor at approval and after every
 * committed hop, so nothing needs trimming there. This module handles the one remaining case —
 * the active loop stopping incomplete — by keeping the anchor plus the last well-formed tool pair.
 */

import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { ModelMessage } from '../model/modelPort';

/** Index pair locating the trailing `(assistant tool-call, tool tool-result)` adjacency. */
interface ToolPairIndices {
  /** Index of the assistant message carrying the tool-call part(s). */
  readonly assistantIdx: number;
  /** Index of the immediately-following tool message carrying the matching tool-result part(s). */
  readonly toolIdx: number;
}

/**
 * Reads complete tool-call identities from one LangChain AI message.
 */
function assistantCallIds(msg: ModelMessage): Set<string> {
  if (!AIMessage.isInstance(msg)) return new Set();
  return new Set(
    (msg.tool_calls ?? [])
      .map((call) => call.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
}

/**
 * Finds the trailing `(assistant tool-call, tool tool-result)` pair by content shape: the last
 * `tool`-role message whose tool-call ids are all answered by the assistant message immediately
 * before it.
 *
 * @returns The index pair, or `null` when no well-formed adjacency exists (so the caller keeps
 * neither half — there is no path that produces an orphaned tool-result).
 */
function findLastToolPair(messages: readonly ModelMessage[]): ToolPairIndices | null {
  for (let i = messages.length - 1; i >= 1; i--) {
    const result = messages[i];
    if (!ToolMessage.isInstance(result) || !result.tool_call_id) continue;
    const callIds = assistantCallIds(messages[i - 1]);
    if (!callIds.has(result.tool_call_id)) return null;
    return { assistantIdx: i - 1, toolIdx: i };
  }
  return null;
}

/**
 * Extracts the tail worth keeping from an accumulated history: a single leading user anchor plus
 * the last well-formed tool pair. Used when the active loop ends incomplete; a committed hop is
 * reseeded to the anchor alone by the graph.
 *
 * @remarks
 * The stable prefix (mission brief, contract, discovery summary) rides in the re-rendered `system`
 * override, not in `messages`; the rolling `<short_term_memory>` block rides in the per-hop user
 * message.
 *
 * @param anchor - The synthesized leading user message (host-owned continuation directive).
 */
export function extractShortTermMemory(messages: readonly ModelMessage[], anchor: ModelMessage): ModelMessage[] {
  const pair = findLastToolPair(messages);
  if (!pair) return [anchor];
  return [anchor, messages[pair.assistantIdx], messages[pair.toolIdx]];
}
