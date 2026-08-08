/**
 * VS Code specific half of the wire capture: projecting native chat messages onto {@link WireMessage}.
 *
 * @remarks
 * Split out of [`wireLog.ts`](./wireLog.ts) so the record surface itself stays free of `vscode`
 * imports. Only this module knows `LanguageModelTextPart` and friends, which means only the
 * `vscode.lm` lane pays for them; every other model port emits the same records without loading the
 * VS Code API at all.
 */
import * as vscode from 'vscode';
import { safeTraceStringify, type WireMessage, type WirePart } from './wireLog';

/** Normalizes one converted message, preserving the role integer verbatim. */
export function toWireMessage(message: vscode.LanguageModelChatMessage): WireMessage {
  return { role: message.role, parts: message.content.map(toWirePart) };
}

function toWirePart(part: unknown): WirePart {
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
