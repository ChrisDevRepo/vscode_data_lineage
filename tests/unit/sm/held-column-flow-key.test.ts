/**
 * A held column_flow is keyed by out_col alone, as the served contract states: a failed entry owes
 * every entry of its out_col, a resent entry replaces them all, and a rejection after a held merge
 * names the index of the entry the model sent.
 */
import { describe, expect, it } from 'vitest';
import { AiSession } from '../../../src/ai/session/session';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

const origin = '[g].[origin]', left = '[g].[left]', right = '[g].[right]';
const cols = ['A', 'B'].map(name => ({ name, type: 'int', nullable: 'NULL' as const, extra: '' }));
function world() {
  const nodes = [
    makeNode({ id: origin, schema: 'g', name: origin, type: 'view', columns: cols, bodyScript: `SELECT l.A, r.B FROM ${left} l JOIN ${right} r ON l.A = r.A;` }),
    makeNode({ id: left, schema: 'g', name: left, type: 'table', columns: cols }),
    makeNode({ id: right, schema: 'g', name: right, type: 'table', columns: cols }),
  ];
  const pairs: Array<[string, string]> = [[left, origin], [right, origin]];
  const model = makeModel(nodes, pairs, ['g']); const graph = makeGraph(nodes, pairs);
  const session = new AiSession(); session.model = model; session.graph = graph; session.setClassification('technical'); session.beginTurn();
  const engine = new NavigationEngine(model, graph, () => {}, {}); engine.classification = 'technical';
  engine.init({ origin, question: 'q', analysisMode: 'ct', targetColumns: ['A', 'B'], direction: 'upstream',
    depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } });
  engine.getHopContext();
  return engine;
}
const full = { focus_node_id: origin, verdict: 'analyze' as const, summary: 'S', sections: { technical: 'D' } };
const aRet = { out_col: 'A', returns_to: { node: right, col: 'A' }, upstream_columns: [{ node: left, col: 'A' }] };
const aBad = { out_col: 'A', upstream_columns: [{ node: left, col: 'Nope' }] };
const aFixed = { out_col: 'A', upstream_columns: [{ node: left, col: 'A' }] };

describe('held column_flow keyed by out_col', () => {
  it('a failed entry of an out_col drops every entry of that out_col, whatever its returns_to', () => {
    const e = world();
    const held = e.holdRejectedSubmission({ ...full, column_flow: [aRet, aBad] }, ['column_flow.1.upstream_columns.0.col']);
    expect(held?.entries?.column_flow ?? []).toEqual([]);
  });
  it('a resent entry replaces every held entry of its out_col', () => {
    const e = world();
    e.holdRejectedSubmission({ ...full, column_flow: [aRet] }, ['badge_label']);
    e.holdRejectedSubmission({ ...full, column_flow: [aFixed] }, ['badge_label']);
    expect(e.toJSON().engineInternals?.heldFinding?.finding.column_flow).toEqual([aFixed]);
  });
});
describe('rejection paths after a held merge', () => {
  it('name the entry index the model sent', () => {
    const e = world();
    const flowA = { out_col: 'A', upstream_columns: [{ node: left, col: 'A' }] };
    const badB = { out_col: 'B', upstream_columns: [{ node: right, col: 'Nope' }] };
    e.holdRejectedSubmission({ ...full, column_flow: [flowA] }, ['badge_label']);
    const r = e.submitFindings({ focus_node_id: origin, verdict: 'analyze', summary: '', sections: [], column_flow: [badB] });
    expect('issuePaths' in r ? r.issuePaths : undefined).toEqual(['column_flow.0.upstream_columns.0.col']);
  });
});
