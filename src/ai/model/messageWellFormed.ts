/**
 * Full-array structural validation of a model-bound message history.
 *
 * @remarks
 * Providers reject a history whose tool result has no call on the nearest preceding assistant
 * message — but only with an opaque transport error (HTTP 400 `unexpected tool_use_id`) raised deep
 * in the provider stack. That is the one shape a suffix cut of a paired transcript can produce, and
 * the cut point is chosen by `trimMessages`, not by the runtime; asserting it at the send
 * chokepoint turns a cut that opens mid-group into a diagnosable internal error carrying a compact
 * structural snapshot. A call without a result is not checked: the attempt that dispatches a batch
 * is its only author and returns a message group only when every call is answered. Pure and
 * vscode-free; the snapshot carries roles and tail-truncated call ids only, never message content.
 */
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { InternalInvariantError } from '../support/internalInvariant';

/** Thrown when a message array would be rejected by the provider for a tool-pairing mismatch. */
class MessageEnvelopeInvariantError extends InternalInvariantError {
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
 * Verifies every tool message answers a tool call on the nearest preceding assistant message.
 *
 * @throws An internal invariant error naming the first tool message without its call, with a
 *   structural snapshot of roles and tail-truncated call ids.
 */
export function assertToolPairingWellFormed(messages: readonly BaseMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
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
