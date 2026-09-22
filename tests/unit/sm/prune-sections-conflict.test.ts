/**
 * P1: a `verdict='prune'` submission whose own `sections` carry a captured computed-value or
 * filter-condition artifact contradicts its own verdict — the model wrote analyze-grade evidence
 * (a `$$ … $$` formula, or SQL that computes a value or filters rows), then discarded it under a
 * `prune` label. `submitFindings` refuses this the same way it refuses the two existing
 * topology-only prune checks (`prune_origin_forbidden`, `prune_would_orphan_noted`): same call
 * site, same envelope shape (`{ error, hint }`), no new rejection mechanism.
 *
 * The predicate is structural, not a magic number: `sectionTextHasCapturedArtifact`
 * (`src/ai/prompting/smPrompts.ts`) is the SAME `CAPTURED_ARTIFACT` lexical bound
 * `buildCapturedFormulaFacts` already uses at synthesis to enumerate captured formulas/predicates
 * for the answer — one governor for "what counts as captured evidence", asked as a yes/no question
 * at submission time instead of a list at synthesis time. `sections[]` itself is not required to be
 * empty on a prune: a plain rationale sentence (no `$$`, no fence, no qualifying inline span) still
 * commits unchanged, matching every other prune call site in this suite that carries a one-line
 * "off the trace" rationale.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

describe("submitFindings — prune verdict contradicted by its own captured evidence", () => {
  // A 3-node chain: origin -> mid -> leaf. `mid` is neither the origin nor load-bearing for any
  // committed/queued node, so pruning it alone trips neither existing topology refusal — isolating
  // the new content-vs-verdict check.
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

  // Mirrors the real defect (a recorded run): a `$$ … $$` formula block
  // inside a `prune`-verdict section.
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

  it("(a) BB: a prune submission carrying a captured formula is refused with prune_sections_conflict", () => {
    const engine = bbEngineAtMid();
    const rejected = engine.submitFindings({
      focus_node_id: 'mid',
      sections: [{ angle: 'business' as const, text: CAPTURED_FORMULA_TEXT }],
      summary: 'display dead end',
      verdict: 'prune',
    });
    expect('error' in rejected && rejected.error === 'prune_sections_conflict', `expected prune_sections_conflict, got ${JSON.stringify(rejected)}`).toBe(true);
    const hint = 'error' in rejected && typeof rejected.hint === 'string' ? rejected.hint : '';
    expect(hint.includes("verdict='analyze'") && hint.includes("'passthrough'"), 'the hint names both reconciliation repairs').toBe(true);
    expect(hint.includes('sections:[]'), 'the hint names the alternative repair — resubmitting prune without the captured evidence').toBe(true);
    expect(hint.includes('[mid]'), 'the hint names the contradicted focus').toBe(true);
  });

  it("(b1) BB: a prune submission with no sections at all is still accepted, unchanged", () => {
    const engine = bbEngineAtMid();
    const accepted = engine.submitFindings({
      focus_node_id: 'mid',
      sections: [],
      summary: 'off the answer path',
      verdict: 'prune',
    });
    expect('ok' in accepted && accepted.ok === true, `expected ok:true, got ${JSON.stringify(accepted)}`).toBe(true);
    const state = engine.toJSON();
    expect(state.removedSet.includes('mid'), 'mid is recorded as removed').toBe(true);
  });

  it("(b2) BB: a prune submission with a plain rationale section (no captured artifact) is still accepted, unchanged", () => {
    // Matches the established convention across this suite: a one-line "why this is off-path"
    // rationale, with no `$$` formula, fenced block, or qualifying inline span.
    const engine = bbEngineAtMid();
    const accepted = engine.submitFindings({
      focus_node_id: 'mid',
      sections: [{ angle: 'business' as const, text: 'Off the trace — display-only, no revenue link.' }],
      summary: 'off the answer path',
      verdict: 'prune',
    });
    expect('ok' in accepted && accepted.ok === true, `expected ok:true, got ${JSON.stringify(accepted)}`).toBe(true);
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

  it("(d1) CT: the new refusal fires identically under CT — same code, same hint shape", () => {
    const engine = ctEngineAtMid();
    const rejected = engine.submitFindings({
      focus_node_id: 'mid',
      sections: [{ angle: 'business' as const, text: CAPTURED_FORMULA_TEXT }],
      summary: 'display dead end',
      verdict: 'prune',
      column_flow: [],
    });
    expect('error' in rejected && rejected.error === 'prune_sections_conflict', `CT expected prune_sections_conflict, got ${JSON.stringify(rejected)}`).toBe(true);
    const hint = 'error' in rejected && typeof rejected.hint === 'string' ? rejected.hint : '';
    expect(hint.includes("verdict='analyze'") && hint.includes("'passthrough'"), 'CT hint names both reconciliation repairs').toBe(true);
    expect(hint.includes('[mid]'), 'CT hint names the contradicted focus').toBe(true);
  });

  it("(d2) CT: a prune submission with no sections is still accepted, unchanged", () => {
    const engine = ctEngineAtMid();
    const accepted = engine.submitFindings({
      focus_node_id: 'mid',
      sections: [],
      summary: 'off the answer path',
      verdict: 'prune',
      column_flow: [],
    });
    expect('ok' in accepted && accepted.ok === true, `CT expected ok:true, got ${JSON.stringify(accepted)}`).toBe(true);
  });
});
