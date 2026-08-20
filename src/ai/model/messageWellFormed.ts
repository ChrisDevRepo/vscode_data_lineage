/**
 * Full-array structural validation of a model-bound message history.
 *
 * @remarks
 * Providers reject a history whose tool results do not pair with the tool calls of the nearest
 * preceding assistant message — but only with an opaque transport error (HTTP 400
 * `unexpected tool_use_id`) raised deep in the provider stack. Asserting the invariant at the
 * send chokepoint turns a latent composition bug in any history-splicing site into a diagnosable
 * internal error carrying a compact structural snapshot. Pure and vscode-free; the snapshot
 * carries roles and tail-truncated call ids only, never message content.
 */
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';

/** Thrown when a message array would be rejected by the provider for a tool-pairing mismatch. */
export class MessageEnvelopeInvariantError extends Error {
  constructor(public readonly reason: string, public readonly snapshot: string) {
    super(`Message envelope invariant violated: ${reason} | snapshot=${snapshot}`);
    this.name = 'MessageEnvelopeInvariantError';
  }
}

function tailId(id: string | undefined): string {
  return id ? id.slice(-8) : 'none';
}

/** Compact role + tool-id dump for diagnostics; call ids are tail-truncated, content omitted. */
export function snapshotMessages(messages: readonly BaseMessage[]): string {
  return messages.map((message, index) => {
    if (message instanceof AIMessage && message.tool_calls?.length) {
      return `[${index}]ai{${message.tool_calls.map((call) => `c:${tailId(call.id)}`).join(',')}}`;
    }
    if (message instanceof ToolMessage) {
      return `[${index}]tool{r:${tailId(message.tool_call_id)}}`;
    }
    return `[${index}]${message.getType()}`;
  }).join(' ');
}

/**
 * Verifies every tool message pairs with a tool call on the nearest preceding assistant message.
 *
 * @throws {@link MessageEnvelopeInvariantError} on the first orphaned tool message.
 */
export function assertToolPairingWellFormed(messages: readonly BaseMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!(message instanceof ToolMessage)) continue;
    // Consecutive tool messages all answer the same assistant turn; walk back to its anchor.
    let anchor = i - 1;
    while (anchor >= 0 && messages[anchor] instanceof ToolMessage) anchor--;
    const assistant = anchor >= 0 ? messages[anchor] : undefined;
    if (!(assistant instanceof AIMessage)) {
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
