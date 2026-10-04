/** Scheduling work preserves checkpoints without manufacturing undispatched sender votes. */
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { InvalidEngineCheckpointError } from '../../../src/ai/sm/navigationSnapshotSchema';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

type Direction = 'upstream' | 'downstream' | 'bidirectional';

function world(mode: 'bb' | 'ct', originType: 'table' | 'view', pairs: Array<[string, string]>, direction: Direction = 'upstream') {
  const ids = [...new Set(['A', ...pairs.flat()])];
  const nodes = ids.map(id => makeNode({ id, name: id, schema: 'dbo', type: id === 'A' ? originType : 'view',
    columns: [{ name: 'Amount', type: 'int', nullable: 'NULL', extra: '' }] }));
  const model = makeModel(nodes, pairs, ['dbo']);
  const graph = makeGraph(nodes, pairs);
  const engine = new NavigationEngine(model, graph, () => {}, {});
  expect(engine.init({ origin: 'A', question: 'Trace Amount and its sources', direction, analysisMode: mode,
    ...(mode === 'ct' ? { targetColumns: ['Amount'] } : {}),
    depthIntent: { upstream: { levels: direction === 'downstream' ? 0 : 'all', exactness: 'exact' },
      downstream: { levels: direction === 'upstream' ? 0 : 'all', exactness: 'exact' } },
  })).toMatchObject({ ok: true });
  return { engine, model, graph };
}

function keep(engine: NavigationEngine, id: string) {
  expect(engine.submitFindings({ focus_node_id: id, verdict: 'analyze', summary: `Observed ${id}`,
    sections: [{ angle: 'technical', text: `SQL evidence at ${id}` }],
    ...(engine.currentHopAnalysisMode === 'ct' ? { column_flow: [] } : {}),
  })).toMatchObject({ ok: true });
}

describe('initialized sender-vote boundary', () => {
  for (const mode of ['bb', 'ct'] as const) for (const type of ['table', 'view'] as const) {
    it.each(['upstream', 'downstream', 'bidirectional'] as const)(`roundtrips a cyclic ${mode} ${type} origin before dispatch (%s)`, direction => {
      const w = world(mode, type, [['A', 'B'], ['B', 'A']], direction);
      const initialized = w.engine.toJSON();
      expect(initialized.visited).toEqual([]);
      expect(initialized.engineInternals.pruneBallots).toEqual([]);
      const restored = NavigationEngine.fromJSON(initialized, w.model, w.graph, () => {});
      expect(restored.toJSON()).toEqual(initialized);
      expect(restored.getHopContext()).toMatchObject({ focus_node: { id: 'A' } });
      expect(restored.toJSON().visited).toEqual(['A']);
    });
  }

  it('rejects a checkpoint vote from a sender that has not dispatched', () => {
    const w = world('bb', 'view', [['B', 'A']]);
    const snapshot = w.engine.toJSON();
    snapshot.engineInternals.pruneBallots = [{ nodeId: 'B', votes: [{ senderId: 'A', vote: 'keep' }] }];
    expect(() => NavigationEngine.fromJSON(snapshot, w.model, w.graph, () => {})).toThrow(InvalidEngineCheckpointError);
  });

  it.each(['bb', 'ct'] as const)('preserves a dispatched sender vote while a shared receiver waits (%s)', mode => {
    const w = world(mode, 'view', [['B', 'A'], ['C', 'A'], ['D', 'B'], ['D', 'C']]);
    w.engine.getHopContext(); keep(w.engine, 'A');
    expect(w.engine.getHopContext()).toMatchObject({ focus_node: { id: 'B' } });
    expect(w.engine.submitFindings({ focus_node_id: 'B', verdict: 'analyze', summary: 'B independent of D',
      sections: [{ angle: 'technical', text: 'B SQL evidence' }], prune_neighbors: [{ id: 'D', reason: 'Not needed by B' }],
    })).toMatchObject({ ok: true });
    const snapshot = w.engine.toJSON();
    expect(snapshot.engineInternals.pruneBallots).toContainEqual({ nodeId: 'D', votes: [{ senderId: 'B', vote: 'prune' }] });
    const restored = NavigationEngine.fromJSON(snapshot, w.model, w.graph, () => {});
    expect(restored.getHopContext()).toMatchObject({ focus_node: { id: 'C' } });
    keep(restored, 'C');
    expect(restored.getHopContext()).toMatchObject({ focus_node: { id: 'D' } });
    expect(restored.toJSON().removedSet).not.toContain('D');
  });

  it.each(['bb', 'ct'] as const)('does not turn a reactivated last focus into its own supplemental sender (%s)', mode => {
    const w = world(mode, 'view', [['A', 'B'], ['B', 'A']]);
    for (const id of ['A', 'B']) {
      expect(w.engine.getHopContext()).toMatchObject({ focus_node: { id } });
      keep(w.engine, id);
    }
    expect(w.engine.getHopContext()).toMatchObject({ done: true });
    expect(w.engine.supplementAgenda(['B'])).toMatchObject({ ok: true, agendaed: 1 });
    const snapshot = w.engine.toJSON();
    expect(snapshot.visited).not.toContain('B');
    expect(snapshot.engineInternals.pruneBallots).toEqual([]);
    const restored = NavigationEngine.fromJSON(snapshot, w.model, w.graph, () => {});
    expect(restored.getHopContext()).toMatchObject({ focus_node: { id: 'B' } });
  });

  
});
