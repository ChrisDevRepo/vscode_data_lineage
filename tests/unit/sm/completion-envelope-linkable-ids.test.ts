/**
 * The render bound is the single source of node identity at synthesis.
 *
 * Measured shape (T8S @ 37875e19): the envelope reduced the linkable set to `scope: {nodes: 7}` and
 * named none of it, while `node_states[]` and the CT terminal-source candidate line both advertised
 * ids the render had dropped or the depth border had cut — and the synthesis prompt makes linking a
 * named terminal source mandatory. Every surface that names a node must therefore name only nodes
 * `present_result` will accept.
 */
import { buildSmCompletionEnvelope } from '../../../src/ai/prompting/smPrompts';
import type { SmResult } from '../../../src/ai/sm/smTypes';
import { describe, expect, it } from 'vitest';

const ORIGIN = '[ai].[vwdiscountcalc]';
const STAGING = '[ai].[salesstaging]';
const BASE = '[ai].[customermaster]';
/** Dropped from the render by the undispositioned-sink rule; still carries a `node_states` entry. */
const DROPPED = '[ai].[spbuildsalesreport]';
/** Cut by the depth border; reached only as a column-edge endpoint, so a terminal-source candidate. */
const BORDER_CUT = '[ai].[vwraworders]';

/** The T8S completion result: three rendered nodes, two named-but-unlinkable ones. */
function makeResult(): SmResult {
  return {
    status: 'complete',
    originNodeId: ORIGIN,
    fullNodes: [
      { id: ORIGIN, s: 'ai', n: 'vwdiscountcalc', t: 'view' },
      { id: STAGING, s: 'ai', n: 'salesstaging', t: 'table' },
      { id: BASE, s: 'ai', n: 'customermaster', t: 'table' },
    ],
    edges: [
      [STAGING, ORIGIN, 'SELECT'],
      [BASE, ORIGIN, 'SELECT'],
    ],
    detail_slots: [
      { nodeId: ORIGIN, schema: 'ai', name: 'vwdiscountcalc', type: 'view', sections: [], summary: 's' },
    ],
    node_states: [
      { nodeId: ORIGIN, action: 'analyze', source: 'ai', reason: 'submitted_analyze' },
      { nodeId: STAGING, action: 'passthrough', source: 'ai', reason: 'submitted_passthrough' },
      { nodeId: DROPPED, action: 'passthrough', source: 'ai', reason: 'submitted_passthrough' },
      { nodeId: BORDER_CUT, action: 'passthrough', source: 'ai', reason: 'submitted_passthrough' },
    ],
    columnAspect: {
      target_columns: ['Discount'],
      active_columns: ['Discount'],
      edges: [
        { hop_node: ORIGIN, hop: 1, from_node: STAGING, from_col: 'OrderAmount', to_node: ORIGIN, to_col: 'Discount' },
        { hop_node: STAGING, hop: 4, from_node: BORDER_CUT, from_col: 'OrderAmount', to_node: STAGING, to_col: 'OrderAmount' },
      ],
    },
  };
}

describe('Completion envelope — only presented ids are linkable', () => {
  it('scope.node_ids is the presented set, stated and not just counted', () => {
    const envelope = buildSmCompletionEnvelope(makeResult(), 'where does Discount come from?', []);
    expect(envelope.result.scope.node_ids, 'the envelope names the ids present_result accepts')
      .toEqual([ORIGIN, STAGING, BASE]);
    expect(envelope.result.scope.nodes, 'the count still matches the named set')
      .toBe(envelope.result.scope.node_ids.length);
  });

  it('node_states carries no id the render dropped or the border cut', () => {
    const envelope = buildSmCompletionEnvelope(makeResult(), 'where does Discount come from?', []);
    const named = envelope.result.node_states.map(state => state.nodeId);
    expect(named.filter(id => id === DROPPED || id === BORDER_CUT),
      'a lifecycle fact about an unlinkable node is not evidence the model can present').toEqual([]);
    expect(named, 'every rendered node keeps its lifecycle fact').toEqual([ORIGIN, STAGING]);
  });

  it('the terminal-source candidates name no id outside the render', () => {
    const envelope = buildSmCompletionEnvelope(makeResult(), 'where does Discount come from?', []);
    const candidates = envelope.synthesis_reminder
      .split('\n').find(line => line.includes('highlight_groups.source candidates'))!;
    expect(candidates, 'the CT chain block still renders its candidate line').toBeDefined();
    expect(candidates.includes(BORDER_CUT),
      'a border-cut source is prose, never a mandatory link').toBe(false);
  });

  it('the reminder states that only the presented ids may be linked', () => {
    const envelope = buildSmCompletionEnvelope(makeResult(), 'where does Discount come from?', []);
    expect(envelope.synthesis_reminder.includes('result.scope.node_ids'),
      'the one line naming the linkable set').toBe(true);
  });

  it('the column chain itself is never trimmed — the trace is the evidence', () => {
    const envelope = buildSmCompletionEnvelope(makeResult(), 'where does Discount come from?', []);
    expect(envelope.synthesis_reminder.includes(`${BORDER_CUT}.OrderAmount`),
      'the recorded edge stays readable so the answer can state it in prose').toBe(true);
  });
});
