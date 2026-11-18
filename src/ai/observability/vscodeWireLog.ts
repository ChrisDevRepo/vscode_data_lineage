/**
 * VS Code specific half of the wire capture: projects native chat messages onto
 * {@link WireMessage}. Split out of [`wireLog.ts`](./wireLog.ts) so the record surface stays free
 * of `vscode` imports; only the `vscode.lm` lane pays for `LanguageModelTextPart` and friends, and
 * every other model port emits the same records without loading the VS Code API.
 */
import * as vscode from 'vscode';
import { safeTraceStringify, type WireMessage, type WirePart } from './wireLog';

/** Normalizes one converted message, preserving the role integer verbatim. */
export function toWireMessage(message: vscode.LanguageModelChatMessage): WireMessage {
  return { role: message.role, parts: message.content.map(toWirePart) };
}

/** Normalizes one native message part; a part not modeled is kept as `other` JSON. */
export function toWirePart(part: unknown): WirePart {
  if (part instanceof vscode.LanguageModelTextPart) {
    return { type: 'text', value: part.value };
  }
  if (part instanceof vscode.LanguageModelToolCallPart) {
    return { type: 'tool-call', callId: part.callId, name: part.name, input: part.input };
  }
  if (part instanceof vscode.LanguageModelToolResultPart) {
    return { type: 'tool-result', callId: part.callId, content: part.content.map(toWirePart) };
  }
  return { type: 'other', json: safeTraceStringify(part) };
}
