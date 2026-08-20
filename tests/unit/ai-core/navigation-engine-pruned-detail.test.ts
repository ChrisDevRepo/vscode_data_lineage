import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from '../sm/helpers/fixtures';

/**
 * Regression test for A31 — pins the `submit_findings` prune-branch call site in `smBase.ts`
 * against the `AiMemoryManager` retention contract covered by `memory-manager-pruned-detail.test.ts`.
 * A self-pruned focus node's captured `sections`/`summary` must reach `getPrunedDetails()`, and must
 * never appear in `getDetailSlots()` (the synthesis-visible archive) — additive-only, observe-only.
 */

describe('NavigationEngine — self-prune retains captured content (A31)', () => {
  const nodes: LineageNode[] = [
    makeNode({ id: 'origin', schema: 'dbo', name: 'origin', type: 'procedure' }),
    makeNode({ id: 'child_a', schema: 'dbo', name: 'child_a', type: 'view' }),
  ];
  const edges: Array<[string, string]> = [['origin', 'child_a']];
  const model: DatabaseModel = makeModel(nodes, edges, ['dbo']);
  const graph = makeGraph(nodes, edges);

  it('stores the pruned focus node\'s content without exposing it via getDetailSlots', () => {
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
    });

    expect('error' in pruned).toBe(false);
    expect(engine.getPrunedDetails()).toEqual([
      expect.objectContaining({
        nodeId: 'child_a',
        summary: 'not relevant',
        sections: [{ angle: 'business', text: 'not relevant after inspection' }],
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
