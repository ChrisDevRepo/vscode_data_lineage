/**
 * The prune verdict stays exactly as available as it was — this file is the guard against the
 * "stop the wrong prune" work quietly narrowing prune in general.
 *
 * What changed: `prune_sections_conflict` is gone. It tried to detect a wrong verdict by
 * regex-scanning the submission's own prose for a `$$ … $$` block or a predicate-shaped fence,
 * which caught some wrong prunes and, worse, silently ACCEPTED the rest — a prose-only rationale
 * or a whole `SELECT` quoted in a fence both walked through and deleted the node with no rejection
 * (reproduced in `ct-columnless-focus-silent-prune.test.ts`). A verdict rule that depends on how
 * the author happened to format a paragraph is not a rule. It is replaced by
 * `prune_declared_kept_focus`, which keys off what the engine itself told that hop, not off prose.
 *
 * What did NOT change, and is pinned below: a bare self-prune (no sections) commits, and a CT
 * focus that DOES carry a traced column may still prune itself bare, which is what keeps
 * `prune_declared_kept_focus` narrow: it is about a focus the engine declared kept, not about CT.
 * What DID change: a prune carrying sections is refused (`prune_with_sections`) — those sections
 * archived to `prunedDetails`, which synthesis never reads, so the content was silently lost.
 * A prune owes no account; findings belong on `analyze`. The two topology refusals
 * (`prune_origin_forbidden`, `prune_would_orphan_noted`) are untouched.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

describe("submitFindings — the prune verdict is unchanged outside the declared-kept focus", () => {
  // A 3-node chain: origin -> mid -> leaf. `leaf` reaches the origin only through `mid`, so each
  // self-prune of `mid` below removes the branch as a unit (`prune_neighbors: ['leaf']`) and trips
  // neither topology refusal — isolating the content-vs-verdict question these cases are about.
  // Pruning `mid` alone is refused: it would orphan `leaf`, a supplier the render would keep, and
  // (c2) pins that refusal.
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
  const edges: Array<[string, string]> = [['leaf', 'mid'], ['mid', 'origin']];
  const model: DatabaseModel = makeModel(nodes, edges, ['dbo']);
  const graph = makeGraph(nodes, edges);

  // A `$$ … $$` formula block inside a `prune`-verdict section.
  const CAPTURED_FORMULA_TEXT =
    'SegmentName is derived on the way out. $$ SegmentName = CASE(Tier = \'Premium\' -> \'High\'; else \'Low\') $$';

  function bbEngineAtMid(): NavigationEngine {
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({ origin: 'origin', question: 'test', direction: 'upstream' });
    engine.getHopContext();
    // origin auto-analyzes/passes through to reach the `mid` hop.
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


  it("(b1) BB: a prune submission with no sections at all is still accepted, unchanged", () => {
    const engine = bbEngineAtMid();
    const accepted = engine.submitFindings({
      focus_node_id: 'mid',
      sections: [],
      summary: 'off the answer path',
      verdict: 'prune',
      prune_neighbors: ['leaf'],
    });
    expect('ok' in accepted && accepted.ok === true, `expected ok:true, got ${JSON.stringify(accepted)}`).toBe(true);
    const state = engine.toJSON();
    expect(state.removedSet.includes('mid'), 'mid is recorded as removed').toBe(true);
  });

  it("(b2) BB: a prune submission carrying any section — even a plain rationale — is refused", () => {
    // A prune owes no account of the focus: its sections archive where synthesis never reads
    // them, so the boundary refuses the shape instead of silently losing the content. The
    // rationale belongs on an analyze verdict, or the prune goes bare.
    const engine = bbEngineAtMid();
    const rejected = engine.submitFindings({
      focus_node_id: 'mid',
      sections: [{ angle: 'business' as const, text: 'Off the trace — display-only, no revenue link.' }],
      summary: 'off the answer path',
      verdict: 'prune',
      prune_neighbors: ['leaf'],
    }) as { error?: string; hint?: string };
    expect(rejected.error, `expected prune_with_sections, got ${JSON.stringify(rejected)}`).toBe('prune_with_sections');
    expect(rejected.hint ?? '', 'the refusal offers both recoveries').toContain("verdict='analyze'");
    expect(engine.toJSON().removedSet.includes('mid'), 'the refused prune removes nothing').toBe(false);
  });

  it("(c1) BB: pruning the origin still rejects with prune_origin_forbidden, unaffected by the new check", () => {
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({ origin: 'origin', question: 'test', direction: 'upstream' });
    engine.getHopContext();
    const originForbidden = engine.submitFindings({
      focus_node_id: 'origin',
      sections: [],
      summary: 'x',
      verdict: 'prune',
    });
    expect('error' in originForbidden && originForbidden.error === 'prune_origin_forbidden', `expected prune_origin_forbidden, got ${JSON.stringify(originForbidden)}`).toBe(true);
  });

  it("(c2) BB: pruning a node that would orphan committed work still rejects with prune_would_orphan_noted", () => {
    // Route origin directly to `leaf` (transitively reachable only through `mid`), so `leaf` is
    // committed/queued before `mid` is ever dispositioned. When the walk reaches `mid`, pruning it
    // would sever the only path to the already-required `leaf` — the orphan guard, not the new
    // sections-vs-verdict check, must fire (submission carries no sections here).
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({ origin: 'origin', question: 'test', direction: 'upstream', depthIntent: { kind: 'explicit', levels: 3 } });
    engine.getHopContext();
    engine.submitFindings({
      focus_node_id: 'origin',
      sections: [{ angle: 'business' as const, text: 'origin body' }],
      summary: 'origin body',
      verdict: 'passthrough',
      route_requests: [{ nodeId: 'leaf', question: 'trace amount to the leaf' }],
    });
    let rejected: unknown = null;
    for (let hop = 0; hop < 6; hop++) {
      const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
      if (ctx.done || !ctx.focus_node) break;
      const id = ctx.focus_node.id;
      if (id === 'mid') {
        rejected = engine.submitFindings({
          focus_node_id: id,
          sections: [],
          summary: 'off the trace',
          verdict: 'prune',
        });
        break;
      }
      engine.submitFindings({
        focus_node_id: id,
        sections: [{ angle: 'business' as const, text: 'ok' }],
        summary: 'ok',
        verdict: 'passthrough',
      });
    }
    const result = rejected as { error?: string; hint?: string } | null;
    expect(result?.error === 'prune_would_orphan_noted', `pruning mid rejects on topology (got ${JSON.stringify(rejected)})`).toBe(true);
  });


  it("(d2) CT: a prune submission with no sections is still accepted, unchanged", () => {
    const engine = ctEngineAtMid();
    const accepted = engine.submitFindings({
      focus_node_id: 'mid',
      sections: [],
      summary: 'off the answer path',
      verdict: 'prune',
      column_flow: [],
      prune_neighbors: ['leaf'],
    });
    expect('ok' in accepted && accepted.ok === true, `CT expected ok:true, got ${JSON.stringify(accepted)}`).toBe(true);
  });

  it("(a) BB: a prune whose sections carry a captured formula is refused — findings belong on analyze", () => {
    // The captured formula is exactly the content synthesis never sees on a prune verdict
    // (it archives to prunedDetails, outside the synthesis-visible archive). Refusing the shape
    // keeps it in the answer: resubmitted as analyze, the formula commits to a detail slot.
    const engine = bbEngineAtMid();
    const rejected = engine.submitFindings({
      focus_node_id: 'mid',
      sections: [{ angle: 'business' as const, text: CAPTURED_FORMULA_TEXT }],
      summary: 'display dead end',
      verdict: 'prune',
      prune_neighbors: ['leaf'],
    }) as { error?: string };
    expect(rejected.error, `expected prune_with_sections, got ${JSON.stringify(rejected)}`).toBe('prune_with_sections');
    const asAnalyze = bbEngineAtMid().submitFindings({
      focus_node_id: 'mid',
      sections: [{ angle: 'business' as const, text: CAPTURED_FORMULA_TEXT }],
      summary: 'display dead end',
      verdict: 'analyze',
      prune_neighbors: ['leaf'],
    });
    expect('ok' in asAnalyze, `the analyze recovery commits the formula (got ${JSON.stringify(asAnalyze)})`).toBe(true);
  });

  it("(d1) CT: a focus that DOES carry a traced column may still prune itself — but only bare", () => {
    // `mid` declares [amount] and the origin's column_flow routed it here; the prune verdict
    // itself stays available (a traced-column carrier can still be judged off-path), but the
    // sections it carried now refuse like in BB — the rule is verdict-level, not mode-level.
    const engine = ctEngineAtMid();
    const rejected = engine.submitFindings({
      focus_node_id: 'mid',
      sections: [{ angle: 'business' as const, text: 'Off the trace — display-only.' }],
      summary: 'off the answer path',
      verdict: 'prune',
      column_flow: [],
      prune_neighbors: ['leaf'],
    }) as { error?: string };
    expect(rejected.error, `CT expected prune_with_sections, got ${JSON.stringify(rejected)}`).toBe('prune_with_sections');
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
