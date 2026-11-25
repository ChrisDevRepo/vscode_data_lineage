/**
 * Full-array structural validation of a model-bound message history. Providers reject a history in
 * which a tool result has no call on the nearest preceding assistant message, or a tool call has no
 * result before the next turn, but only with an opaque transport error (HTTP 400
 * `unexpected tool_use_id` / `tool_use ids were found without tool_result`) deep in the provider
 * stack. A suffix cut of a paired transcript (the cut point chosen by `trimMessages`, not the
 * runtime) can produce the first shape; asserting both at the send chokepoint turns either into a
 * diagnosable internal error with a compact structural snapshot. Pure and vscode-free; the
 * snapshot carries roles and tail-truncated call ids only, never message content.
 */
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';

/** Thrown when a message array would be rejected by the provider for a tool-pairing mismatch. */
class MessageEnvelopeInvariantError extends Error {
  constructor(public readonly reason: string, public readonly snapshot: string) {
    super(`Message envelope invariant violated: ${reason} | snapshot=${snapshot}`);
    this.name = 'MessageEnvelopeInvariantError';
  }
}

function tailId(id: string | undefined): string {
  return id ? id.slice(-8) : 'none';
}

/** Compact role + tool-id dump for diagnostics; call ids are tail-truncated, content omitted. */
function snapshotMessages(messages: readonly BaseMessage[]): string {
  return messages.map((message, index) => {
    if (AIMessage.isInstance(message) && message.tool_calls?.length) {
      return `[${index}]ai{${message.tool_calls.map((call) => `c:${tailId(call.id)}`).join(',')}}`;
    }
    if (ToolMessage.isInstance(message)) {
      return `[${index}]tool{r:${tailId(message.tool_call_id)}}`;
    }
    return `[${index}]${message.getType()}`;
  }).join(' ');
}

/**
 * Verifies every tool message answers a unique tool call on the nearest preceding assistant message
 * and every tool call is answered by a unique tool message directly after it (strict 1:1 pairing).
 *
 * @throws An internal invariant error naming the first unpaired or duplicate tool message or call,
 *   with a structural snapshot of roles and tail-truncated call ids.
 */
export function assertToolPairingWellFormed(messages: readonly BaseMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (AIMessage.isInstance(message) && message.tool_calls?.length) {
      const seenCallIds = new Set<string>();
      for (const call of message.tool_calls) {
        const id = call.id ?? '';
        if (seenCallIds.has(id)) {
          throw new MessageEnvelopeInvariantError(
            `duplicate tool_call id="${tailId(call.id)}" at messages[${i}]`,
            snapshotMessages(messages),
          );
        }
        seenCallIds.add(id);
      }
      const answered = new Set<string>();
      for (let next = i + 1; next < messages.length; next++) {
        const result = messages[next];
        if (!ToolMessage.isInstance(result)) break;
        if (answered.has(result.tool_call_id)) {
          throw new MessageEnvelopeInvariantError(
            `duplicate tool_call_id="${tailId(result.tool_call_id)}" at messages[${next}]`,
            snapshotMessages(messages),
          );
        }
        answered.add(result.tool_call_id);
      }
      const unanswered = message.tool_calls.find((call) => !answered.has(call.id ?? ''));
      if (unanswered) {
        throw new MessageEnvelopeInvariantError(
          `tool_call id="${tailId(unanswered.id)}" at messages[${i}] has no tool result`,
          snapshotMessages(messages),
        );
      }
    }
    if (!ToolMessage.isInstance(message)) continue;
    let anchor = i - 1;
    while (anchor >= 0 && ToolMessage.isInstance(messages[anchor])) anchor--;
    const assistant = anchor >= 0 ? messages[anchor] : undefined;
    if (!AIMessage.isInstance(assistant)) {
      throw new MessageEnvelopeInvariantError(
        `tool message at messages[${i}] has no preceding assistant message`,
        snapshotMessages(messages),
      );
    }
    const callIds = new Set((assistant.tool_calls ?? []).map((call) => call.id));
    if (!callIds.has(message.tool_call_id)) {
      throw new MessageEnvelopeInvariantError(
        `tool_call_id="${tailId(message.tool_call_id)}" at messages[${i}] has no matching tool call on messages[${anchor}]`,
        snapshotMessages(messages),
      );
    }
  }
}
