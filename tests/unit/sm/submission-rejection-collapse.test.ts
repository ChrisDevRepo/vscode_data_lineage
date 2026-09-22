/**
 * One submission, one complete rejection — and a rejection that states the obligation the repair
 * will raise.
 *
 * The `submit_findings` guard chain used to `return` at the first fault it found. A payload
 * carrying three independent faults therefore cost three generations: repair one, resubmit, be told
 * the next, repair that, resubmit, be told the third — and the semantic-failure budget is three, so
 * a single bad hop could consume the whole allowance without the model ever seeing the full
 * picture. The chain now accumulates every fault and composes one envelope from all of them
 * (`buildSubmissionRejection`, `src/ai/sm/smRouteValidation.ts`).
 *
 * The second half of the same problem is verdict-conditional disclosure. A `verdict:'prune'`
 * submission is exempt from accounting for its own neighbours — pruning a node and then demanding
 * routes into it would orphan them — so the engine did not even compute the required set on that
 * path. When the prune was refused, the model repaired the verdict to `analyze`, resubmitted, and
 * was then told about a neighbour obligation that had been knowable one turn earlier. The required
 * set is now computed for every verdict; the commit-time exemption is unchanged, and the rejection
 * states what a non-prune repair would bring into play.
 *
 * Both are engine bookkeeping — routing, topology and node identity. Nothing here reads prose.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

type Outcome = { ok?: unknown; error?: string; hint?: string; detail?: unknown };

function view(id: string): LineageNode {
  return makeNode({ id, schema: 'dbo', name: id, type: 'view' });
}

/**
 * origin <- mid <- branch <- tail, walked to the `mid` hop.
 *
 * `branch` and `tail` are in scope and undispositioned, so a self-prune of `mid` orphans them and
 * `branch` is `mid`'s one required neighbour.
 */
function engineAtMid(): NavigationEngine {
  const nodes: LineageNode[] = [
    makeNode({ id: 'origin', schema: 'dbo', name: 'origin', type: 'procedure' }),
    view('mid'), view('branch'), view('tail'),
  ];
  const edges: Array<[string, string]> = [['mid', 'origin'], ['branch', 'mid'], ['tail', 'branch']];
  const model: DatabaseModel = makeModel(nodes, edges, ['dbo']);
  const engine = new NavigationEngine(model, makeGraph(nodes, edges), () => {}, {});
  engine.init({
    origin: 'origin', question: 'trace', direction: 'upstream',
    depthIntent: { kind: 'explicit', levels: 3 },
  });
  engine.getHopContext();
  engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'origin reads from mid' }],
    summary: 'origin',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'mid', question: 'what supplies mid?' }],
  });
  engine.getHopContext();
  return engine;
}

describe('submitFindings composes one rejection from every fault the payload carries', () => {
  it('reports a verdict-level fault and a per-reference fault in the same envelope, each under its own detail key', () => {
    const engine = engineAtMid();
    // Two independent faults in one payload. (a) `branch` is named in `route_requests` and in
    // `prune_neighbors` at once — a route/prune conflict, a per-reference fault. (b) the focus
    // verdict is `prune`, and removing `mid` would cut `branch` and `tail` off from the origin — a
    // verdict-level fault. Before the collapse the first one returned and hid the second.
    const outcome = engine.submitFindings({
      focus_node_id: 'mid',
      sections: [{ angle: 'business' as const, text: 'mid is a passthrough shell' }],
      summary: 'mid',
      verdict: 'prune',
      route_requests: [{ nodeId: 'branch', question: 'what supplies branch?' }],
      prune_neighbors: ['branch'],
    }) as Outcome;

    expect('error' in outcome, `the payload is rejected: ${JSON.stringify(outcome)}`).toBe(true);
    const hint = outcome.hint ?? '';
    const detail = outcome.detail as { route?: unknown; column_chain?: unknown } | undefined;

    expect(hint, 'the verdict-level orphan fault is named').toContain('orphan');
    expect(hint, 'and names the focus it refuses to remove').toContain('mid');
    expect(
      JSON.stringify(detail?.route ?? ''),
      'the per-reference fault reaches the SAME envelope instead of waiting for the next generation',
    ).toContain('branch');
    expect(
      detail?.route !== undefined,
      'a multi-family report keys each family separately, so neither substitutes for the other',
    ).toBe(true);
    expect(
      hint,
      'a co-report that includes a verdict-level fault invalidates the authored prose, so it orders a whole resubmission once',
    ).toContain('resend submit_findings whole');

    expect(engine.toJSON().removedSet, 'a rejected submission commits nothing').toEqual([]);
  });

  it('tells a refused prune which neighbours a non-prune repair would owe, instead of revealing them a turn later', () => {
    const engine = engineAtMid();
    const outcome = engine.submitFindings({
      focus_node_id: 'mid',
      sections: [{ angle: 'business' as const, text: 'mid adds nothing' }],
      summary: 'mid',
      verdict: 'prune',
    }) as Outcome;

    expect(outcome.error, 'the self-prune is refused because it would orphan the branch behind it').toBe('prune_would_orphan_noted');
    const hint = outcome.hint ?? '';
    expect(hint, 'the refusal states the obligation the suggested repair raises').toContain('branch');
    expect(
      hint,
      'stated as a consequence of repairing the verdict, not as a fault of the submitted one',
    ).toContain("Repairing the verdict to 'analyze' or 'passthrough'");
    expect(
      hint,
      'and says the engine fills an unaccounted neighbour rather than charging another refusal for it',
    ).toContain('fills an unaccounted required neighbor');
  });

  it('leaves the commit-time exemption alone: a structurally valid prune still owes no route into its own neighbours', () => {
    // origin -> mid -> branch -> auditSink, traced downstream. `branch` is `mid`'s required
    // neighbour, and everything behind `mid` is a write sink the render drops anyway, so the
    // self-prune is structurally valid and must commit without demanding a route into `branch`.
    const nodes: LineageNode[] = [
      makeNode({ id: 'origin', schema: 'dbo', name: 'origin', type: 'procedure' }),
      view('mid'), view('branch'),
      makeNode({ id: 'auditSink', schema: 'dbo', name: 'auditSink', type: 'table' }),
    ];
    const edges: Array<[string, string]> = [['origin', 'mid'], ['mid', 'branch'], ['branch', 'auditSink']];
    const model: DatabaseModel = makeModel(nodes, edges, ['dbo']);
    const engine = new NavigationEngine(model, makeGraph(nodes, edges), () => {}, {});
    engine.init({
      origin: 'origin', question: 'trace', direction: 'downstream',
      depthIntent: { kind: 'explicit', levels: 3 },
    });
    engine.getHopContext();
    engine.submitFindings({
      focus_node_id: 'origin',
      sections: [{ angle: 'business' as const, text: 'origin feeds mid' }],
      summary: 'origin',
      verdict: 'analyze',
      route_requests: [{ nodeId: 'mid', question: 'what does mid feed?' }],
    });
    engine.getHopContext();

    expect(engine.requiredNeighborIds('mid'), 'mid does have a required neighbour, so the exemption is not vacuous here').toContain('branch');

    const outcome = engine.submitFindings({
      focus_node_id: 'mid',
      sections: [{ angle: 'business' as const, text: 'mid only writes an audit trail' }],
      summary: 'mid',
      verdict: 'prune',
    }) as Outcome;

    expect('ok' in outcome, `the prune commits — computing the required set for every verdict did not start demanding it: ${JSON.stringify(outcome)}`).toBe(true);
    expect(engine.toJSON().removedSet.includes('mid'), 'mid is removed').toBe(true);
  });
});
