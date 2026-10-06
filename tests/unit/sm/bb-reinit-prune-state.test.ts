/** A re-initialised engine starts its new scope without the prune state of the scope it replaces. */
import { describe, expect, it } from 'vitest';
import { delivered, drain, world, type DepthSide } from './helpers/bbShapes';

const ALL: DepthSide = { levels: 'all', exactness: 'approximate' };
const CLOSED: DepthSide = { levels: 0, exactness: 'exact' };

describe('scope re-initialisation', () => {
  it('delivers an object the replaced scope had pruned, with no prune on record', () => {
    const w = world({ origin: 'view', a: 'view', b: 'view' }, [['origin', 'a'], ['a', 'b']], 'origin', CLOSED, ALL);
    expect(drain(w.engine, { origin: { prune: ['a'] } })).toEqual(['origin']);
    expect(delivered(w.engine)).toMatchObject({ nodes: ['origin'], pruned: ['a', 'b'] });

    expect(w.engine.init({
      origin: 'origin', question: 'Trace the lineage again', direction: 'downstream', analysisMode: 'bb',
      depthIntent: { upstream: CLOSED, downstream: ALL },
    })).toMatchObject({ ok: true, scopeSize: 3 });
    expect(drain(w.engine)).toEqual(['origin', 'a', 'b']);
    expect(delivered(w.engine)).toMatchObject({ nodes: ['a', 'b', 'origin'], edges: ['a>b', 'origin>a'], pruned: [] });
  });

  it('carries no pending prune vote into the new scope', () => {
    // a's vote on j stays pending while b, the other sender, is unvisited
    const w = world({ origin: 'view', a: 'view', b: 'view', j: 'view' }, [['origin', 'a'], ['origin', 'b'], ['a', 'j'], ['b', 'j']], 'origin', CLOSED, ALL);
    expect(w.engine.getHopContext()).toMatchObject({ focus_node: { id: 'origin' } });
    expect(w.engine.submitFindings({ focus_node_id: 'origin', verdict: 'analyze', summary: 'Observed origin', sections: [{ angle: 'technical', text: 'SQL' }] })).toMatchObject({ ok: true });
    expect(w.engine.getHopContext()).toMatchObject({ focus_node: { id: 'a' } });
    expect(w.engine.submitFindings({ focus_node_id: 'a', verdict: 'analyze', summary: 'Observed a', sections: [{ angle: 'technical', text: 'SQL' }], prune_neighbors: [{ id: 'j', reason: 'off the answer' }] })).toMatchObject({ ok: true });
    expect(w.engine.toJSON().engineInternals.pruneBallots).toHaveLength(1);

    expect(w.engine.init({
      origin: 'origin', question: 'Trace the lineage again', direction: 'downstream', analysisMode: 'bb',
      depthIntent: { upstream: CLOSED, downstream: ALL },
    })).toMatchObject({ ok: true });
    expect(w.engine.toJSON().engineInternals.pruneBallots).toEqual([]);
    expect(drain(w.engine)).toEqual(['origin', 'a', 'b', 'j']);
    expect(delivered(w.engine).nodes).toEqual(['a', 'b', 'j', 'origin']);
  });
});
