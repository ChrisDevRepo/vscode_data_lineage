/**
 * Full-array tool-pairing assertion guarding the tool-turn send chokepoint.
 *
 * @remarks
 * The invariant mirrors what providers enforce with an opaque HTTP 400: every tool message must
 * pair with a tool call on the nearest preceding assistant message. Histories are composed with
 * the same modelPort helpers the runtime uses.
 */
import { describe, expect, it } from 'vitest';
import {
  MessageEnvelopeInvariantError,
  assertToolPairingWellFormed,
  snapshotMessages,
} from '../../../src/ai/model/messageWellFormed';
import {
  modelAssistantMessage,
  modelSystemMessage,
  modelToolCallMessage,
  modelToolResultMessage,
  modelUserMessage,
} from '../../../src/ai/model/modelPort';

const call = (id: string) => ({ callId: id, toolName: 'lineage_tool', input: { q: 1 } });

describe('assertToolPairingWellFormed', () => {
  it('accepts a well-formed history including a multi-result tool turn', () => {
    const messages = [
      modelSystemMessage('s'),
      modelUserMessage('question'),
      modelToolCallMessage([call('a1'), call('a2')]),
      modelToolResultMessage('a1', 'lineage_tool', 'r1'),
      modelToolResultMessage('a2', 'lineage_tool', 'r2'),
      modelAssistantMessage('answer'),
      modelUserMessage('follow-up'),
    ];

    expect(() => { assertToolPairingWellFormed(messages); }).not.toThrow();
  });

  it('rejects a tool message with no preceding assistant message', () => {
    const messages = [
      modelUserMessage('question'),
      modelToolResultMessage('a1', 'lineage_tool', 'r1'),
    ];

    expect(() => { assertToolPairingWellFormed(messages); })
      .toThrow(MessageEnvelopeInvariantError);
    expect(() => { assertToolPairingWellFormed(messages); })
      .toThrow(/messages\[1\] has no preceding assistant message/);
  });

  it('rejects a mid-array orphan whose id matches no call on its anchor', () => {
    const messages = [
      modelUserMessage('question'),
      modelToolCallMessage([call('a1')]),
      modelToolResultMessage('a1', 'lineage_tool', 'r1'),
      modelToolResultMessage('zz9', 'lineage_tool', 'orphan'),
      modelAssistantMessage('answer'),
      modelUserMessage('follow-up'),
    ];

    expect(() => { assertToolPairingWellFormed(messages); })
      .toThrow(/tool_call_id="zz9" at messages\[3\] has no matching tool call on messages\[1\]/);
  });

  it('keeps message content out of the diagnostic snapshot', () => {
    const messages = [
      modelUserMessage('SECRET question text'),
      modelToolCallMessage([call('a1')], 'SECRET prose'),
      modelToolResultMessage('a1', 'lineage_tool', 'SECRET result'),
    ];

    const snapshot = snapshotMessages(messages);
    expect(snapshot).toBe('[0]human [1]ai{c:a1} [2]tool{r:a1}');
    expect(snapshot).not.toContain('SECRET');
  });
});
