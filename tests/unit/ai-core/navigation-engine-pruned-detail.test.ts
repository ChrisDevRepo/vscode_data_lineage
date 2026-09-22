import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from '../sm/helpers/fixtures';

/**
 * A prune verdict carries no sections: the submit boundary refuses them (`prune_with_sections`)
 * instead of archiving content synthesis never reads. A bare prune's summary still reaches
 * `getPrunedDetails()`, never `getDetailSlots()` (synthesis-visible).
 */

describe('NavigationEngine — prune carries no sections; bare-prune summary retention (A31)', () => {
  const nodes: LineageNode[] = [
    makeNode({ id: 'origin', schema: 'dbo', name: 'origin', type: 'procedure' }),
    makeNode({ id: 'child_a', schema: 'dbo', name: 'child_a', type: 'view' }),
  ];
  const edges: Array<[string, string]> = [['origin', 'child_a']];
  const model: DatabaseModel = makeModel(nodes, edges, ['dbo']);
  const graph = makeGraph(nodes, edges);

  it('refuses a prune carrying sections instead of archiving content synthesis never reads', () => {
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({ origin: 'origin', question: 'test', direction: 'downstream' });

    engine.getHopContext();
    engine.submitFindings({
      focus_node_id: 'origin',
      sections: [{ angle: 'business', text: 'root' }],
      summary: 'root',
      verdict: 'analyze',
    });

    engine.getHopContext();
    const pruned = engine.submitFindings({
      focus_node_id: 'child_a',
      sections: [{ angle: 'business', text: 'not relevant after inspection' }],
      summary: 'not relevant',
      verdict: 'prune',
    }) as { error?: string };

    expect(pruned.error, `prune with sections refuses (got ${JSON.stringify(pruned)})`).toBe('prune_with_sections');
    expect(engine.getPrunedDetails()).toEqual([]);
    expect(engine.toJSON().removedSet.includes('child_a'), 'the refused prune removes nothing').toBe(false);
  });

  it('retains a bare prune\'s summary without exposing it via getDetailSlots', () => {
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({ origin: 'origin', question: 'test', direction: 'downstream' });

    engine.getHopContext();
    engine.submitFindings({
      focus_node_id: 'origin',
      sections: [{ angle: 'business', text: 'root' }],
      summary: 'root',
      verdict: 'analyze',
    });

    engine.getHopContext();
    const pruned = engine.submitFindings({
      focus_node_id: 'child_a',
      sections: [],
      summary: 'not relevant',
      verdict: 'prune',
    });

    expect('error' in pruned).toBe(false);
    expect(engine.getPrunedDetails()).toEqual([
      expect.objectContaining({
        nodeId: 'child_a',
        summary: 'not relevant',
        sections: [],
      }),
    ]);
    expect(engine.getDetailSlots().some(s => s.nodeId === 'child_a')).toBe(false);
  });

  it('retains nothing when the pruned focus submitted no sections and a blank summary', () => {
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({ origin: 'origin', question: 'test', direction: 'downstream' });

    engine.getHopContext();
    engine.submitFindings({
      focus_node_id: 'origin',
      sections: [{ angle: 'business', text: 'root' }],
      summary: 'root',
      verdict: 'analyze',
    });

    engine.getHopContext();
    engine.submitFindings({
      focus_node_id: 'child_a',
      sections: [],
      summary: '',
      verdict: 'prune',
    });

    expect(engine.getPrunedDetails()).toEqual([]);
  });
});
