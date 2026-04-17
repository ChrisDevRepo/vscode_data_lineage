/**
 * Working-set selection behavior pinned on three graph topologies:
 *  - Daisy chain (linear) — verifies path prefix inclusion + 2-hop fill.
 *  - Hub (one focus, many fat 1-hop slots) — verifies budget gate + path un-evictable.
 *  - Branch-jump (focus moves to a different subtree) — verifies abandoned-branch eviction.
 *
 * Plus two degenerate cases (empty memory; origin === focus).
 */

import { suite, test } from 'node:test';
import * as assert from 'assert';
import Graph from 'graphology';
import { selectWorkingSet } from '../../src/ai/workingSet';
import type { DetailSlot } from '../../src/ai/memoryManager';

function slot(id: string, analysisChars = 400): DetailSlot {
  return {
    nodeId: id,
    schema: 'dbo',
    name: id,
    type: 'procedure',
    analysis: 'x'.repeat(analysisChars),
    summary: `slot ${id}`,
  };
}

function directedGraph(edges: Array<[string, string]>): Graph {
  const g = new Graph({ type: 'directed' });
  for (const [s, t] of edges) {
    if (!g.hasNode(s)) g.addNode(s);
    if (!g.hasNode(t)) g.addNode(t);
    g.addEdge(s, t);
  }
  return g;
}

suite('selectWorkingSet', () => {

  test('daisy chain: path prefix included, 2-hop fills the rest', () => {
    // A → B → C → D → E, focus C, all visited
    const graph = directedGraph([['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'E']]);
    const slots = new Map([['A', slot('A')], ['B', slot('B')], ['D', slot('D')], ['E', slot('E')]]);

    const out = selectWorkingSet({ focusId: 'C', originId: 'A', graph }, slots);
    const ids = out.map(s => s.nodeId);

    // Order: path (A, B) → near (D) → far (E). A comes before B (path index), D before E (distance).
    assert.deepStrictEqual(ids, ['A', 'B', 'D', 'E']);
  });

  test('hub: token budget bounds output; path is never evicted', () => {
    // origin P is the only path edge to focus F; F has 50 fat children at 1-hop.
    const edges: Array<[string, string]> = [['P', 'F']];
    for (let i = 0; i < 50; i++) edges.push(['F', `C${i}`]);
    const graph = directedGraph(edges);

    const fatSlotChars = 4000; // ≈1000 tokens each
    const slots = new Map<string, DetailSlot>();
    slots.set('P', slot('P', fatSlotChars));
    for (let i = 0; i < 50; i++) slots.set(`C${i}`, slot(`C${i}`, fatSlotChars));

    const out = selectWorkingSet({ focusId: 'F', originId: 'P', graph }, slots, 4000);

    // Path (P ≈ 1000 tok) is in. Budget leaves ~3000 tokens for near slots → ~3 of 50.
    assert.strictEqual(out[0].nodeId, 'P', 'path slot P must be first');
    assert.ok(out.length <= 5, `budget-bounded (got ${out.length} slots)`);
    assert.ok(out.length >= 2, 'at least path + one near slot');
  });

  test('branch-jump: abandoned-branch slots not present in new focus working set', () => {
    // Origin O branches into two subtrees:
    //   O → A → B (branch 1, fully analyzed)
    //   O → X → Y (branch 2, newly focused)
    const graph = directedGraph([['O', 'A'], ['A', 'B'], ['O', 'X'], ['X', 'Y']]);
    const slots = new Map([
      ['A', slot('A')], ['B', slot('B')],   // branch 1 — abandoned
      ['X', slot('X')],                      // branch 2 path so far
    ]);

    // AI jumps focus from B (branch 1) to Y (branch 2)
    const out = selectWorkingSet({ focusId: 'Y', originId: 'O', graph }, slots);
    const ids = out.map(s => s.nodeId);

    // Path is O→X→Y; path slots exclude focus Y → just X.
    // 1-hop of Y = {X} (already on path, excluded). 2-hop of Y = {O} (no slot).
    // Abandoned branch {A, B} must NOT leak in.
    assert.ok(ids.includes('X'), 'new branch path slot X present');
    assert.ok(!ids.includes('A'), 'abandoned-branch slot A not leaked');
    assert.ok(!ids.includes('B'), 'abandoned-branch slot B not leaked');
  });

  test('empty detail memory returns empty', () => {
    const graph = directedGraph([['A', 'B']]);
    const out = selectWorkingSet({ focusId: 'B', originId: 'A', graph }, new Map());
    assert.deepStrictEqual(out, []);
  });

  test('origin === focus returns only branch-local (no path)', () => {
    const graph = directedGraph([['O', 'N1'], ['N1', 'N2']]);
    const slots = new Map([['N1', slot('N1')], ['N2', slot('N2')]]);
    const out = selectWorkingSet({ focusId: 'O', originId: 'O', graph }, slots);
    const ids = out.map(s => s.nodeId).sort();
    assert.deepStrictEqual(ids, ['N1', 'N2'], 'near (N1) + far (N2), no path');
  });
});
