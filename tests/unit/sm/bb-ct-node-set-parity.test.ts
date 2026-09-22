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
// [source, consumer] — upstream from `report` reaches `carrier` and `side`; `behind` feeds `side`.
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
          route_requests: [
            { nodeId: 'carrier', question: 'where does amount come from' },
            { nodeId: 'side', question: 'what does this restrict', columns: 'none' as const },
          ],
        });
      }
      if (id === 'carrier') {
        // `carrier` declares `amount` itself and has no further upstream in this fixture: the
        // chain terminates here with an explicit originates-here entry, not an empty array — an
        // empty `column_flow` is only accepted from a focus that declares none of the active columns.
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
          route_requests: [{ nodeId: 'behind', question: 'what feeds this restriction' }],
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
