/** Scope summaries preserve catalog identities; column writes require an actual write dependency. */
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

const OPEN = { levels: 'all' as const, exactness: 'exact' as const };
const CLOSED = { levels: 0, exactness: 'exact' as const };
const sections = [{ angle: 'business' as const, text: 'Declared SQL behavior.' }];

describe('catalog schema identities in scope summaries', () => {
  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'])('preserves %s without modifying inherited objects', schema => {
    const id = `[${schema}].[Report]`;
    const nodes = [makeNode({ id, schema, name: 'Report', type: 'view', bodyScript: 'SELECT 1;' })];
    const engine = new NavigationEngine(makeModel(nodes, [], [schema]), makeGraph(nodes, []), () => {}, {});
    expect(engine.init({ origin: id, question: 'Explain Report', direction: 'upstream', analysisMode: 'bb', depthIntent: { upstream: OPEN, downstream: CLOSED } })).toEqual({ ok: true });
    const targets = [Object.prototype, Object, Object.prototype.toString, Object.prototype.hasOwnProperty, Object.prototype.valueOf];
    const before = targets.map(target => ['scope', 'hops'].map(key => Object.getOwnPropertyDescriptor(target, key)));
    try {
      const summary = engine.getScopeSummary();
      expect(Object.keys(summary.bySchema)).toEqual([schema]);
      expect(summary.bySchema[schema]).toEqual({ hops: 1, scope: 1, byType: { view: { hops: 1, scope: 1, nodeNames: ['Report'], omitted: 0 } } });
      expect(targets.map(target => ['scope', 'hops'].map(key => Object.getOwnPropertyDescriptor(target, key)))).toEqual(before);
    } finally {
      // A failing pre-fix case must not contaminate the other tests in this worker.
      targets.forEach((target, index) => ['scope', 'hops'].forEach((key, keyIndex) => {
        const descriptor = before[index][keyIndex];
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else Reflect.deleteProperty(target, key);
      }));
    }
  });
});

describe('column write destinations', () => {
  it.each([false, true])('requires a write even when a dependency executes the destination (write=%s)', hasWrite => {
    const nodes = [
      makeNode({ id: 'dbo.Source', schema: 'dbo', name: 'Source', type: 'table', columns: [{ name: 'Input', type: 'int', nullable: 'NULL', extra: '' }] }),
      makeNode({ id: 'dbo.Caller', schema: 'dbo', name: 'Caller', type: 'procedure', bodyScript: 'EXEC dbo.Callee;' }),
      makeNode({ id: 'dbo.Callee', schema: 'dbo', name: 'Callee', type: 'procedure', bodyScript: 'SELECT 1;' }),
    ];
    const pairs: Array<[string, string]> = [['dbo.Source', 'dbo.Caller'], ['dbo.Caller', 'dbo.Callee']];
    const model = makeModel(nodes, pairs, ['dbo']);
    model.edges[1].type = 'exec';
    if (hasWrite) model.edges.push({ source: 'dbo.Caller', target: 'dbo.Callee', type: 'body' });
    const engine = new NavigationEngine(model, makeGraph(nodes, pairs), () => {}, {});
    expect(engine.init({ origin: 'dbo.Source', question: 'Trace Input downstream', analysisMode: 'ct', targetColumns: ['Input'], direction: 'downstream', depthIntent: { upstream: CLOSED, downstream: OPEN } })).toEqual({ ok: true });
    expect(engine.getHopContext().focus_node?.id).toBe('dbo.Source');
    expect(engine.submitFindings({ focus_node_id: 'dbo.Source', verdict: 'analyze', summary: 'Source input.', sections, column_flow: [] })).toMatchObject({ ok: true });
    expect(engine.getHopContext().focus_node?.id).toBe('dbo.Caller');
    const committed = () => {
      const snapshot = engine.toJSON();
      return { status: snapshot.status, focus: snapshot.currentFocusNodeId, hop: snapshot.hopCount, scope: snapshot.scopeNodeIds, visited: snapshot.visited, removed: snapshot.removedSet, states: snapshot.nodeStates, agenda: snapshot.agenda, aspect: snapshot.columnAspect, detail: snapshot.memory.detailSlots };
    };
    const before = structuredClone(committed());
    const result = engine.submitFindings({ focus_node_id: 'dbo.Caller', verdict: 'analyze', summary: 'Caller behavior.', sections, column_flow: [{ out_col: 'Result', writes_to: { node: 'dbo.Callee', col: 'Result' }, upstream_columns: [{ node: 'dbo.Source', col: 'Input' }] }] });
    if (hasWrite) {
      expect(result).toMatchObject({ ok: true });
      expect(engine.columnAspect?.edges).toContainEqual(expect.objectContaining({ from_node: 'dbo.Source', from_col: 'Input', to_node: 'dbo.Callee', to_col: 'Result' }));
    } else {
      expect(result).toMatchObject({ code: 'writes_to_names_reader', issuePaths: ['column_flow.0.writes_to.node'] });
      expect(committed()).toEqual(before);
    }
  });
});
