/**
 * Authoritative owner of the chat-message array sent to `model.sendRequest`.
 *
 * @remarks
 * Three concerns concentrated in one place:
 *  1. **Tool-use ↔ tool-result pairing.** Every {@link vscode.LanguageModelToolResultPart}
 *     in a User message must be preceded immediately by an Assistant message
 *     whose content includes a {@link vscode.LanguageModelToolCallPart} with the
 *     matching `callId`. The Bedrock-Anthropic backend collapses consecutive
 *     same-role messages, so an orphaned `tool_result` after such a collapse
 *     surfaces as `messages.0.content.N: unexpected tool_use_id` (HTTP 400).
 *     {@link MessageEnvelope.assertWellFormed} verifies the invariant before send.
 *  2. **Single source of truth for the sliding-memory rebuild recipe.** The
 *     `[User(sys), User(user), lastAssistant?, lastResult?]` layout used by
 *     synthesis entry, the per-hop sliding wipe, and the bounded-error wipe is
 *     produced by exactly one method: {@link MessageEnvelope.wipeAndSeed}. Adding
 *     a fifth call site cannot reintroduce a drop-the-pair regression because
 *     the helper preserves both messages or neither.
 *  3. **Pair lookup by content shape, not by index.** Notices, gates, and abort
 *     payloads can appear between the last tool turn and a wipe. Index-based
 *     captures (`messages[length - 2]`, `messages[length - 1]`) silently shift
 *     when that happens; {@link MessageEnvelope.findLastToolPair} scans for the
 *     trailing `Assistant(tool_use) → User(tool_result)` adjacency by structure.
 *
 * The validation logic itself lives in {@link ./messageEnvelopeCore} so it can
 * be unit-tested under `tsx` without the VS Code runtime.
 */

import * as vscode from 'vscode';
import {
  assertWellFormedShape,
  findLastToolPairShape,
  snapshotShape,
  type MessageShape,
  type MessagePartShape,
} from './messageEnvelopeCore';

export { MessageEnvelopeInvariantError } from './messageEnvelopeCore';

/** A matched `(Assistant tool_use, User tool_result)` adjacency from the envelope tail. */
export interface ToolPair {
  /** Assistant message containing one or more {@link vscode.LanguageModelToolCallPart}. */
  assistant: vscode.LanguageModelChatMessage;
  /** User message containing one or more {@link vscode.LanguageModelToolResultPart}, all of whose `callId`s match `assistant`. */
  result: vscode.LanguageModelChatMessage;
}

/**
 * Mutable, role-aware container for the chat-message array passed to
 * {@link vscode.LanguageModelChat.sendRequest}.
 */
export class MessageEnvelope {
  private msgs: vscode.LanguageModelChatMessage[] = [];

  /** Initial seed: `[User(systemPrompt), …history, User(userPrompt)]`. */
  public seed(
    systemPrompt: string,
    userPrompt: string,
    history: vscode.LanguageModelChatMessage[] = [],
  ): void {
    this.msgs = [
      vscode.LanguageModelChatMessage.User(systemPrompt),
      ...history,
      vscode.LanguageModelChatMessage.User(userPrompt),
    ];
  }

  /** Replaces the system-prompt slot at index 0. Called when a phase change regenerates the prompt. */
  public setSystemPrompt(systemPrompt: string): void {
    if (this.msgs.length === 0) {
      throw new Error('MessageEnvelope.setSystemPrompt: envelope not seeded');
    }
    this.msgs[0] = vscode.LanguageModelChatMessage.User(systemPrompt);
  }

  /** Append a fully-formed message. */
  public push(message: vscode.LanguageModelChatMessage): void {
    this.msgs.push(message);
  }

  /** Append an Assistant message with the given content parts (text and/or tool_call). */
  public pushAssistant(parts: readonly (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[]): void {
    this.msgs.push(new vscode.LanguageModelChatMessage(
      vscode.LanguageModelChatMessageRole.Assistant,
      parts as (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[],
    ));
  }

  /** Append a User message carrying a batch of tool_result parts. */
  public pushUserToolResults(parts: readonly vscode.LanguageModelToolResultPart[]): void {
    this.msgs.push(new vscode.LanguageModelChatMessage(
      vscode.LanguageModelChatMessageRole.User,
      parts as vscode.LanguageModelToolResultPart[],
    ));
  }

  /** Append a User text message. */
  public pushUserText(text: string): void {
    this.msgs.push(vscode.LanguageModelChatMessage.User(text));
  }

  /** Read-only view for `model.sendRequest`, `model.countTokens`, etc. */
  public toArray(): readonly vscode.LanguageModelChatMessage[] {
    return this.msgs;
  }

  /** Number of messages currently in the envelope. */
  public get length(): number {
    return this.msgs.length;
  }

  /**
   * Returns the trailing `(Assistant tool_use, User tool_result)` adjacency, by
   * content shape — the last message must contain a tool_result whose `callId`s
   * are all present as tool_uses in the message immediately before it.
   */
  public findLastToolPair(): ToolPair | undefined {
    const hit = findLastToolPairShape(this.shapes());
    if (!hit) return undefined;
    return {
      assistant: this.msgs[hit.assistantIdx],
      result: this.msgs[hit.resultIdx],
    };
  }

  /**
   * Wipe the envelope and reseed with the fixed sliding-memory layout:
   * `[User(sys), User(user), assistant?, result?]`.
   *
   * @param systemPrompt - Goes into the `User(sys)` slot at index 0.
   * @param userPrompt - Goes into the `User(user)` slot at index 1.
   * @param lastTurn - Optional `(Assistant tool_use, User tool_result)` pair to
   * preserve at indices 2 and 3. When omitted, auto-detected via
   * {@link MessageEnvelope.findLastToolPair} **before** clearing. Either both
   * messages of the pair are kept, or neither is — there is no path that
   * produces an orphaned `tool_result`.
   */
  public wipeAndSeed(systemPrompt: string, userPrompt: string, lastTurn?: ToolPair): void {
    const pair = lastTurn ?? this.findLastToolPair();
    const next: vscode.LanguageModelChatMessage[] = [
      vscode.LanguageModelChatMessage.User(systemPrompt),
      vscode.LanguageModelChatMessage.User(userPrompt),
    ];
    if (pair) next.push(pair.assistant, pair.result);
    this.msgs = next;
  }

  /**
   * Verifies that every tool_result in the envelope has a matching tool_use in
   * the message immediately before it.
   *
   * @throws {MessageEnvelopeInvariantError} when an orphaned tool_result is
   * found — a state that would otherwise produce an HTTP 400 from the LM API
   * after Bedrock User-merge.
   */
  public assertWellFormed(): void {
    assertWellFormedShape(this.shapes());
  }

  /** Compact role+content-kinds dump for debug snapshots. */
  public snapshot(): string {
    return snapshotShape(this.shapes());
  }

  private shapes(): MessageShape[] {
    return this.msgs.map(m => ({
      role: m.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant',
      parts: this.partShapes(m),
    }));
  }

  private partShapes(msg: vscode.LanguageModelChatMessage): MessagePartShape[] {
    const out: MessagePartShape[] = [];
    for (const p of msg.content as readonly unknown[]) {
      if (p instanceof vscode.LanguageModelTextPart) out.push({ kind: 'text' });
      else if (p instanceof vscode.LanguageModelToolCallPart) out.push({ kind: 'tool_use', callId: p.callId });
      else if (p instanceof vscode.LanguageModelToolResultPart) out.push({ kind: 'tool_result', callId: p.callId });
    }
    return out;
  }
}
