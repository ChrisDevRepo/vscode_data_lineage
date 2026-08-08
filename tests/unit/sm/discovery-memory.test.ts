import { assert, assertEq } from '../helpers/testUtils';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { ModelMessage } from '../../../src/ai/model/modelPort';
import {
  AiSession,
  MAX_DISCOVERY_EVIDENCE_BYTES,
  MAX_DISCOVERY_EVIDENCE_ITEM_BYTES,
  MAX_DISCOVERY_EVIDENCE_OBSERVATIONS,
  MAX_DISCOVERY_TRANSCRIPT_BYTES,
  MAX_DISCOVERY_TRANSCRIPT_TURNS,
} from '../../../src/ai/session/session';
import { describe, it } from 'vitest';

/**
 * The engine's own bound (`renderDiscoveryTranscript` in session.ts) measures
 * `JSON.stringify` of lean `{ role, content }` pairs, not the LangChain wire envelope
 * (which adds a fixed per-message `tool_calls`/`additional_kwargs`/`response_metadata`
 * overhead unrelated to the bounded content). Byte-cap assertions below reconstruct that
 * same lean shape so they measure what the bound actually governs.
 */
function plainOf(messages: ModelMessage[]): Array<{ role: string; content: unknown }> {
  return messages.map((m) => ({ role: m.getType() === 'human' ? 'user' : 'assistant', content: m.content }));
}

describe('discovery-memory', () => {
  it('no history before any turn', () => {
    const sess = new AiSession();
    assertEq(sess.getDiscoveryHistory().length, 0, 'no history before any turn');
  });

  it('one turn yields its two messages, stored verbatim, in order', () => {
    const sess = new AiSession();
    const turn: ModelMessage[] = [new HumanMessage('q1'), new AIMessage('a1')];
    sess.appendDiscoveryTurn(turn);
    const h = sess.getDiscoveryHistory();
    assertEq(h.length, 2, 'one turn yields its two messages');
    assertEq(h[0].getType(), 'human', 'window starts with the user turn');
    assertEq(JSON.stringify(h), JSON.stringify(turn), 'messages are stored verbatim');
  });

  it('provider-native transcript roles are excluded', () => {
    const sess = new AiSession();
    const turn = [
      new HumanMessage('sales'),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'c1', name: 'lineage_search_objects', args: { query: 'sales' } }],
      }),
      new ToolMessage({ content: JSON.stringify({}), tool_call_id: 'c1' }),
      new AIMessage('Found sales objects.'),
    ] as ModelMessage[];
    sess.appendDiscoveryTurn(turn);
    const h = sess.getDiscoveryHistory();
    assertEq(h.length, 2, 'only canonical user/final-assistant text is retained');
    assert(!h.some((m) => m.getType() === 'tool'), 'provider-native tool-result messages are excluded');
    // Every AIMessage always serializes a `tool_calls` key (empty when unset) — the meaningful
    // check is that the tool invocation itself (name/args) never leaks into canonical history.
    assert(!JSON.stringify(h).includes('lineage_search_objects'), 'provider-native assistant tool calls are excluded');
  });

  it('accepted object/DDL evidence grounds the next discovery turn', () => {
    const sess = new AiSession();
    const ddl = 'CREATE VIEW [sales].[OrderSummary] AS SELECT OrderId FROM [sales].[Orders]';
    sess.appendDiscoveryTurn(
      [new HumanMessage('What builds OrderSummary?'), new AIMessage('I found the view.')],
      [{ toolName: 'lineage_get_object_detail', result: JSON.stringify({ id: '[sales].[OrderSummary]', ddl }) }],
    );
    const history = sess.getDiscoveryHistory();
    const evidence = String(history.at(-1)?.content ?? '');
    assertEq(history.at(-1)?.getType(), 'human', 'accepted evidence is projected as provider-neutral user context');
    assert(evidence.includes('[sales].[OrderSummary]'), 'follow-up history retains the accepted object id');
    assert(evidence.includes(ddl), 'follow-up history retains accepted DDL grounding');
    assert(evidence.includes('accepted_discovery_evidence'), 'evidence projection is explicitly typed');
  });

  it('invalid discovery payloads add no evidence message', () => {
    const sess = new AiSession();
    sess.appendDiscoveryTurn(
      [new HumanMessage('q'), new AIMessage('a')],
      [
        { toolName: 'lineage_get_object_detail', result: '{malformed' },
        { toolName: 'lineage_get_object_detail', result: '"primitive"' },
        { toolName: 'lineage_get_object_detail', result: JSON.stringify({ error: 'invalid_object', message: 'rejected-payload' }) },
        { toolName: 'lineage_get_object_detail', result: JSON.stringify({ ddl: 'x'.repeat(MAX_DISCOVERY_EVIDENCE_ITEM_BYTES) }) },
      ],
    );
    assertEq(sess.getDiscoveryHistory().length, 2, 'invalid discovery payloads add no evidence message');
  });

  it('evidence count and rendered bytes are strictly bounded newest-first', () => {
    const sess = new AiSession();
    for (let i = 0; i < MAX_DISCOVERY_EVIDENCE_OBSERVATIONS + 5; i++) {
      sess.appendDiscoveryTurn([], [{ toolName: 'lineage_get_object_detail', result: JSON.stringify({ id: `node-${i}`, ddl: 'x'.repeat(3000) }) }]);
    }
    const evidence = String(sess.getDiscoveryHistory().at(-1)?.content ?? '');
    const parsed = JSON.parse(evidence) as { observations: Array<{ result: { id: string } }> };
    assert(parsed.observations.length <= MAX_DISCOVERY_EVIDENCE_OBSERVATIONS, 'evidence observation count stays within the hard cap');
    assert(Buffer.byteLength(evidence, 'utf8') <= MAX_DISCOVERY_EVIDENCE_BYTES, 'rendered evidence stays within the hard byte cap');
    assert(parsed.observations.some(item => item.result.id === `node-${MAX_DISCOVERY_EVIDENCE_OBSERVATIONS + 4}`), 'newest accepted evidence survives eviction');
    assert(!parsed.observations.some(item => item.result.id === 'node-0'), 'oldest evidence is evicted first');
  });

  it('turns accumulate in order, oldest first', () => {
    const sess = new AiSession();
    sess.appendDiscoveryTurn([new HumanMessage('q1'), new AIMessage('a1')]);
    sess.appendDiscoveryTurn([new HumanMessage('q2'), new AIMessage('a2')]);
    const contents = sess.getDiscoveryHistory().map((m) => (typeof m.content === 'string' ? m.content : '·'));
    assertEq(contents.join('|'), 'q1|a1|q2|a2', 'turns accumulate in order, oldest first');
  });

  it('transcript count evicts oldest complete pairs and preserves exact under-bound bytes', () => {
    const sess = new AiSession();
    for (let i = 0; i < MAX_DISCOVERY_TRANSCRIPT_TURNS + 3; i++) {
      sess.appendDiscoveryTurn([new HumanMessage(`q${i}`), new AIMessage(`a${i}`)]);
    }
    const h = sess.getDiscoveryHistory();
    assertEq(h.length, MAX_DISCOVERY_TRANSCRIPT_TURNS * 2, 'turn-count bound retains exactly the configured number of complete pairs');
    assertEq(typeof h[0].content === 'string' ? h[0].content : '', 'q3', 'count eviction removes the oldest complete pairs first');
    assertEq(typeof h[1].content === 'string' ? h[1].content : '', 'a3', 'count eviction never splits the oldest retained pair');
    assertEq(typeof h.at(-1)?.content === 'string' ? h.at(-1)?.content : '', `a${MAX_DISCOVERY_TRANSCRIPT_TURNS + 2}`, 'the newest complete turn survives count eviction');

    const underBound = new AiSession();
    const turn: ModelMessage[] = [
      new HumanMessage('Which object writes café revenue? 💶'),
      new AIMessage('The answer retains UTF-8, "quotes", and \\slashes exactly.'),
    ];
    underBound.appendDiscoveryTurn(turn);
    assert(
      Buffer.from(JSON.stringify(underBound.getDiscoveryHistory()), 'utf8').equals(Buffer.from(JSON.stringify(turn), 'utf8')),
      'an under-bound canonical turn is byte-identical after storage',
    );
  });

  it('transcript bytes evict whole pairs; one oversized newest pair is bounded but retained', () => {
    const sess = new AiSession();
    for (let i = 0; i < 3; i++) {
      sess.appendDiscoveryTurn([
        new HumanMessage(`wide-q${i}`),
        new AIMessage(`wide-a${i}-${'é'.repeat(12_000)}`),
      ]);
    }
    const h = sess.getDiscoveryHistory();
    assert(Buffer.byteLength(JSON.stringify(plainOf(h)), 'utf8') <= MAX_DISCOVERY_TRANSCRIPT_BYTES, 'rendered transcript stays within the UTF-8 byte cap');
    assertEq(h.length, 4, 'byte eviction retains two complete pairs at this boundary');
    assertEq(typeof h[0].content === 'string' ? h[0].content : '', 'wide-q1', 'byte eviction removes the oldest complete pair');
    const lastContent = h.at(-1)?.content;
    assertEq(typeof lastContent === 'string' ? lastContent.startsWith('wide-a2-') : false, true, 'the newest byte-bounded turn survives');

    const oversized = new AiSession();
    oversized.appendDiscoveryTurn([
      new HumanMessage('newest oversized question'),
      new AIMessage('💡'.repeat(MAX_DISCOVERY_TRANSCRIPT_BYTES)),
    ]);
    const newest = oversized.getDiscoveryHistory();
    assertEq(newest.map(message => message.getType()).join(','), 'human,ai', 'oversized newest turn remains a complete pair');
    assert(Buffer.byteLength(JSON.stringify(plainOf(newest)), 'utf8') <= MAX_DISCOVERY_TRANSCRIPT_BYTES, 'oversized newest turn is deterministically text-bounded');
    assert(String(newest[1]?.content).includes('truncated to discovery memory bound'), 'oversized newest answer carries the truncation marker');
  });

  it('empty turn delta records nothing', () => {
    const sess = new AiSession();
    sess.appendDiscoveryTurn([]);
    assertEq(sess.getDiscoveryHistory().length, 0, 'empty turn delta records nothing');
  });

  it('returned array is a copy (caller cannot mutate internal state)', () => {
    const sess = new AiSession();
    sess.appendDiscoveryTurn([new HumanMessage('q1'), new AIMessage('a1')]);
    sess.getDiscoveryHistory().push(new HumanMessage('injected') as ModelMessage);
    assertEq(sess.getDiscoveryHistory().length, 2, 'mutating the returned array does not affect memory');
  });

  it('clearDiscoveryTranscript empties memory', () => {
    const sess = new AiSession();
    sess.appendDiscoveryTurn([new HumanMessage('q1'), new AIMessage('a1')]);
    sess.clearDiscoveryTranscript();
    assertEq(sess.getDiscoveryHistory().length, 0, 'clearDiscoveryTranscript empties memory');
  });
});
