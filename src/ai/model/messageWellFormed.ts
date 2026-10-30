/** Full-array structural validation of a model-bound message history. */
import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { InternalInvariantError } from '../support/internalInvariant';

/** Thrown when a message array would be rejected by the provider for a tool-pairing mismatch. */
class MessageEnvelopeInvariantError extends InternalInvariantError {
  constructor(
    public readonly reason: string,
    public readonly snapshot: string,
  ) {
    super(
      `Message envelope invariant violated: ${reason} | snapshot=${snapshot}`,
    );
    this.name = 'MessageEnvelopeInvariantError';
  }
}

function tailId(id: string | undefined): string {
  return id ? id.slice(-8) : 'none';
}

/** Compact role + tool-id dump for diagnostics; call ids are tail-truncated, content omitted. */
function snapshotMessages(messages: readonly BaseMessage[]): string {
  return messages
    .map((message, index) => {
      if (AIMessage.isInstance(message) && message.tool_calls?.length) {
        return `[${index}]ai{${message.tool_calls.map((call) => `c:${tailId(call.id)}`).join(',')}}`;
      }
      if (ToolMessage.isInstance(message)) {
        return `[${index}]tool{r:${tailId(message.tool_call_id)}}`;
      }
      return `[${index}]${message.getType()}`;
    })
    .join(' ');
}

/** Verifies every tool message answers a tool call on the nearest preceding assistant message. */
export function assertToolPairingWellFormed(
  messages: readonly BaseMessage[],
): void {
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
    const callIds = new Set(
      (assistant.tool_calls ?? []).map((call) => call.id),
    );
    if (!callIds.has(message.tool_call_id)) {
      throw new MessageEnvelopeInvariantError(
        `tool_call_id="${tailId(message.tool_call_id)}" at messages[${i}] has no matching tool call on messages[${anchor}]`,
        snapshotMessages(messages),
      );
    }
  }
}
