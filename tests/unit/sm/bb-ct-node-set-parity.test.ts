/**
 * GATE — BB/CT node-set parity (docs/ARCHITECTURE.md: "For the same question, origin, direction
 * and depth the two modes walk the same node set. Neighbor prune is the same topology-safe engine
 * path in both modes; CT adds column-flow verification on top of that path.").
 *
 * Nothing enforces this today: a column-less branch is visible to CT only via the per-neighbor
 * carry the router states on it (`row_role_only` keeps it walkable as a plain object), and nothing
 * compares the two arms' final node sets against each other. This file drives one fixture through
 * two independent {@link NavigationEngine} instances — one `bb`, one `ct` — and asserts their
 * `getResult().fullNodes` id sets are identical.
 *
 * Fixture (docs/ARCHITECTURE.md's worked example): `report` is the origin, traced on `amount`.
 * `carrier` continues that column. `side` is inner-joined into `report` but declares no `amount`
 * at all — it only restricts rows — and `behind` sits above `side`. `side` and `behind` are
 * reachable only through a column-less branch: exactly the nodes a column trace historically lost.
 */
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { driveEngine, makeModel, makeNode } from './helpers/fixtures';

const NODES: LineageNode[] = [
  makeNode({
    id: 'report', schema: 'dbo', name: 'report', type: 'view',
    columns: [{ name: 'amount', type: 'int', nullable: 'NOT NULL', extra: '' }],
  }),
  makeNode({
    id: 'carrier', schema: 'dbo', name: 'carrier', type: 'view',
    columns: [{ name: 'amount', type: 'int', nullable: 'NOT NULL', extra: '' }],
  }),
  makeNode({
    id: 'side', schema: 'dbo', name: 'side', type: 'view',
    columns: [{ name: 'region', type: 'varchar', nullable: 'NOT NULL', extra: '' }],
  }),
  makeNode({
    id: 'behind', schema: 'dbo', name: 'behind', type: 'view',
    columns: [{ name: 'region', type: 'varchar', nullable: 'NOT NULL', extra: '' }],
  }),
];
const EDGES: Array<[string, string]> = [['carrier', 'report'], ['side', 'report'], ['behind', 'side']];
const MODEL: DatabaseModel = makeModel(NODES, EDGES, ['dbo']);

/** Fresh graph per engine — graphology mutates in place and each arm gets its own instance. */
function freshGraph() {
  return makeGraph(NODES, EDGES);
}

/** BB arm: route every branch as a plain object; no column channel exists in this mode. */
function runBb(): NavigationEngine {
  const engine = new NavigationEngine(MODEL, freshGraph(), () => {}, {});
  const init = engine.init({
    origin: 'report',
    question: 'describe report',
    direction: 'upstream',
    analysisMode: 'bb',
    depthIntent: { kind: 'explicit', levels: 3 },
  });
  expect('ok' in init, `BB init must succeed (${'error' in init ? init.error : ''})`).toBe(true);
  driveEngine(engine, { routes: { report: ['carrier', 'side'], side: ['behind'] }, limit: 10 });
  return engine;
}

/**
 * CT arm: `report` continues `amount` onto `carrier` and separately routes `side` with
 * `columns: 'none'` — the row-shaping declaration. `side`'s own hop is then dispatched under the
 * BB contract (column-less), and its route to `behind` carries no `columns` field at all, which a
 * BB-mode hop's carry resolves to the same row role, not the session's traced-target fallback.
 */
function runCt(): NavigationEngine {
  const engine = new NavigationEngine(MODEL, freshGraph(), () => {}, {});
  const init = engine.init({
    origin: 'report',
    question: 'trace amount',
    direction: 'upstream',
    analysisMode: 'ct',
    targetColumns: ['amount'],
    depthIntent: { kind: 'explicit', levels: 3 },
  });
  expect('ok' in init, `CT init must succeed (${'error' in init ? init.error : ''})`).toBe(true);

  for (let hop = 0; hop < 10; hop++) {
    const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
    if (ctx.done || !ctx.focus_node) break;
    const id = ctx.focus_node.id;
    const base = {
      focus_node_id: id,
      sections: [{ angle: 'business' as const, text: `${id} body` }],
      summary: `${id} body`,
    };
    const outcome = (() => {
      if (id === 'report') {
        return engine.submitFindings({
          ...base,
          verdict: 'passthrough',
          column_flow: [{ out_col: 'amount', upstream_columns: [{ node: 'carrier', col: 'amount' }] }],
          questions: [
            { nodeId: 'carrier', question: 'where does amount come from' },
            { nodeId: 'side', question: 'what does this restrict' },
          ],
        });
      }
      if (id === 'carrier') {
        return engine.submitFindings({
          ...base,
          verdict: 'passthrough',
          column_flow: [{ out_col: 'amount', upstream_columns: [] }],
        });
      }
      if (id === 'side') {
        return engine.submitFindings({
          ...base,
          verdict: 'analyze',
          questions: [{ nodeId: 'behind', question: 'what feeds this restriction' }],
        });
      }
      if (id === 'behind') {
        return engine.submitFindings({ ...base, verdict: 'passthrough' });
      }
      throw new Error(`unexpected CT focus ${id}`);
    })();
    expect((outcome as { error?: string }).error, `hop on ${id} must commit`).toBeUndefined();
  }
  return engine;
}

describe('BB <-> CT node-set parity', () => {
  it('BB and CT walk the same fixture to the same final node set', () => {
    const bbIds = runBb().getResult().fullNodes.map(n => n.id).sort();
    const ctIds = runCt().getResult().fullNodes.map(n => n.id).sort();
    expect(ctIds, `CT node set [${ctIds.join(', ')}] must equal BB's [${bbIds.join(', ')}]`).toEqual(bbIds);
  });

  it('the column-less branch (side, behind) reaches the result in both arms', () => {
    const bbIds = runBb().getResult().fullNodes.map(n => n.id);
    const ctIds = runCt().getResult().fullNodes.map(n => n.id);
    for (const id of ['side', 'behind']) {
      expect(bbIds, `BB must keep ${id} — it is reachable through the same topology CT walks`).toContain(id);
      expect(ctIds, `CT must keep ${id} — a column trace historically lost this branch`).toContain(id);
    }
  });
});

/**
 * Second shape: a bidirectional trace of two columns at a middle view. `mart.amount` comes from
 * `fact.amount`; `mart.currency` is a hardcoded literal and terminates at `mart`; `dash` reads
 * `mart` downstream. Same node set in both arms.
 */
describe('BB <-> CT node-set parity: two columns, one literal, bidirectional', () => {
  const cols = [
    { name: 'amount', type: 'int', nullable: 'NOT NULL', extra: '' },
    { name: 'currency', type: 'char(3)', nullable: 'NOT NULL', extra: '' },
  ];
  const nodes: LineageNode[] = [
    makeNode({ id: 'fact', schema: 'dbo', name: 'fact', type: 'view', columns: [cols[0]] }),
    makeNode({ id: 'mart', schema: 'dbo', name: 'mart', type: 'view', columns: cols }),
    makeNode({ id: 'dash', schema: 'dbo', name: 'dash', type: 'view', columns: cols }),
  ];
  const edges: Array<[string, string]> = [['fact', 'mart'], ['mart', 'dash']];
  const model = makeModel(nodes, edges, ['dbo']);

  function run(mode: 'bb' | 'ct'): string[] {
    const engine = new NavigationEngine(model, makeGraph(nodes, edges), () => {}, {});
    const init = engine.init({
      origin: 'mart', question: 'trace amount and currency', direction: 'bidirectional',
      depthIntent: { kind: 'explicit', levels: 2 },
      ...(mode === 'ct' ? { analysisMode: 'ct' as const, targetColumns: ['amount', 'currency'] } : { analysisMode: 'bb' as const }),
    });
    expect('ok' in init, `${mode} init must succeed`).toBe(true);
    for (let hop = 0; hop < 10; hop++) {
      const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
      if (ctx.done || !ctx.focus_node) break;
      const id = ctx.focus_node.id;
      const base = { focus_node_id: id, sections: [{ angle: 'business' as const, text: id }], summary: id, verdict: 'analyze' as const };
      const ct = mode === 'ct';
      const outcome = id === 'mart'
        ? engine.submitFindings({
          ...base,
          questions: [
            { nodeId: 'fact', question: 'where does amount come from' },
            { nodeId: 'dash', question: 'who consumes amount and currency' },
          ],
          ...(ct ? { column_flow: [
            { out_col: 'amount', upstream_columns: [{ node: 'fact', col: 'amount' }] },
            { out_col: 'currency', upstream_columns: [] },
          ] } : {}),
        })
        : engine.submitFindings({
          ...base,
          ...(ct ? { column_flow: engine.columnAspect!.active_columns.map((out_col) => ({ out_col, upstream_columns: [] })) } : {}),
        });
      expect((outcome as { error?: string }).error, `${mode} hop on ${id} must commit`).toBeUndefined();
    }
    return engine.getResult().fullNodes.map(n => n.id).sort();
  }

  it('BB and CT keep the same node set', () => {
    const bb = run('bb');
    expect(bb, 'BB reaches both sides').toEqual(['dash', 'fact', 'mart']);
    expect(run('ct'), 'CT node set equals BB').toEqual(bb);
  });
});

/**
 * Third shape: an explicit AI prune — `verdict: 'end_branch'` on the pruned node's own hop, tallied
 * `verdict: 'prune'` in `getHopProgress()` (`hopProgress.pruned` counts `nodeStates` entries with
 * `action === 'prune'`, `smBase.ts`). The engine pre-seeds the whole approved-depth scope into the
 * agenda at `init()` — `prune_neighbors` named from a DIFFERENT node's hop refuses a target that is
 * already queued for its own hop (`prune_noop_queued`, `currentHopActionPolicy.ts`) — so an
 * already-scoped node is cut on ITS OWN hop, the file's existing `driveEngine` `prune` option's
 * mechanism. `root` keeps `keep` (continues `amount`); `pruned` is column-less for `amount`
 * (row-shaping only, like `side` in the first fixture) and cuts itself on its own hop.
 * `behindPruned` is reachable only through `pruned`, so the cut cascade (`cutUnreachable`) drops it
 * from the agenda before it is ever dispatched, identically in both arms.
 */
describe('BB <-> CT node-set parity: explicit prune (end_branch) cut', () => {
  const nodes: LineageNode[] = [
    makeNode({ id: 'root', schema: 'dbo', name: 'root', type: 'view', columns: [{ name: 'amount', type: 'int', nullable: 'NOT NULL', extra: '' }] }),
    makeNode({ id: 'keep', schema: 'dbo', name: 'keep', type: 'view', columns: [{ name: 'amount', type: 'int', nullable: 'NOT NULL', extra: '' }] }),
    makeNode({ id: 'pruned', schema: 'dbo', name: 'pruned', type: 'view', columns: [{ name: 'region', type: 'varchar', nullable: 'NOT NULL', extra: '' }] }),
    makeNode({ id: 'behindPruned', schema: 'dbo', name: 'behindPruned', type: 'view', columns: [{ name: 'region', type: 'varchar', nullable: 'NOT NULL', extra: '' }] }),
  ];
  const edges: Array<[string, string]> = [['keep', 'root'], ['pruned', 'root'], ['behindPruned', 'pruned']];
  const model = makeModel(nodes, edges, ['dbo']);
  const ALL_IDS = nodes.map(n => n.id);
  const EXPECTED_KEPT = ['keep', 'root'];
  const EXPECTED_PRUNED = ['behindPruned', 'pruned'];

  function run(mode: 'bb' | 'ct'): string[] {
    const engine = new NavigationEngine(model, makeGraph(nodes, edges), () => {}, {});
    const ct = mode === 'ct';
    const init = engine.init({
      origin: 'root', question: 'trace amount', direction: 'upstream',
      depthIntent: { kind: 'explicit', levels: 3 },
      ...(ct ? { analysisMode: 'ct' as const, targetColumns: ['amount'] } : { analysisMode: 'bb' as const }),
    });
    expect('ok' in init, `${mode} init must succeed`).toBe(true);
    for (let hop = 0; hop < 10; hop++) {
      const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
      if (ctx.done || !ctx.focus_node) break;
      const id = ctx.focus_node.id;
      if (id === 'pruned') {
        const outcome = engine.submitFindings({ focus_node_id: id, verdict: 'end_branch', reason: 'pruned\'s SQL shows it never feeds amount' });
        expect((outcome as { error?: string }).error, `${mode} end_branch on ${id} must commit`).toBeUndefined();
        continue;
      }
      const base = { focus_node_id: id, sections: [{ angle: 'business' as const, text: id }], summary: id, verdict: 'analyze' as const };
      const outcome = id === 'root'
        ? engine.submitFindings({
          ...base,
          ...(ct ? { column_flow: [{ out_col: 'amount', upstream_columns: [{ node: 'keep', col: 'amount' }] }] } : {}),
        })
        : id === 'keep'
          ? engine.submitFindings({
            ...base,
            verdict: 'passthrough',
            ...(ct ? { column_flow: [{ out_col: 'amount', upstream_columns: [] }] } : {}),
          })
          : (() => { throw new Error(`unexpected ${mode} focus ${id}`); })();
      expect((outcome as { error?: string }).error, `${mode} hop on ${id} must commit`).toBeUndefined();
    }
    return engine.getResult().fullNodes.map(n => n.id).sort();
  }

  it('BB and CT keep the same node set and prune the same node set', () => {
    const bb = run('bb');
    const ct = run('ct');
    expect(bb, 'BB keeps only the un-pruned branch').toEqual(EXPECTED_KEPT);
    expect(ct, 'CT node set equals BB').toEqual(bb);
    for (const arm of [{ label: 'BB', ids: bb }, { label: 'CT', ids: ct }]) {
      for (const prunedId of EXPECTED_PRUNED) {
        expect(arm.ids, `${arm.label} must not keep ${prunedId} — pruned or reachable only through a prune`).not.toContain(prunedId);
      }
      for (const id of ALL_IDS) {
        expect(EXPECTED_KEPT.includes(id) || EXPECTED_PRUNED.includes(id), `fixture id ${id} must be classified kept or pruned`).toBe(true);
      }
    }
  });
});

/**
 * Fourth shape: a schema-exclusion border (`checkBorder`'s `excluded` axis, `smBase.ts` ~1050).
 * `excludeSchemas: ['sec']` cuts `blocked` (schema `sec`) outright — dropped at the border, never
 * deferred — even though `root`'s finding explicitly asks a question of it; `behindBlocked` is
 * reachable only through `blocked` and is never offered a route at all. Same border, same outcome,
 * both arms.
 */
describe('BB <-> CT node-set parity: schema-exclusion border', () => {
  const nodes: LineageNode[] = [
    makeNode({ id: 'root', schema: 'dbo', name: 'root', type: 'view', columns: [{ name: 'amount', type: 'int', nullable: 'NOT NULL', extra: '' }] }),
    makeNode({ id: 'good', schema: 'dbo', name: 'good', type: 'view', columns: [{ name: 'amount', type: 'int', nullable: 'NOT NULL', extra: '' }] }),
    makeNode({ id: 'blocked', schema: 'sec', name: 'blocked', type: 'view', columns: [{ name: 'amount', type: 'int', nullable: 'NOT NULL', extra: '' }] }),
    makeNode({ id: 'behindBlocked', schema: 'sec', name: 'behindBlocked', type: 'view', columns: [{ name: 'amount', type: 'int', nullable: 'NOT NULL', extra: '' }] }),
  ];
  const edges: Array<[string, string]> = [['good', 'root'], ['blocked', 'root'], ['behindBlocked', 'blocked']];
  const model = makeModel(nodes, edges, ['dbo', 'sec']);
  const EXPECTED_KEPT = ['good', 'root'];

  function run(mode: 'bb' | 'ct'): string[] {
    const engine = new NavigationEngine(model, makeGraph(nodes, edges), () => {}, {});
    const ct = mode === 'ct';
    const init = engine.init({
      origin: 'root', question: 'trace amount', direction: 'upstream',
      depthIntent: { kind: 'explicit', levels: 3 },
      excludeSchemas: ['sec'],
      ...(ct ? { analysisMode: 'ct' as const, targetColumns: ['amount'] } : { analysisMode: 'bb' as const }),
    });
    expect('ok' in init, `${mode} init must succeed`).toBe(true);
    for (let hop = 0; hop < 10; hop++) {
      const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
      if (ctx.done || !ctx.focus_node) break;
      const id = ctx.focus_node.id;
      const base = { focus_node_id: id, sections: [{ angle: 'business' as const, text: id }], summary: id, verdict: 'analyze' as const };
      const outcome = id === 'root'
        ? engine.submitFindings({
          ...base,
          questions: [
            { nodeId: 'good', question: 'where does amount come from' },
            { nodeId: 'blocked', question: 'where does amount come from' },
          ],
          ...(ct ? { column_flow: [{ out_col: 'amount', upstream_columns: [{ node: 'good', col: 'amount' }] }] } : {}),
        })
        : id === 'good'
          ? engine.submitFindings({
            ...base,
            verdict: 'passthrough',
            ...(ct ? { column_flow: [{ out_col: 'amount', upstream_columns: [] }] } : {}),
          })
          : (() => { throw new Error(`unexpected ${mode} focus ${id}`); })();
      expect((outcome as { error?: string }).error, `${mode} hop on ${id} must commit`).toBeUndefined();
    }
    return engine.getResult().fullNodes.map(n => n.id).sort();
  }

  it('BB and CT drop the excluded schema and everything only reachable through it', () => {
    const bb = run('bb');
    const ct = run('ct');
    expect(bb, 'BB keeps only the dbo-reachable branch').toEqual(EXPECTED_KEPT);
    expect(ct, 'CT node set equals BB').toEqual(bb);
    for (const arm of [{ label: 'BB', ids: bb }, { label: 'CT', ids: ct }]) {
      for (const excludedId of ['blocked', 'behindBlocked']) {
        expect(arm.ids, `${arm.label} must not keep excluded-schema ${excludedId}`).not.toContain(excludedId);
      }
    }
  });
});

/**
 * Fifth shape: a per-side depth-border demotion (`smTypes.ts` `gateDepthSide` /
 * `resolveDepthIntentForBoundary`, `startExploration.ts`; commit 0552bdb82). `depthIntent.kind
 * === 'asymmetric'` caps upstream at 1 and leaves downstream `'all'`: `up1` (upstream depth 1) is
 * admitted, `up2` (upstream depth 2, reachable only through `up1`) breaches the upstream border and
 * is deferred, never dispatched; `down1`/`down2` (downstream, uncapped) are both admitted. Same two
 * per-side ceilings, same admitted/deferred split, in both arms.
 */
describe('BB <-> CT node-set parity: asymmetric per-side depth border', () => {
  const amountCol = { name: 'amount', type: 'int', nullable: 'NOT NULL', extra: '' };
  const regionCol = { name: 'region', type: 'varchar', nullable: 'NOT NULL', extra: '' };
  const nodes: LineageNode[] = [
    makeNode({ id: 'root', schema: 'dbo', name: 'root', type: 'view', columns: [amountCol] }),
    makeNode({ id: 'up1', schema: 'dbo', name: 'up1', type: 'view', columns: [amountCol] }),
    makeNode({ id: 'up2', schema: 'dbo', name: 'up2', type: 'view', columns: [amountCol] }),
    makeNode({ id: 'down1', schema: 'dbo', name: 'down1', type: 'view', columns: [regionCol] }),
    makeNode({ id: 'down2', schema: 'dbo', name: 'down2', type: 'view', columns: [regionCol] }),
  ];
  const edges: Array<[string, string]> = [['up2', 'up1'], ['up1', 'root'], ['root', 'down1'], ['down1', 'down2']];
  const model = makeModel(nodes, edges, ['dbo']);
  const EXPECTED_KEPT = ['down1', 'down2', 'root', 'up1'];

  function run(mode: 'bb' | 'ct'): string[] {
    const engine = new NavigationEngine(model, makeGraph(nodes, edges), () => {}, {});
    const ct = mode === 'ct';
    const init = engine.init({
      origin: 'root', question: 'trace amount', direction: 'bidirectional',
      depthIntent: { kind: 'asymmetric', upstream: 1, downstream: 'all' },
      ...(ct ? { analysisMode: 'ct' as const, targetColumns: ['amount'] } : { analysisMode: 'bb' as const }),
    });
    expect('ok' in init, `${mode} init must succeed (${'error' in init ? init.error : ''})`).toBe(true);
    for (let hop = 0; hop < 10; hop++) {
      const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
      if (ctx.done || !ctx.focus_node) break;
      const id = ctx.focus_node.id;
      const base = { focus_node_id: id, sections: [{ angle: 'business' as const, text: id }], summary: id, verdict: 'analyze' as const };
      const outcome = (() => {
        switch (id) {
          case 'root':
            return engine.submitFindings({
              ...base,
              questions: [
                { nodeId: 'up1', question: 'where does amount come from' },
                { nodeId: 'down1', question: 'who consumes this' },
              ],
              ...(ct ? { column_flow: [{ out_col: 'amount', upstream_columns: [{ node: 'up1', col: 'amount' }] }] } : {}),
            });
          case 'up1':
            return engine.submitFindings({
              ...base,
              verdict: 'passthrough',
              ...(ct ? { column_flow: [{ out_col: 'amount', upstream_columns: [] }] } : {}),
            });
          case 'down1':
            return engine.submitFindings({ ...base, verdict: 'passthrough', questions: [{ nodeId: 'down2', question: 'who consumes this' }] });
          case 'down2':
            return engine.submitFindings({ ...base, verdict: 'passthrough' });
          default:
            throw new Error(`unexpected ${mode} focus ${id}`);
        }
      })();
      expect((outcome as { error?: string }).error, `${mode} hop on ${id} must commit`).toBeUndefined();
    }
    return engine.getResult().fullNodes.map(n => n.id).sort();
  }

  it('BB and CT admit the same side and defer the same side', () => {
    const bb = run('bb');
    const ct = run('ct');
    expect(bb, 'BB admits uncapped downstream, caps upstream at 1').toEqual(EXPECTED_KEPT);
    expect(ct, 'CT node set equals BB').toEqual(bb);
    for (const arm of [{ label: 'BB', ids: bb }, { label: 'CT', ids: ct }]) {
      expect(arm.ids, `${arm.label} must not walk past the upstream depth-1 border`).not.toContain('up2');
    }
  });
});

/**
 * Sixth shape: a fixed-direction `out_of_direction` disclosure (`smBase.ts` `buildNeighborList`
 * ~3317-3345; commit 11c3ae9b1). `direction: 'upstream'` approves only `up`; `down` is a genuine
 * graph neighbor of `root` on the disapproved side. In CT, `buildNeighborList` discloses `down` as
 * `out_of_direction: true` in the hop context — informational only, derived from the same
 * `isReachableInApprovedDirection` predicate `checkBorder`'s `route` purpose already uses to refuse
 * the route in BOTH arms. The disclosure must never change what gets routed: `down` is absent from
 * `fullNodes` in BB (which never computes the flag at all) exactly as in CT.
 */
describe('BB <-> CT node-set parity: fixed-direction out_of_direction disclosure', () => {
  const amountCol = { name: 'amount', type: 'int', nullable: 'NOT NULL', extra: '' };
  const nodes: LineageNode[] = [
    makeNode({ id: 'root', schema: 'dbo', name: 'root', type: 'view', columns: [amountCol] }),
    makeNode({ id: 'up', schema: 'dbo', name: 'up', type: 'view', columns: [amountCol] }),
    makeNode({ id: 'down', schema: 'dbo', name: 'down', type: 'view', columns: [amountCol] }),
  ];
  const edges: Array<[string, string]> = [['up', 'root'], ['root', 'down']];
  const model = makeModel(nodes, edges, ['dbo']);
  const EXPECTED_KEPT = ['root', 'up'];

  function run(mode: 'bb' | 'ct'): { ids: string[]; sawDisclosure: boolean } {
    const engine = new NavigationEngine(model, makeGraph(nodes, edges), () => {}, {});
    const ct = mode === 'ct';
    const init = engine.init({
      origin: 'root', question: 'trace amount', direction: 'upstream',
      depthIntent: { kind: 'explicit', levels: 3 },
      ...(ct ? { analysisMode: 'ct' as const, targetColumns: ['amount'] } : { analysisMode: 'bb' as const }),
    });
    expect('ok' in init, `${mode} init must succeed`).toBe(true);
    let sawDisclosure = false;
    for (let hop = 0; hop < 10; hop++) {
      const ctx = engine.getHopContext() as {
        done?: boolean;
        focus_node?: { id: string };
        neighbors?: Array<{ id: string; out_of_direction?: boolean }>;
      };
      if (ctx.done || !ctx.focus_node) break;
      const id = ctx.focus_node.id;
      if (id === 'root') {
        const downNeighbor = (ctx.neighbors ?? []).find(n => n.id === 'down');
        if (ct) {
          expect(downNeighbor?.out_of_direction, 'CT must disclose the disapproved-direction neighbor').toBe(true);
          sawDisclosure = true;
        } else {
          expect(downNeighbor?.out_of_direction, 'BB never sets the CT-only disclosure flag').toBeUndefined();
        }
      }
      const base = { focus_node_id: id, sections: [{ angle: 'business' as const, text: id }], summary: id, verdict: 'analyze' as const };
      const outcome = id === 'root'
        ? engine.submitFindings({
          ...base,
          questions: [
            { nodeId: 'up', question: 'where does amount come from' },
            { nodeId: 'down', question: 'who consumes amount' },
          ],
          ...(ct ? { column_flow: [{ out_col: 'amount', upstream_columns: [{ node: 'up', col: 'amount' }] }] } : {}),
        })
        : id === 'up'
          ? engine.submitFindings({
            ...base,
            verdict: 'passthrough',
            ...(ct ? { column_flow: [{ out_col: 'amount', upstream_columns: [] }] } : {}),
          })
          : (() => { throw new Error(`unexpected ${mode} focus ${id}`); })();
      expect((outcome as { error?: string }).error, `${mode} hop on ${id} must commit`).toBeUndefined();
    }
    return { ids: engine.getResult().fullNodes.map(n => n.id).sort(), sawDisclosure };
  }

  it('the disclosure fires in CT but never adds or removes a node versus BB', () => {
    const bb = run('bb');
    const ct = run('ct');
    expect(ct.sawDisclosure, 'CT arm must actually exercise the disclosure branch').toBe(true);
    expect(bb.ids, 'BB approves only the upstream side').toEqual(EXPECTED_KEPT);
    expect(ct.ids, 'CT node set equals BB — the disclosure changed nothing').toEqual(bb.ids);
    for (const arm of [{ label: 'BB', ids: bb.ids }, { label: 'CT', ids: ct.ids }]) {
      expect(arm.ids, `${arm.label} must not keep the disapproved-direction neighbor`).not.toContain('down');
    }
  });
});
