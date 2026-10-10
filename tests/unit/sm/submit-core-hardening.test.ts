/**
 * Held retry of a rejected `submit_findings`: a `column_flow` entry fails on its own, the focus is
 * checked before any held merge, and one submission's engine-side faults arrive in one rejection.
 */
import { describe, expect, it, vi } from 'vitest';
import { AiSession } from '../../../src/ai/session/session';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { executeSubmitFindings } from '../../../src/ai/tools/handlers/submitFindings';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { stubToolServices } from './helpers/toolServices';

const origin = '[g].[origin]', left = '[g].[left]', right = '[g].[right]';
const cols = ['A', 'B'].map(name => ({ name, type: 'int', nullable: 'NULL' as const, extra: '' }));

function world(classification: 'technical' | 'both' = 'technical') {
  const nodes = [
    makeNode({ id: origin, schema: 'g', name: origin, type: 'view', columns: cols, bodyScript: `SELECT l.A, r.B FROM ${left} l JOIN ${right} r ON l.A = r.A;` }),
    makeNode({ id: left, schema: 'g', name: left, type: 'table', columns: cols }),
    makeNode({ id: right, schema: 'g', name: right, type: 'table', columns: cols }),
  ];
  const pairs: Array<[string, string]> = [[left, origin], [right, origin]];
  const model = makeModel(nodes, pairs, ['g']);
  const graph = makeGraph(nodes, pairs);
  const session = new AiSession();
  session.model = model; session.graph = graph; session.setClassification(classification); session.beginTurn();
  const engine = new NavigationEngine(model, graph, () => {}, {}); engine.classification = classification;
  expect(engine.init({ origin, question: 'Trace A and B.', analysisMode: 'ct', targetColumns: ['A', 'B'], direction: 'upstream',
    depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } })).toMatchObject({ ok: true });
  engine.getHopContext(); session.stateMachine = engine; session.memory.setUserQuestion('Trace A and B.'); session.enterExploring(session.turnEpoch);
  const submit = (input: unknown) => JSON.parse(executeSubmitFindings(input, stubToolServices({ session, model, graph }).services));
  return { engine, submit };
}

const flowA = { out_col: 'A', upstream_columns: [{ node: left, col: 'A' }] };
const badB = { out_col: 'B', upstream_columns: [{ node: right, col: 'Nope' }] };
const flowB = { out_col: 'B', upstream_columns: [{ node: right, col: 'B' }] };
const full = { focus_node_id: origin, verdict: 'analyze' as const, summary: 'Joins left and right.', sections: { technical: 'Detail.' } };
const envelope = { focus_node_id: origin, verdict: 'analyze' as const };

/** Column edges committed into the origin, as `from_node.from_col` strings. */
function edgesInto(engine: NavigationEngine): string[] {
  return (engine.columnAspect?.edges ?? []).map(edge => `${edge.from_node}.${edge.from_col}`).sort();
}

describe('column_flow entry-level holding', () => {
  it('holds the valid entries when one entry fails an engine check, so the retry resends only that entry', () => {
    const w = world();
    const rejected = w.submit({ ...full, column_flow: [flowA, badB] });
    expect(rejected).toMatchObject({ code: 'contributor_col_not_on_source', issuePaths: ['column_flow.1.upstream_columns.0.col'] });
    expect(rejected.hint).toContain('Held: column_flow (out_col: A)');
    expect(w.engine.heldColumnFlow).toBe(true);
    const merged = vi.spyOn(w.engine, 'applyHeldContent');
    expect(w.submit({ ...envelope, column_flow: [flowB] })).toMatchObject({ ok: true });
    expect(merged.mock.results[0]!.value).toMatchObject({ column_flow: [flowB, flowA] });
    expect(edgesInto(w.engine)).toEqual([`${left}.A`, `${right}.B`]);
  });

  it('keeps the held entries when the retry omits column_flow, and never restores the failed entry', () => {
    const w = world();
    w.submit({ ...full, column_flow: [flowA, badB] });
    const merged = vi.spyOn(w.engine, 'applyHeldContent');
    expect(w.submit(envelope)).toMatchObject({ ok: true });
    expect(merged.mock.results[0]!.value).toMatchObject({ column_flow: [flowA] });
  });

  it('a resent entry replaces every held entry of its out_col; column_flow: [] clears the held entries', () => {
    const w = world();
    w.submit({ ...full, column_flow: [flowA, badB] });
    const replacedA = { out_col: 'A', upstream_columns: [{ node: right, col: 'A' }] };
    const merged = vi.spyOn(w.engine, 'applyHeldContent');
    expect(w.engine.submitFindings({ ...envelope, summary: '', sections: [], column_flow: [replacedA, flowB] })).toMatchObject({ ok: true });
    expect(merged.mock.results[0]!.value).toMatchObject({ column_flow: [replacedA, flowB] });

    const v = world();
    v.submit({ ...full, column_flow: [flowA, badB] });
    const cleared = vi.spyOn(v.engine, 'applyHeldContent');
    expect(v.submit({ ...envelope, column_flow: [] })).toMatchObject({ ok: true });
    expect(cleared.mock.results[0]!.value).toMatchObject({ column_flow: [] });
  });

  it('holds the schema-valid entries of a schema-rejected column_flow and drops the malformed one', () => {
    const w = world();
    const rejected = w.submit({ ...full, column_flow: [flowA, { out_col: 'B', upstream_columns: 'right.B' }] });
    expect(rejected).toMatchObject({ code: 'invalid_input' });
    expect(rejected.issuePaths).toEqual(['column_flow.1.upstream_columns']);
    expect(rejected.hint).toContain('column_flow (out_col: A)');
    const merged = vi.spyOn(w.engine, 'applyHeldContent');
    expect(w.submit({ ...envelope, column_flow: [flowB] })).toMatchObject({ ok: true });
    expect(merged.mock.results[0]!.value).toMatchObject({ column_flow: [flowB, flowA] });
  });

  it('holds no column_flow when every entry failed, so the retry must send one', () => {
    const w = world();
    expect(w.submit({ ...full, column_flow: [badB] })).toMatchObject({ code: 'contributor_col_not_on_source' });
    expect(w.engine.heldColumnFlow).toBe(false);
    expect(w.submit(envelope)).toMatchObject({ code: 'invalid_input', issuePaths: ['column_flow'] });
    expect(w.submit({ ...envelope, column_flow: [flowB] })).toMatchObject({ ok: true });
  });

  it('drops every held entry of a failed out_col, never holding a sibling the correction would replace', () => {
    const w = world();
    const siblingB = { out_col: 'B', upstream_columns: [{ node: left, col: 'B' }] };
    const rejected = w.submit({ ...full, column_flow: [flowA, siblingB, badB] });
    expect(rejected).toMatchObject({ issuePaths: ['column_flow.2.upstream_columns.0.col'] });
    // B is owed as a whole: the hint names only A as held, so the retry resends both B entries.
    expect(rejected.hint).toContain('Held: column_flow (out_col: A).');
    expect(w.engine.toJSON().engineInternals?.heldFinding).toMatchObject({ finding: { column_flow: [flowA] } });
    const merged = vi.spyOn(w.engine, 'applyHeldContent');
    expect(w.submit({ ...envelope, column_flow: [siblingB, flowB] })).toMatchObject({ ok: true });
    expect(merged.mock.results[0]!.value).toMatchObject({ column_flow: [siblingB, flowB, flowA] });
  });

  it('holds nothing of a column_flow whose whole value or entry identity is malformed', () => {
    const w = world();
    expect(w.engine.holdRejectedSubmission({ ...full, column_flow: 'A <- left.A' }, ['column_flow'])).toEqual({ sections: ['technical'], summary: true, fields: [] });
    expect(w.engine.heldColumnFlow).toBe(false);
    const v = world();
    expect(v.engine.holdRejectedSubmission({ ...full, column_flow: [flowA, { out_col: 7, upstream_columns: [] }, null] }, ['column_flow.1.out_col', 'column_flow.2']))
      .toEqual({ sections: ['technical'], summary: true, fields: ['column_flow'], entries: { column_flow: ['A'] } });
  });

  it('a held entry restored on the retry is validated again, never accepted unchecked', () => {
    const w = world('both');
    // The schema rejects only the technical angle: the column entry has not met the engine yet.
    w.submit({ ...full, sections: { business: 'Business meaning.', technical: 7 }, column_flow: [flowA, badB] });
    const rejected = w.submit({ ...envelope, sections: { technical: 'Detail.' } });
    expect(rejected).toMatchObject({ code: 'contributor_col_not_on_source', issuePaths: ['column_flow.1.upstream_columns.0.col'] });
    expect(w.submit({ ...envelope, column_flow: [flowB] })).toMatchObject({ ok: true });
  });
});

describe('one rejection per submission, focus first', () => {
  it('names a wrong focus on a held retry instead of asking for the full call again', () => {
    const w = world();
    w.submit({ ...full, column_flow: [flowA, badB] });
    expect(w.submit({ focus_node_id: left, verdict: 'analyze' })).toMatchObject({ code: 'focus_node_id_mismatch', issuePaths: ['focus_node_id'] });
    // The held draft survives the mismatch.
    expect(w.submit({ ...envelope, column_flow: [flowB] })).toMatchObject({ ok: true });
  });

  it('reports an overlong badge_label and a column fault in the same rejection, holding the rest', () => {
    const w = world();
    const rejected = w.submit({ ...full, badge_label: 'x'.repeat(200), column_flow: [flowA, badB] });
    expect(rejected.issuePaths).toEqual(expect.arrayContaining(['badge_label', 'column_flow.1.upstream_columns.0.col']));
    expect(rejected.reason).toContain('badge_label: 200 chars, limit');
    expect(rejected.reason).toContain('column_flow.1.upstream_columns.0.col');
    expect(w.submit({ ...envelope, badge_label: 'Join', column_flow: [flowB] })).toMatchObject({ ok: true });
  });

  it('reports a missing locked angle and a column fault of a held retry in the same rejection', () => {
    const w = world('both');
    // Round 1: the schema fails only the technical angle; the business angle and the flow are held unchecked.
    expect(w.submit({ ...full, sections: { business: 'Business meaning.', technical: 7 }, column_flow: [flowA, badB] }))
      .toMatchObject({ code: 'invalid_input', issuePaths: ['sections.technical'] });
    // Round 2 still misses the technical angle; the engine names that and the column fault together.
    const rejected = w.submit({ ...envelope, sections: {} });
    expect(rejected.issuePaths).toEqual(expect.arrayContaining(['sections', 'column_flow.1.upstream_columns.0.col']));
    expect(rejected.reason).toContain('sections.technical');
    expect(rejected.reason).toContain('column_flow.1.upstream_columns.0.col');
    expect(rejected.hint).toContain('column_flow (out_col: A)');
    // Round 3 corrects both and commits: the run never needs a fourth reply.
    expect(w.submit({ ...envelope, sections: { technical: 'Detail.' }, column_flow: [flowB] })).toMatchObject({ ok: true });
    expect(w.engine.getDetailSlots()).toContainEqual(expect.objectContaining({ nodeId: origin, sections: [
      { angle: 'business', text: 'Business meaning.' }, { angle: 'technical', text: 'Detail.' },
    ] }));
  });

  it('leaves no partial state after a combined rejection', () => {
    const w = world();
    // Committed state only: the bounded rejection ring is meant to record each fault.
    const committedState = () => {
      const { engineInternals: _internals, memory, ...state } = w.engine.toJSON();
      return JSON.stringify({ ...state, memory: { ...memory, recentRejections: undefined } });
    };
    const before = committedState();
    const rejected = w.submit({ ...full, badge_label: 'y'.repeat(200), questions: [{ nodeId: origin, question: 'Self?' }], column_flow: [flowA, badB] });
    expect(rejected.issuePaths).toEqual(expect.arrayContaining(['badge_label', 'questions.0.nodeId', 'column_flow.1.upstream_columns.0.col']));
    expect(committedState()).toBe(before);
    expect(w.engine.toJSON().memory.recentRejections).toHaveLength(3);
  });
});
