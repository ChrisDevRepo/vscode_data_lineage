import { describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { assertToolPairingWellFormed } from '../../../src/ai/model/messageWellFormed';

const call = (id: string) => ({ id, name: 'lineage_search_objects', args: { query: 'x' }, type: 'tool_call' as const });
const ask = (...ids: string[]) => new AIMessage({ content: '', tool_calls: ids.map(call) });
const answer = (id: string) => new ToolMessage({ tool_call_id: id, name: 'lineage_search_objects', content: '{}' });
const user = (text = 'question') => new HumanMessage(text);

describe('assertToolPairingWellFormed', () => {
  it.each<[string, BaseMessage[]]>([
    ['text only', [user(), new AIMessage('answer'), user('follow-up')]],
    ['a complete batch', [user(), ask('call-a', 'call-b'), answer('call-a'), answer('call-b')]],
    ['results in a different order', [user(), ask('call-a', 'call-b'), answer('call-b'), answer('call-a')]],
    ['two complete attempts', [user(), ask('call-a'), answer('call-a'), ask('call-b'), answer('call-b'), user('correction')]],
  ])('accepts %s', (_label, messages) => {
    expect(() => assertToolPairingWellFormed(messages)).not.toThrow();
  });

  it.each<[string, BaseMessage[], RegExp]>([
    ['a result with no preceding assistant', [user(), answer('call-a')], /no preceding assistant/],
    ['a result for a call the assistant did not make', [user(), ask('call-a'), answer('call-a'), answer('call-z')], /no matching tool call/],
  ])('rejects %s before sending', (_label, messages, reason) => {
    expect(() => assertToolPairingWellFormed(messages)).toThrow(reason);
  });

  it('names roles and tail-truncated ids only, never message content', () => {
    const secret = 'SELECT payroll FROM dbo.Salaries';
    const orphaned = [user(secret), ask('call-0123456789abcdef'), answer('call-fedcba9876543210')];
    expect(() => assertToolPairingWellFormed(orphaned))
      .toThrow(/snapshot=\[0\]human \[1\]ai\{c:89abcdef\} \[2\]tool\{r:76543210\}$/);
    expect(() => assertToolPairingWellFormed(orphaned)).not.toThrow(secret);
  });
});
