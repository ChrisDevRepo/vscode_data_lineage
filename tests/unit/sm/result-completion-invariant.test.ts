/** A result exists only for a complete exploration: one whose agenda is drained and whose last focus is submitted. */
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

const target = '[d].[target]', middle = '[d].[middle]', source = '[d].[source]';
const sections = [{ angle: 'technical' as const, text: 'Evidence.' }];

function world() {
  const nodes: LineageNode[] = [
    makeNode({ id: target, schema: 'd', name: 'target', type: 'view', bodyScript: `CREATE VIEW ${target} AS SELECT * FROM ${middle}` }),
    makeNode({ id: middle, schema: 'd', name: 'middle', type: 'view', bodyScript: `CREATE VIEW ${middle} AS SELECT * FROM ${source}` }),
    makeNode({ id: source, schema: 'd', name: 'source', type: 'table' }),
  ];
  const edges: Array<[string, string]> = [[source, middle], [middle, target]];
  const engine = new NavigationEngine(makeModel(nodes, edges, ['d']), makeGraph(nodes, edges), () => {}, {});
  expect(engine.init({ origin: target, question: 'Inspect target', direction: 'upstream', analysisMode: 'bb',
    depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } })).toMatchObject({ ok: true });
  return engine;
}

/** Submits every dispatched focus until the engine reports the agenda drained. */
function drain(engine: NavigationEngine): void {
  for (let hop = engine.getHopContext(); !hop.done; hop = engine.getHopContext()) {
    const focus = String(hop.focus_node!.id);
    expect(engine.submitFindings({ focus_node_id: focus, verdict: 'analyze', summary: `Reviewed ${focus}`, sections })).toMatchObject({ ok: true });
  }
}

describe('exploration result completion invariant', () => {
  it('refuses a result while a focus is dispatched and not submitted', () => {
    const engine = world();
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: target } });
    expect(engine.status).not.toBe('complete');
    expect(() => engine.getResult()).toThrow(/only for a complete exploration/);
  });

  it('refuses a result while agenda entries are still queued after an accepted hop', () => {
    const engine = world();
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: target } });
    expect(engine.submitFindings({ focus_node_id: target, verdict: 'analyze', summary: 'Reviewed target', sections })).toMatchObject({ ok: true });
    expect(() => engine.getResult()).toThrow(/only for a complete exploration/);
  });

  it('builds the result once the agenda is drained, with a state for every scope node', () => {
    const engine = world();
    drain(engine);
    expect(engine.status).toBe('complete');
    const result = engine.getResult();
    expect(result.status).toBe('complete');
    expect(result.node_states.map(state => state.nodeId).sort()).toEqual([middle, source, target].sort());
  });
});
