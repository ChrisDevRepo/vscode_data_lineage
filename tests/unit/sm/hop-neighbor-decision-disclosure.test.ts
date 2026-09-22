/**
 * Every neighbour the hop offers states the decisions already taken about it.
 *
 * The engine holds three facts that decide, before the model acts, whether an action on a neighbour
 * can succeed: an earlier accepted route or `column_flow` entry declared it part of the traced path
 * (so a prune of it is refused for the rest of the run), a hop already visited it, or a prune
 * already removed it. None of the three was on the hop context. The model therefore proposed
 * actions the engine had already decided to refuse and learned the rule only from the refusal — one
 * correction spent per rule, per run, on a fact the engine could simply have printed.
 *
 * `neighbors[]` now carries `prune_protected`, `already_visited` and `already_removed`, and the
 * active-phase protocol states in one line what they mean and that acting against them costs a
 * correction. The flags are engine bookkeeping rendered as-is — routing, topology and node
 * identity — not a judgement about what any node contains.
 *
 * The last case ties the disclosure to the rule it discloses: the prune the flag warns about is in
 * fact refused, so the flag can never drift into advertising a permission the guard does not grant.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { buildPhasePrompt } from '../../../src/ai/prompting/prompts';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

/** The neighbour shape this file asserts on: the published fields plus the three disclosures. */
interface DisclosedNeighbor {
  id: string;
  prune_protected?: boolean;
  already_visited?: boolean;
  already_removed?: boolean;
}

function view(id: string): LineageNode {
  return makeNode({ id, schema: 'dbo', name: id, type: 'view' });
}

/**
 * Walks to a hop whose focus (`hub`) has one neighbour of each disclosed kind.
 *
 * origin <- p <- hub <- x, with `r` and the table `t` each supplying both `p` and `hub`. Hop 1
 * routes `p`; hop 2 visits `p`, routes `hub` and `t`, and prunes `r`. At hop 3 `p` is declared and
 * visited, `t` is declared and never visited (the bipartite rule contracts a routed table, so it
 * gets no agenda entry), `r` is removed, and `x` is an ordinary unreached supplier — the control
 * that proves the flags are not simply always set.
 */
function engineAtHub(): NavigationEngine {
  const nodes: LineageNode[] = [
    makeNode({ id: 'origin', schema: 'dbo', name: 'origin', type: 'procedure' }),
    view('p'), view('hub'), view('r'), view('x'),
    makeNode({ id: 't', schema: 'dbo', name: 't', type: 'table' }),
  ];
  const edges: Array<[string, string]> = [
    ['p', 'origin'], ['hub', 'p'], ['r', 'p'], ['r', 'hub'], ['x', 'hub'], ['t', 'p'], ['t', 'hub'],
  ];
  const model: DatabaseModel = makeModel(nodes, edges, ['dbo']);
  const engine = new NavigationEngine(model, makeGraph(nodes, edges), () => {}, {});
  engine.init({
    origin: 'origin', question: 'trace', direction: 'upstream',
    depthIntent: { kind: 'explicit', levels: 3 },
  });

  engine.getHopContext();
  engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'origin reads from p' }],
    summary: 'origin',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'p', question: 'what supplies p?' }],
  });

  engine.getHopContext();
  engine.submitFindings({
    focus_node_id: 'p',
    sections: [{ angle: 'business' as const, text: 'hub and t are the suppliers; r is off the answer path' }],
    summary: 'p',
    verdict: 'analyze',
    route_requests: [
      { nodeId: 'hub', question: 'what supplies hub?' },
      { nodeId: 't', question: 'what does t hold?' },
    ],
    prune_neighbors: ['r'],
  });

  return engine;
}

describe('hop_context.neighbors[] discloses the decisions already taken', () => {
  it('flags a declared neighbour, a visited neighbour and a removed neighbour, and leaves an untouched one bare', () => {
    const engine = engineAtHub();
    const ctx = engine.getHopContext() as { focus_node?: { id: string }; neighbors?: DisclosedNeighbor[] };
    expect(ctx.focus_node?.id, 'third focus is hub').toBe('hub');

    const byId = new Map((ctx.neighbors ?? []).map((n) => [n.id, n]));
    expect(Array.from(byId.keys()).sort(), 'hub offers every decided neighbour plus the untouched control').toEqual(['p', 'r', 't', 'x']);

    const p = byId.get('p')!;
    expect(p.prune_protected, 'p was routed on hop 1, so the engine has already locked it against a prune').toBe(true);
    expect(p.already_visited, 'p was the hop-2 focus, so a route back to it is not fresh work').toBe(true);
    expect(p.already_removed, 'p is not removed').toBeUndefined();

    const t = byId.get('t')!;
    expect(t.prune_protected, 'a routed table is declared even though the bipartite rule contracts it away').toBe(true);
    expect(t.already_visited, 't never becomes a focus, so the lock is the only decision it carries').toBeUndefined();

    const r = byId.get('r')!;
    expect(r.already_removed, 'r was pruned on hop 2 and the neighbour list says so rather than offering it again').toBe(true);
    expect(r.prune_protected, 'r was never declared by a route or column_flow').toBeUndefined();
    expect(r.already_visited, 'r was never dispatched as a focus').toBeUndefined();

    const x = byId.get('x')!;
    expect(
      x.prune_protected === undefined && x.already_visited === undefined && x.already_removed === undefined,
      'an in-scope supplier no decision has touched carries none of the three flags',
    ).toBe(true);
  });

  it('states the rule the flags encode in the active-phase protocol', () => {
    const prompt = buildPhasePrompt('active');
    for (const flag of ['prune_protected', 'already_visited', 'already_removed']) {
      expect(prompt, `the protocol names ${flag}, so the flag is not an unexplained field on the payload`).toContain(flag);
    }
    expect(prompt, 'the protocol states the consequence of the lock, not just the field names').toContain('refused');
    expect(prompt, 'and states that acting against the lock costs a correction').toContain('correction');
    expect(prompt, 'and that the other two are no-ops rather than charged refusals').toContain('no-op');
  });

  it('refuses the prune the `prune_protected` flag warns about, so the flag and the guard cannot disagree', () => {
    const engine = engineAtHub();
    const ctx = engine.getHopContext() as { neighbors?: DisclosedNeighbor[] };
    expect((ctx.neighbors ?? []).find((n) => n.id === 't')?.prune_protected, 'the disclosure is present on t').toBe(true);

    const outcome = engine.submitFindings({
      focus_node_id: 'hub',
      sections: [{ angle: 'business' as const, text: 'attempting the prune the flag warned about' }],
      summary: 'hub',
      verdict: 'analyze',
      route_requests: [{ nodeId: 'x', question: 'what supplies x?' }],
      prune_neighbors: ['t'],
    }) as { ok?: unknown; error?: string; hint?: string; detail?: unknown };

    expect('error' in outcome, `the flagged prune is refused, exactly as the disclosure promised: ${JSON.stringify(outcome)}`).toBe(true);
    expect(
      JSON.stringify(outcome.detail ?? ''),
      'the refusal restates the lock the flag already disclosed, so the two describe one rule',
    ).toContain('already declared it part of the traced path');
    expect(engine.toJSON().removedSet.includes('t'), 'the refused prune leaves t in the answer').toBe(false);
  });
});
