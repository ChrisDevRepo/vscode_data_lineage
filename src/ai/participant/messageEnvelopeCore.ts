/**
 * Pure (vscode-free) core of {@link MessageEnvelope} — operates on abstract
 * message shapes so it can be unit-tested under `tsx` without the VS Code
 * runtime.
 *
 * @remarks
 * The participant talks to the LM API in {@link vscode.LanguageModelChatMessage}
 * objects whose role is an enum and whose parts are discriminated via
 * `instanceof`. That makes the wrapper concrete; the **invariant logic** here
 * is structural only — it sees `{ role, parts: [{kind, callId?}] }` and can be
 * exercised with plain-object fixtures.
 */

/** Discriminated content-part shape used by the structural validator. */
export interface MessagePartShape {
  kind: 'text' | 'tool_use' | 'tool_result';
  /** Present on `tool_use` and `tool_result` parts; the LM API requires equal callIds across the pair. */
  callId?: string;
}

/** Discriminated message shape used by the structural validator. */
export interface MessageShape {
  role: 'user' | 'assistant';
  parts: MessagePartShape[];
}

/**
 * Thrown by {@link assertWellFormedShape} when the array would be rejected by
 * the LM API for a `tool_use`/`tool_result` mismatch (manifested as HTTP 400
 * `messages.0.content.N: unexpected tool_use_id` after Bedrock User-merge).
 */
export class MessageEnvelopeInvariantError extends Error {
  constructor(public readonly reason: string, public readonly snapshot: string) {
    super(`MessageEnvelope invariant violated: ${reason} | snapshot=${snapshot}`);
    this.name = 'MessageEnvelopeInvariantError';
  }
}

/**
 * Verifies that every `tool_result` part in the array has a matching `tool_use`
 * part in the message immediately preceding it, with the same `callId`.
 *
 * @throws {MessageEnvelopeInvariantError} on the first orphan encountered.
 */
export function assertWellFormedShape(msgs: readonly MessageShape[]): void {
  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    if (msg.role !== 'user') continue;
    const resultIds: string[] = [];
    for (const p of msg.parts) {
      if (p.kind === 'tool_result' && p.callId) resultIds.push(p.callId);
    }
    if (resultIds.length === 0) continue;

    const prev = i > 0 ? msgs[i - 1] : undefined;
    if (!prev || prev.role !== 'assistant') {
      throw new MessageEnvelopeInvariantError(
        `tool_result at messages[${i}] has no preceding Assistant message`,
        snapshotShape(msgs),
      );
    }
    const useIds = new Set<string>();
    for (const p of prev.parts) {
      if (p.kind === 'tool_use' && p.callId) useIds.add(p.callId);
    }
    for (const callId of resultIds) {
      if (!useIds.has(callId)) {
        throw new MessageEnvelopeInvariantError(
          `tool_result.callId="${callId}" at messages[${i}] has no matching tool_use in messages[${i - 1}]`,
          snapshotShape(msgs),
        );
      }
    }
  }
}

/**
 * Returns the trailing `(Assistant tool_use, User tool_result)` adjacency by
 * structural inspection of the tail.
 *
 * @returns Indexes of the matched pair, or `undefined` if the last two
 * messages are not a tool_use/tool_result adjacency with matching callIds.
 */
export function findLastToolPairShape(
  msgs: readonly MessageShape[],
): { assistantIdx: number; resultIdx: number } | undefined {
  if (msgs.length < 2) return undefined;
  const resultIdx = msgs.length - 1;
  const result = msgs[resultIdx];
  if (result.role !== 'user') return undefined;
  const resultIds = result.parts
    .filter(p => p.kind === 'tool_result' && !!p.callId)
    .map(p => p.callId as string);
  if (resultIds.length === 0) return undefined;

  const assistantIdx = resultIdx - 1;
  const assistant = msgs[assistantIdx];
  if (assistant.role !== 'assistant') return undefined;
  const useIds = new Set<string>();
  for (const p of assistant.parts) {
    if (p.kind === 'tool_use' && p.callId) useIds.add(p.callId);
  }
  for (const id of resultIds) {
    if (!useIds.has(id)) return undefined;
  }
  return { assistantIdx, resultIdx };
}

/** Compact role+content-kinds dump for debug snapshots. callIds are tail-truncated. */
export function snapshotShape(msgs: readonly MessageShape[]): string {
  return msgs.map((m, i) => {
    const role = m.role === 'user' ? 'U' : 'A';
    const kinds: string[] = [];
    for (const p of m.parts) {
      if (p.kind === 'text') kinds.push('t');
      else if (p.kind === 'tool_use') kinds.push(`c:${tailId(p.callId)}`);
      else kinds.push(`r:${tailId(p.callId)}`);
    }
    return `[${i}]${role}{${kinds.join(',')}}`;
  }).join(' ');
}

function tailId(id: string | undefined): string {
  if (!id) return '?';
  return id.length > 6 ? id.slice(-6) : id;
}

