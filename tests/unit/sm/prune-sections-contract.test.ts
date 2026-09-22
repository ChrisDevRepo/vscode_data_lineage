/**
 * The prune verdict carries no sections — a prune owes no account of the focus; findings
 * belong on `analyze`.
 *
 * Root cause pinned here: a `verdict:'prune'` submission carrying rich sections archived them
 * to `prunedDetails`, which synthesis never reads, so the content (outlier notes, SUM logic)
 * was silently lost from the answer. The fix refuses the shape at the submit boundary instead
 * of archiving it: a prune with non-empty `sections` rejects with `prune_with_sections` and a
 * hint naming both recoveries (analyze it, or bare-prune). Nothing is held — the refused
 * content IS the sections, so a held draft would merge them back into a bare-prune retry.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

const nodes: LineageNode[] = [
  makeNode({ id: 'origin', schema: 'dbo', name: 'origin', type: 'procedure' }),
  makeNode({
    id: 'mid', schema: 'dbo', name: 'mid', type: 'view',
    columns: [{ name: 'amount', type: 'int', nullable: 'NOT NULL', extra: '' }],
  }),
  makeNode({
    id: 'leaf', schema: 'dbo', name: 'leaf', type: 'view',
    columns: [{ name: 'amount', type: 'int', nullable: 'NOT NULL', extra: '' }],
  }),
];
// Upstream chain leaf -> mid -> origin: pruning `mid` with `prune_neighbors: ['leaf']`
// removes the branch as a unit and trips neither topology refusal, isolating the
// sections-vs-verdict question.
const edges: Array<[string, string]> = [['leaf', 'mid'], ['mid', 'origin']];
const model: DatabaseModel = makeModel(nodes, edges, ['dbo']);
const graph = makeGraph(nodes, edges);

function bbEngineAtMid(): NavigationEngine {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'test', direction: 'upstream' });
  engine.getHopContext();
  engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'origin body' }],
    summary: 'origin body',
    verdict: 'passthrough',
  });
  engine.getHopContext();
  return engine;
}

function ctEngineAtMid(): NavigationEngine {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'test', direction: 'upstream', targetColumns: ['amount'] });
  engine.getHopContext();
  engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'origin body' }],
    summary: 'origin body',
    verdict: 'passthrough',
    column_flow: [{ out_col: 'amount', upstream_columns: [{ node: 'mid', col: 'amount' }] }],
  });
  engine.getHopContext();
  return engine;
}

describe('submitFindings — a prune verdict carries no sections', () => {
  it('BB: prune with sections is refused with prune_with_sections and commits nothing', () => {
    const engine = bbEngineAtMid();
    const rejected = engine.submitFindings({
      focus_node_id: 'mid',
      sections: [{ angle: 'business' as const, text: 'outlier: weekend spike; SUM(amount) over sales' }],
      summary: 'off the answer path',
      verdict: 'prune',
      prune_neighbors: ['leaf'],
    }) as { error?: string; hint?: string };
    expect(rejected.error, `prune with sections refuses (got ${JSON.stringify(rejected)})`).toBe('prune_with_sections');
    expect(rejected.hint ?? '', 'the refusal offers the analyze recovery').toContain("verdict='analyze'");
    expect(rejected.hint ?? '', 'the refusal offers the bare-prune recovery').toContain('sections: []');
    expect(rejected.hint ?? '', 'the refusal names the focus and its section count').toContain('[mid]');
    expect(engine.toJSON().removedSet.includes('mid'), 'the refused prune removes nothing').toBe(false);
    expect(engine.heldFindingFocus, 'nothing is held: the refused content is the sections themselves').toBeNull();
  });

  it('BB: the refusal recovers both ways — analyze keeps the sections, bare prune drops them', () => {
    const sections = [{ angle: 'business' as const, text: 'mid carries amount through unchanged' }];
    const asAnalyze = bbEngineAtMid().submitFindings({
      focus_node_id: 'mid',
      sections,
      summary: 'mid carries amount',
      verdict: 'analyze',
      prune_neighbors: ['leaf'],
    });
    expect('ok' in asAnalyze, `analyze with sections commits (got ${JSON.stringify(asAnalyze)})`).toBe(true);

    const bare = bbEngineAtMid().submitFindings({
      focus_node_id: 'mid',
      sections: [],
      summary: 'off the answer path',
      verdict: 'prune',
      prune_neighbors: ['leaf'],
    });
    expect('ok' in bare, `bare prune commits (got ${JSON.stringify(bare)})`).toBe(true);
  });

  it('BB: analyze with sections still commits its detail slot', () => {
    const engine = bbEngineAtMid();
    const accepted = engine.submitFindings({
      focus_node_id: 'mid',
      sections: [{ angle: 'business' as const, text: 'mid carries amount through unchanged' }],
      summary: 'mid carries amount',
      verdict: 'analyze',
      prune_neighbors: ['leaf'],
    });
    expect('ok' in accepted, `expected ok:true, got ${JSON.stringify(accepted)}`).toBe(true);
    const slots = engine.getDetailSlots().filter(s => s.nodeId === 'mid');
    expect(slots.length, 'the analyze finding reaches the synthesis-visible archive').toBe(1);
  });

  it('CT: prune with sections is refused the same way — the rule is verdict-level, not mode-level', () => {
    const engine = ctEngineAtMid();
    const rejected = engine.submitFindings({
      focus_node_id: 'mid',
      sections: [{ angle: 'business' as const, text: 'off the trace' }],
      summary: 'off the answer path',
      verdict: 'prune',
      column_flow: [],
      prune_neighbors: ['leaf'],
    }) as { error?: string };
    expect(rejected.error, `CT prune with sections refuses (got ${JSON.stringify(rejected)})`).toBe('prune_with_sections');

    const bare = ctEngineAtMid().submitFindings({
      focus_node_id: 'mid',
      sections: [],
      summary: 'off the answer path',
      verdict: 'prune',
      column_flow: [],
      prune_neighbors: ['leaf'],
    });
    expect('ok' in bare, `CT bare prune commits (got ${JSON.stringify(bare)})`).toBe(true);
  });
});
