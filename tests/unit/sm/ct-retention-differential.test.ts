/**
 * CT retention — a node admitted to scope and never pruned (in `scopeNodeIds`, absent from
 * `removedSet`) must survive to the render, matching BB. Each case keeps only what decides
 * retention: the traced column's value supplier, and the dependency that supplies no value to it.
 * `flow` is the column_flow submitted at each bodied focus.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { ColumnEdge, SmResult } from '../../../src/ai/sm/smTypes';
import { bfsReachable } from '../../../src/engine/graphGuards';
import type { DatabaseModel, LineageNode, ObjectType } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeActiveFilter, makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';
import { buildActiveHopInstruction } from '../../../src/ai/agent/stagePrompts';
import { EMPTY_AI_TEMPLATES } from '../../../src/ai/session/types';
import type { AiSession } from '../../../src/ai/session/session';

interface ColumnRef { node: string; col: string }
interface FlowEntry { out_col: string; upstream_columns: ColumnRef[]; writes_to?: ColumnRef }

interface RetentionCase {
  /** Case id. */
  readonly id: string;
  readonly origin: string;
  readonly tracedColumn: string;
  /** Node id → object type; every node also declares the columns the case names. */
  readonly nodes: ReadonlyArray<readonly [string, ObjectType, string[]]>;
  readonly edges: ReadonlyArray<readonly [string, string]>;
  /** Required upstream dependencies, from the case's golden `reach_required`. */
  readonly reachRequired: readonly string[];
  /** column_flow submitted at each bodied focus, as the measured run's model submitted it. */
  readonly flow: Readonly<Record<string, FlowEntry[]>>;
  /** Required nodes CT must retain in this case. */
  readonly measuredLost: readonly string[];
  /** Active column set the hop at this node must be dispatched with, asserted at dequeue. */
  readonly expectActiveColumns?: Readonly<Record<string, readonly string[]>>;
  /** Traversal direction for both arms; upstream unless the case needs a write side. */
  readonly direction?: 'upstream' | 'downstream' | 'bidirectional';
  /** Schemas the user's filter admits, seeding the session allowlist. Unset means no allowlist. */
  readonly filterSchemas?: readonly string[];
  /**
   * Ids the render itself is expected to drop — in scope, never pruned, and dispositioned by no
   * hop. Unset means the render drops nothing, which is what every case asserted before the field
   * existed and what each of them still asserts.
   */
  readonly expectRenderDropped?: readonly string[];
  /**
   * Per-node verdict override for {@link driveCt}; every node not listed submits `analyze`. A node
   * whose active columns bind to none of its own declared columns (a non-bodied carrier handed a
   * real upstream column name under which it has no column of its own) has no valid `out_col` to
   * name — `passthrough` with an empty `column_flow` is the one declared escape for that shape
   * (`declaresNoTrackedColumns`, `smBase.ts`).
   */
  readonly verdictOverride?: Readonly<Record<string, 'analyze' | 'passthrough'>>;
}

const V = 'view' as const, T = 'table' as const, P = 'procedure' as const, F = 'function' as const;

/** Every dependency supplies the traced value — nothing to lose. */
const CASES: readonly RetentionCase[] = [
  {
    id: 'C0 — filter-only calendar join',
    origin: '[ai].[vwconsolidatedsales]', tracedColumn: 'OrderAmount',
    nodes: [
      ['[ai].[vwconsolidatedsales]', V, ['OrderAmount']],
      ['[ai].[salesstaging]', T, ['OrderAmount']],
      ['[ai].[dimcalendar]', T, ['DateKey']],
    ],
    edges: [['[ai].[salesstaging]', '[ai].[vwconsolidatedsales]'], ['[ai].[dimcalendar]', '[ai].[vwconsolidatedsales]']],
    reachRequired: ['[ai].[salesstaging]', '[ai].[dimcalendar]'],
    flow: { '[ai].[vwconsolidatedsales]': [{ out_col: 'OrderAmount', upstream_columns: [{ node: '[ai].[salesstaging]', col: 'OrderAmount' }] }] },
    measuredLost: ['[ai].[dimcalendar]'],
  },
  {
    id: 'C1 — join driver that supplies no value to the traced column',
    origin: '[ct].[vwregionalorders]', tracedColumn: 'RegionName',
    nodes: [
      ['[ct].[vwregionalorders]', V, ['RegionName']],
      ['[ct].[regions]', T, ['RegionName']],
      ['[ct].[orders]', T, ['OrderAmount']],
    ],
    edges: [['[ct].[orders]', '[ct].[vwregionalorders]'], ['[ct].[regions]', '[ct].[vwregionalorders]']],
    reachRequired: ['[ct].[orders]', '[ct].[regions]'],
    flow: { '[ct].[vwregionalorders]': [{ out_col: 'RegionName', upstream_columns: [{ node: '[ct].[regions]', col: 'RegionName' }] }] },
    measuredLost: ['[ct].[orders]'],
  },
  {
    id: 'C2 — every dependency supplies the value (control, no loss measured)',
    origin: '[ct].[vwlatestprice]', tracedColumn: 'UnitPrice',
    nodes: [['[ct].[vwlatestprice]', V, ['UnitPrice']], ['[ct].[prices]', T, ['UnitPrice']]],
    edges: [['[ct].[prices]', '[ct].[vwlatestprice]']],
    reachRequired: ['[ct].[prices]'],
    flow: { '[ct].[vwlatestprice]': [{ out_col: 'UnitPrice', upstream_columns: [{ node: '[ct].[prices]', col: 'UnitPrice' }] }] },
    measuredLost: [],
  },
  {
    id: 'C3 — GROUP BY grain setter',
    origin: '[ct].[vwtopcustomers]', tracedColumn: 'TotalAmount',
    nodes: [
      ['[ct].[vwtopcustomers]', V, ['TotalAmount']],
      ['[ct].[orders]', T, ['OrderAmount']],
      ['[ct].[customers]', T, ['CustomerID']],
    ],
    edges: [['[ct].[orders]', '[ct].[vwtopcustomers]'], ['[ct].[customers]', '[ct].[vwtopcustomers]']],
    reachRequired: ['[ct].[orders]', '[ct].[customers]'],
    flow: { '[ct].[vwtopcustomers]': [{ out_col: 'TotalAmount', upstream_columns: [{ node: '[ct].[orders]', col: 'OrderAmount' }] }] },
    measuredLost: ['[ct].[customers]'],
  },
  {
    id: 'C4 — lookup that selects the rate but supplies no traced value',
    origin: '[ct].[vwnetprice]', tracedColumn: 'NetPrice',
    nodes: [
      ['[ct].[vwnetprice]', V, ['NetPrice']],
      ['[ct].[prices]', T, ['ListPrice']],
      ['[ct].[regions]', T, ['RegionCode']],
    ],
    edges: [['[ct].[prices]', '[ct].[vwnetprice]'], ['[ct].[regions]', '[ct].[vwnetprice]']],
    reachRequired: ['[ct].[prices]', '[ct].[regions]'],
    flow: { '[ct].[vwnetprice]': [{ out_col: 'NetPrice', upstream_columns: [{ node: '[ct].[prices]', col: 'ListPrice' }] }] },
    measuredLost: ['[ct].[regions]'],
  },
  {
    id: 'C5 — procedure-written fact (control, no loss measured)',
    origin: '[ct].[factmargin]', tracedColumn: 'Margin',
    nodes: [
      ['[ct].[factmargin]', T, ['Margin']],
      ['[ct].[spbuildmarginfact]', P, ['Margin']],
      ['[ct].[orders]', T, ['OrderAmount']],
      ['[ct].[prices]', T, ['UnitPrice']],
    ],
    edges: [
      ['[ct].[spbuildmarginfact]', '[ct].[factmargin]'],
      ['[ct].[orders]', '[ct].[spbuildmarginfact]'],
      ['[ct].[prices]', '[ct].[spbuildmarginfact]'],
    ],
    reachRequired: ['[ct].[spbuildmarginfact]', '[ct].[orders]', '[ct].[prices]'],
    flow: {
      // The origin is always dispatched, bodied or not.
      '[ct].[factmargin]': [{ out_col: 'Margin', upstream_columns: [{ node: '[ct].[spbuildmarginfact]', col: 'Margin' }] }],
      '[ct].[spbuildmarginfact]': [{ out_col: 'Margin', upstream_columns: [{ node: '[ct].[orders]', col: 'OrderAmount' }, { node: '[ct].[prices]', col: 'UnitPrice' }] }],
    },
    measuredLost: [],
  },
  {
    id: 'C6 — calendar joined at the top of a view stack',
    origin: '[ct].[vwmarginstack]', tracedColumn: 'Margin',
    nodes: [
      ['[ct].[vwmarginstack]', V, ['Margin']],
      ['[ct].[vwmarginl2]', V, ['Margin']],
      ['[ct].[vwmarginl1]', V, ['Margin']],
      ['[ct].[orders]', T, ['OrderAmount']],
      ['[ct].[prices]', T, ['UnitPrice']],
      ['[ct].[calendar]', T, ['DateKey']],
    ],
    edges: [
      ['[ct].[vwmarginl2]', '[ct].[vwmarginstack]'],
      ['[ct].[calendar]', '[ct].[vwmarginstack]'],
      ['[ct].[vwmarginl1]', '[ct].[vwmarginl2]'],
      ['[ct].[orders]', '[ct].[vwmarginl1]'],
      ['[ct].[prices]', '[ct].[vwmarginl1]'],
    ],
    reachRequired: ['[ct].[vwmarginl2]', '[ct].[vwmarginl1]', '[ct].[orders]', '[ct].[prices]', '[ct].[calendar]'],
    flow: {
      '[ct].[vwmarginstack]': [{ out_col: 'Margin', upstream_columns: [{ node: '[ct].[vwmarginl2]', col: 'Margin' }] }],
      '[ct].[vwmarginl2]': [{ out_col: 'Margin', upstream_columns: [{ node: '[ct].[vwmarginl1]', col: 'Margin' }] }],
      '[ct].[vwmarginl1]': [{ out_col: 'Margin', upstream_columns: [{ node: '[ct].[orders]', col: 'OrderAmount' }, { node: '[ct].[prices]', col: 'UnitPrice' }] }],
    },
    measuredLost: ['[ct].[calendar]'],
  },
  {
    id: 'C7 — anti-join suppression plus two set-deciding lookups',
    origin: '[ct].[vwactivecustomersales]', tracedColumn: 'OrderAmount',
    nodes: [
      ['[ct].[vwactivecustomersales]', V, ['OrderAmount']],
      ['[ct].[orders]', T, ['OrderAmount']],
      ['[ct].[customers]', T, ['CustomerID']],
      ['[ct].[suppressedcustomers]', T, ['CustomerID']],
      ['[ct].[regions]', T, ['RegionCode']],
    ],
    edges: [
      ['[ct].[orders]', '[ct].[vwactivecustomersales]'],
      ['[ct].[customers]', '[ct].[vwactivecustomersales]'],
      ['[ct].[suppressedcustomers]', '[ct].[vwactivecustomersales]'],
      ['[ct].[regions]', '[ct].[vwactivecustomersales]'],
    ],
    reachRequired: ['[ct].[orders]', '[ct].[customers]', '[ct].[suppressedcustomers]', '[ct].[regions]'],
    flow: { '[ct].[vwactivecustomersales]': [{ out_col: 'OrderAmount', upstream_columns: [{ node: '[ct].[orders]', col: 'OrderAmount' }] }] },
    measuredLost: ['[ct].[customers]', '[ct].[suppressedcustomers]', '[ct].[regions]'],
  },
  {
    id: 'C8 — UNION branch whose deeper source feeds a sibling column',
    origin: '[ct].[vwunionsales]', tracedColumn: 'Amount',
    nodes: [
      ['[ct].[vwunionsales]', V, ['Amount']],
      ['[ct].[orders]', T, ['OrderAmount']],
      ['[ct].[factmargin]', T, ['Margin']],
      ['[ct].[spbuildmarginfact]', P, ['Margin']],
      ['[ct].[prices]', T, ['UnitPrice']],
    ],
    edges: [
      ['[ct].[orders]', '[ct].[vwunionsales]'],
      ['[ct].[factmargin]', '[ct].[vwunionsales]'],
      ['[ct].[spbuildmarginfact]', '[ct].[factmargin]'],
      ['[ct].[orders]', '[ct].[spbuildmarginfact]'],
      ['[ct].[prices]', '[ct].[spbuildmarginfact]'],
    ],
    reachRequired: ['[ct].[orders]', '[ct].[factmargin]', '[ct].[spbuildmarginfact]', '[ct].[prices]'],
    flow: {
      '[ct].[vwunionsales]': [{ out_col: 'Amount', upstream_columns: [{ node: '[ct].[orders]', col: 'OrderAmount' }, { node: '[ct].[factmargin]', col: 'Margin' }] }],
      '[ct].[spbuildmarginfact]': [{ out_col: 'Margin', upstream_columns: [{ node: '[ct].[orders]', col: 'OrderAmount' }] }],
    },
    measuredLost: ['[ct].[prices]'],
  },
  {
    id: 'C9 — fan-out join feeding a sibling column only',
    origin: '[ct].[vworderwithtax]', tracedColumn: 'TotalAmount',
    nodes: [
      ['[ct].[vworderwithtax]', V, ['TotalAmount']],
      ['[ct].[orders]', T, ['OrderAmount']],
      ['[ct].[taxrates]', T, ['TaxPct']],
    ],
    edges: [['[ct].[orders]', '[ct].[vworderwithtax]'], ['[ct].[taxrates]', '[ct].[vworderwithtax]']],
    reachRequired: ['[ct].[orders]', '[ct].[taxrates]'],
    flow: { '[ct].[vworderwithtax]': [{ out_col: 'TotalAmount', upstream_columns: [{ node: '[ct].[orders]', col: 'OrderAmount' }] }] },
    measuredLost: ['[ct].[taxrates]'],
  },
  {
    id: 'C10 — scalar function on the value path (control, no loss measured)',
    origin: '[ct].[vwsurchargedsales]', tracedColumn: 'GrossAmount',
    nodes: [
      ['[ct].[vwsurchargedsales]', V, ['GrossAmount']],
      ['[ct].[orders]', T, ['OrderAmount']],
      ['[ct].[fnapplysurcharge]', F, ['SurchargedAmount']],
      ['[ct].[taxrates]', T, ['TaxPct']],
    ],
    edges: [
      ['[ct].[orders]', '[ct].[vwsurchargedsales]'],
      ['[ct].[fnapplysurcharge]', '[ct].[vwsurchargedsales]'],
      ['[ct].[taxrates]', '[ct].[fnapplysurcharge]'],
    ],
    reachRequired: ['[ct].[orders]', '[ct].[fnapplysurcharge]', '[ct].[taxrates]'],
    flow: {
      '[ct].[vwsurchargedsales]': [{ out_col: 'GrossAmount', upstream_columns: [{ node: '[ct].[orders]', col: 'OrderAmount' }, { node: '[ct].[fnapplysurcharge]', col: 'SurchargedAmount' }] }],
      '[ct].[fnapplysurcharge]': [{ out_col: 'SurchargedAmount', upstream_columns: [{ node: '[ct].[taxrates]', col: 'TaxPct' }] }],
    },
    measuredLost: [],
  },
  {
    // `[ct].[stgorders]` is a bare table with one column, `RawAmount` — the real DDL name the
    // origin's own `column_flow` names it under, and own-provenance always wins over a route's
    // stated carry (`routeCarryFor`). That real name is what a non-bodied carrier mechanically
    // forwards to the node behind it: `[ct].[vworderfeed]` is dispatched with `RawAmount`, not with
    // `NetAmount` (the session's traced column spelling, and vworderfeed's own declared column) —
    // there is no bodied hop between the two that could reassert the value under vworderfeed's own
    // name, and the engine no longer bridges that gap by re-deriving each node's active set from
    // the session's target-column spelling. vworderfeed's own `RawAmount` binds to none of its
    // declared columns (`declaredActiveColumns` empty), so `column_flow:[]` under `passthrough` is
    // its one honest account (`declaresNoTrackedColumns`, `smBase.ts`) — it still must be traversed,
    // exactly as BB's walk does, but commits no column edge of its own.
    id: 'C15 — a carrier that declares none of the traced columns must still be traversed',
    origin: '[ct].[vwordertotals]', tracedColumn: 'NetAmount',
    nodes: [
      ['[ct].[vwordertotals]', V, ['NetAmount']],
      ['[ct].[stgorders]', T, ['RawAmount']],
      ['[ct].[vworderfeed]', V, ['NetAmount']],
      ['[ct].[orders]', T, ['OrderAmount']],
    ],
    edges: [
      ['[ct].[stgorders]', '[ct].[vwordertotals]'],
      ['[ct].[vworderfeed]', '[ct].[stgorders]'],
      ['[ct].[orders]', '[ct].[vworderfeed]'],
    ],
    reachRequired: ['[ct].[stgorders]', '[ct].[vworderfeed]', '[ct].[orders]'],
    flow: {
      '[ct].[vwordertotals]': [{ out_col: 'NetAmount', upstream_columns: [{ node: '[ct].[stgorders]', col: 'RawAmount' }] }],
      '[ct].[vworderfeed]': [],
    },
    verdictOverride: { '[ct].[vworderfeed]': 'passthrough' },
    expectActiveColumns: { '[ct].[vworderfeed]': ['RawAmount'] },
    measuredLost: [],
  },
  {
    // `[audit].[loadlog]` is a write sink outside the user's schema filter: the BFS seed keeps it
    // reachable, the route path refuses it, so no hop ever dispositions it and it must drop from
    // the render — the first case in this suite that exercises the drop stage at all.
    id: 'C16 — an out-of-filter write sink no hop dispositioned is dropped, in both modes',
    origin: '[ct].[vwsalesfeed]', tracedColumn: 'Amount',
    direction: 'downstream',
    filterSchemas: ['ct'],
    nodes: [
      ['[ct].[vwsalesfeed]', V, ['Amount']],
      ['[ct].[sploadfact]', P, ['Amount']],
      ['[ct].[factsales]', T, ['Amount']],
      ['[audit].[loadlog]', T, ['LoadedAt']],
    ],
    edges: [
      ['[ct].[vwsalesfeed]', '[ct].[sploadfact]'],
      ['[ct].[sploadfact]', '[ct].[factsales]'],
      ['[ct].[sploadfact]', '[audit].[loadlog]'],
    ],
    reachRequired: ['[ct].[sploadfact]', '[ct].[factsales]'],
    flow: {
      '[ct].[vwsalesfeed]': [{ out_col: 'Amount', upstream_columns: [] }],
      '[ct].[sploadfact]': [{
        out_col: 'Amount',
        upstream_columns: [{ node: '[ct].[vwsalesfeed]', col: 'Amount' }],
        writes_to: { node: '[ct].[factsales]', col: 'Amount' },
      }],
    },
    expectRenderDropped: ['[audit].[loadlog]'],
    measuredLost: [],
  },
];

function buildWorld(testCase: RetentionCase): { model: DatabaseModel; graph: ReturnType<typeof makeGraph> } {
  const nodes: LineageNode[] = testCase.nodes.map(([id, type, columns]) => {
    const [, schema, name] = /^\[([^\]]+)\]\.\[([^\]]+)\]$/.exec(id) ?? ['', 'ct', id];
    return makeNode({
      id, schema, name, type,
      columns: columns.map(columnName => ({ name: columnName, type: 'int', nullable: 'NULL', extra: '' })),
    });
  });
  const edgePairs = testCase.edges.map(([source, target]) => [source, target] as [string, string]);
  const schemaNames = Array.from(new Set(nodes.map(n => n.schema)));
  return { model: makeModel(nodes, edgePairs, schemaNames), graph: makeGraph(nodes, edgePairs) };
}

/** Engine config for a case: the user's schema filter when it has one, nothing otherwise. */
function engineConfig(testCase: RetentionCase): { activeFilter?: ReturnType<typeof makeActiveFilter> } {
  return testCase.filterSchemas
    ? { activeFilter: makeActiveFilter({ schemas: [...testCase.filterSchemas] }) }
    : {};
}

/**
 * Asserts the render dropped exactly the ids the case names, and returns them for the survivor scan.
 *
 * @param testCase - The case under test; an unset `expectRenderDropped` means "the render drops nothing".
 * @param recorded - `renderDroppedNodeIds` from the snapshot taken after `getResult`.
 * @returns The recorded drops, as a set.
 */
function expectedDrops(testCase: RetentionCase, recorded: readonly string[] | undefined): Set<string> {
  const dropped = [...(recorded ?? [])].sort();
  expect(dropped, `${testCase.id}: the render drops exactly what the case names`)
    .toEqual([...(testCase.expectRenderDropped ?? [])].sort());
  return new Set(dropped);
}

/**
 * The per-neighbor `route_requests[].columns` decision {@link driveCt} states for `id`, read off
 * the SAME `column_flow` entries the hop submits: a neighbor the flow names as an `upstream_columns`
 * supplier or a `writes_to` target carries exactly the real column name(s) named for it there — the
 * model's own evidence, not the session's generic target-column spelling, which a non-bodied
 * carrier's real DDL column name may not share (`C15`). A neighbor the flow names nowhere carries
 * `'none'`: a row-shaping dependency the walk still must visit, but not as a column question.
 *
 * @param columnFlow - The column_flow this hop is about to submit.
 * @param id - The routed neighbor id.
 * @returns The route's `columns` decision for `id`.
 */
function routeColumnsFor(columnFlow: FlowEntry[] | undefined, id: string): string[] | 'none' {
  const named = new Set<string>();
  for (const entry of columnFlow ?? []) {
    for (const ref of entry.upstream_columns) {
      if (ref.node === id) named.add(ref.col);
    }
    if (entry.writes_to?.node === id) named.add(entry.out_col);
  }
  return named.size > 0 ? [...named] : 'none';
}

/**
 * Drives a CT walk, submitting the case's scripted column_flow at each dispatched focus and routing
 * every neighbour the engine requires an account for.
 *
 * @remarks
 * The required set is the same one `<required_neighbors>` renders to the model, in CT exactly as in
 * BB ({@link driveBb} reads it identically). A neighbour carrying none of the traced columns appears
 * on that list and is routed here, because whether it filters the row set is answerable only by
 * reading it.
 */
function driveCt(engine: NavigationEngine, testCase: RetentionCase): void {
  for (let hop = 0; hop < 25; hop++) {
    const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
    if (ctx.done || !ctx.focus_node) return;
    const focusId = ctx.focus_node.id;
    const columnFlow = testCase.flow[focusId];
    expect(columnFlow, `${testCase.id}: the case scripts a column_flow for dispatched focus ${focusId}`).toBeDefined();
    const expected = testCase.expectActiveColumns?.[focusId];
    if (expected) {
      expect(
        [...(engine.columnAspect?.active_columns ?? [])].sort().join(','),
        `${testCase.id}: ${focusId} is dispatched with the columns it declares, not an empty set`,
      ).toBe([...expected].sort().join(','));
    }
    const outcome = engine.submitFindings({
      focus_node_id: focusId,
      sections: [{ angle: 'business' as const, text: `capture for ${focusId}` }],
      summary: `${focusId} carries ${testCase.tracedColumn}`,
      verdict: testCase.verdictOverride?.[focusId] ?? 'analyze',
      column_flow: columnFlow,
      route_requests: engine.requiredNeighborIds(focusId).map(id => ({
        nodeId: id,
        question: `What does ${id} decide about the rows ${focusId} admits?`,
        columns: routeColumnsFor(columnFlow, id),
      })),
    });
    expect('error' in outcome, `${testCase.id}: the scripted hop at ${focusId} is accepted, not rejected`).toBe(false);
  }
  throw new Error(`${testCase.id}: CT walk did not terminate within 25 hops`);
}

/**
 * Drives a BB walk, routing every neighbour the engine requires an account for.
 *
 * @remarks
 * Reads the same required set {@link driveCt} reads, so the two arms differ only in the column
 * aspect. The hop context carries no required list of its own; a driver that inferred one from
 * `edge_direction === 'upstream'` matched the required set only on an upstream walk and left a
 * downstream case's write targets unrouted, which the sink trim then dropped — a driver defect
 * that read as a mode divergence.
 */
function driveBb(engine: NavigationEngine, testCase: RetentionCase): void {
  for (let hop = 0; hop < 25; hop++) {
    const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
    if (ctx.done || !ctx.focus_node) return;
    const focusId = ctx.focus_node.id;
    const outcome = engine.submitFindings({
      focus_node_id: focusId,
      sections: [{ angle: 'business' as const, text: `capture for ${focusId}` }],
      summary: `${focusId}`,
      verdict: 'analyze',
      route_requests: engine.requiredNeighborIds(focusId).map(id => ({
        nodeId: id,
        question: `What does ${id} decide about the rows ${focusId} admits?`,
      })),
    });
    expect('error' in outcome, `${testCase.id}: the BB hop at ${focusId} is accepted, not rejected`).toBe(false);
  }
  throw new Error(`${testCase.id}: BB walk did not terminate within 25 hops`);
}

describe('CT retention — every required dependency survives into the result', () => {
  for (const testCase of CASES) {
    it(`${testCase.id}`, () => {
      const { model, graph } = buildWorld(testCase);
      const engine = new NavigationEngine(model, graph, () => {}, engineConfig(testCase));
      const init = engine.init({
        origin: testCase.origin,
        question: `trace ${testCase.tracedColumn}`,
        direction: testCase.direction ?? 'upstream',
        analysisMode: 'ct',
        targetColumns: [testCase.tracedColumn],
        depthIntent: { kind: 'explicit', levels: 6 },
      });
      expect('ok' in init, `${testCase.id}: CT init succeeds`).toBe(true);

      driveCt(engine, testCase);
      const result = engine.getResult();
      const rendered = new Set(result.fullNodes.map(n => n.id));

      // Reported as one set, so a failure names the whole loss for this case rather than its first node.
      const lost = testCase.reachRequired.filter(required => !rendered.has(required));
      expect(lost, `${testCase.id}: required dependencies missing from the answer (measured: ${testCase.measuredLost.join(', ') || 'none'})`).toEqual([]);

      // The render's own disposition, named by the case rather than inferred from the gap below.
      // A case that expects none holds the drop stage to the same standard it held before this
      // record existed: any drop at all is the failure.
      const state = engine.toJSON();
      const dropped = expectedDrops(testCase, state.renderDroppedNodeIds);

      // Causation: a node admitted to scope and never pruned must reach the result, unless the
      // render dropped it above and said so. A failure here is a silent engine drop, not a model
      // decision.
      const survivors = bfsReachable(graph, testCase.origin, new Set(state.removedSet), undefined, new Set(state.scopeNodeIds));
      survivors.add(testCase.origin);
      for (const id of survivors) {
        if (dropped.has(id)) continue;
        expect(rendered.has(id), `${testCase.id}: ${id} is in scope and unpruned, so it is not silently dropped`).toBe(true);
      }
      expect([...dropped].filter(id => rendered.has(id)), `${testCase.id}: a recorded drop is absent from the render`).toEqual([]);

      // The conservation backstop in `getResult` logs this delta and asserts it is empty. Under the
      // old CT scope rebuild that assertion was false by construction; guard it so a reintroduction
      // fails here instead of printing a debug line.
      const droppedSlots = result.detail_slots.filter(slot => !rendered.has(slot.nodeId));
      expect(droppedSlots.map(slot => slot.nodeId), `${testCase.id}: no analyzed detail slot is dropped from the render`).toEqual([]);
    });
  }
});

describe('BB control — the same topology loses nothing today', () => {
  for (const testCase of CASES) {
    it(`${testCase.id}`, () => {
      const { model, graph } = buildWorld(testCase);
      const engine = new NavigationEngine(model, graph, () => {}, engineConfig(testCase));
      const init = engine.init({
        origin: testCase.origin,
        question: 'what feeds this object and what restricts its rows?',
        direction: testCase.direction ?? 'upstream',
        depthIntent: { kind: 'explicit', levels: 6 },
      });
      expect('ok' in init, `${testCase.id}: BB init succeeds`).toBe(true);

      driveBb(engine, testCase);
      const rendered = new Set(engine.getResult().fullNodes.map(n => n.id));
      const lost = testCase.reachRequired.filter(required => !rendered.has(required));
      expect(lost, `${testCase.id}: BB keeps every required dependency`).toEqual([]);
      // Render-drop parity: the trim reads no column state, so the set it drops is a property of
      // the topology and the walk, not of the mode. CT asserting the same list against the same
      // case is the whole claim — a drop one mode makes and the other does not is a divergence.
      expectedDrops(testCase, engine.toJSON().renderDroppedNodeIds);
    });
  }
});

/**
 * A CT walk whose column spine ends at a bodied node.
 *
 * `[ct].[vwfilterarm]` declares none of the traced columns, so the engine dispatches it with an
 * empty active-column set (`getHopContext`: "empty sets still dispatch to the AI"). Its own
 * upstream `[ct].[vwfilterdeep]` is in scope, unvisited and unqueued — a required neighbour by
 * `requiredNeighborIds`, and the only way to reach it is a route request from that focus.
 */
const ZERO_COLUMN_NODES: ReadonlyArray<readonly [string, ObjectType, string[]]> = [
  ['[ct].[vwzerotop]', V, ['Amount']],
  ['[ct].[valuesrc]', T, ['Amount']],
  ['[ct].[vwfilterarm]', V, ['Flag']],
  ['[ct].[vwfilterdeep]', V, ['Flag']],
];
const ZERO_COLUMN_EDGES: ReadonlyArray<readonly [string, string]> = [
  ['[ct].[valuesrc]', '[ct].[vwzerotop]'],
  ['[ct].[vwfilterarm]', '[ct].[vwzerotop]'],
  ['[ct].[vwfilterdeep]', '[ct].[vwfilterarm]'],
];
const ZERO_COLUMN_ORIGIN = '[ct].[vwzerotop]';
const ZERO_COLUMN_FOCUS = '[ct].[vwfilterarm]';
const ZERO_COLUMN_REQUIRED = '[ct].[vwfilterdeep]';

const ZERO_COLUMN_CASE: RetentionCase = {
  id: 'zero-active-column focus',
  origin: ZERO_COLUMN_ORIGIN,
  tracedColumn: 'Amount',
  nodes: ZERO_COLUMN_NODES,
  edges: ZERO_COLUMN_EDGES,
  reachRequired: [],
  flow: {},
  measuredLost: [],
};

interface RouteOutcome { nodeId: string; accepted: boolean; deferred?: boolean; reason?: string }
interface SubmitOk { ok?: true; error?: string; route_outcomes?: RouteOutcome[] }

/** Starts a CT trace of `Amount` at the origin and commits the one value-carrying hop. */
function startZeroColumnTrace(
  excludeNodeIds?: string[],
  log: (level: string, msg: string) => void = () => {},
): NavigationEngine {
  const { model, graph } = buildWorld(ZERO_COLUMN_CASE);
  const engine = new NavigationEngine(model, graph, log, {});
  const init = engine.init({
    origin: ZERO_COLUMN_ORIGIN,
    question: 'trace Amount',
    direction: 'upstream',
    analysisMode: 'ct',
    targetColumns: ['Amount'],
    depthIntent: { kind: 'explicit', levels: 6 },
    ...(excludeNodeIds ? { excludeNodeIds } : {}),
  });
  expect('ok' in init, 'CT init succeeds').toBe(true);

  const originCtx = engine.getHopContext() as { focus_node?: { id: string } };
  expect(originCtx.focus_node?.id).toBe(ZERO_COLUMN_ORIGIN);
  const committed = engine.submitFindings({
    focus_node_id: ZERO_COLUMN_ORIGIN,
    sections: [{ angle: 'business' as const, text: 'origin carries Amount' }],
    summary: 'origin',
    verdict: 'analyze',
    column_flow: [{ out_col: 'Amount', upstream_columns: [{ node: '[ct].[valuesrc]', col: 'Amount' }] }],
    // The BFS seed at `init` carries the session's full target set onto every directional
    // neighbour by default; this explicit route is the router's OWN column opinion for
    // `ZERO_COLUMN_FOCUS`, stated because the focus declares none of the traced columns (only
    // `Flag`) — the same "row-shaping, not value-carrying" decision the whole-object hop below
    // makes about it. Restates the fact the origin's own `column_flow` already carries (naming
    // only `valuesrc` as `Amount`'s supplier), rather than leaving the seed's default to stand.
    route_requests: [{ nodeId: ZERO_COLUMN_FOCUS, question: 'is this a filter arm or a value supplier?', columns: 'none' }],
  }) as SubmitOk;
  expect(committed.error, 'the origin hop commits').toBeUndefined();
  return engine;
}

/** Dispatches the next hop and asserts it is the focus whose column spine has ended. */
function dispatchZeroColumnFocus(engine: NavigationEngine): void {
  const ctx = engine.getHopContext() as {
    focus_node?: { id: string };
    working_memory?: { column_aspect?: { active_columns?: string[] } };
  };
  expect(ctx.focus_node?.id, 'the seeded filter arm is dispatched').toBe(ZERO_COLUMN_FOCUS);
  expect(
    ctx.working_memory?.column_aspect?.active_columns,
    'the filter arm declares none of the traced columns, so the hop carries no active column',
  ).toEqual([]);
}

describe('CT zero-active-column focus — routes are evaluated, not blanket-refused', () => {
  it('accepts a route request for a required neighbour when the column spine has ended', () => {
    const engine = startZeroColumnTrace();
    dispatchZeroColumnFocus(engine);
    const required = engine.requiredNeighborIds(ZERO_COLUMN_FOCUS);
    expect(required, 'the engine requires an account for the deeper arm').toContain(ZERO_COLUMN_REQUIRED);

    const outcome = engine.submitFindings({
      focus_node_id: ZERO_COLUMN_FOCUS,
      sections: [{ angle: 'business' as const, text: 'filter arm restricts the set' }],
      summary: 'filter arm',
      verdict: 'analyze',
      column_flow: [],
      route_requests: [{ nodeId: ZERO_COLUMN_REQUIRED, question: 'what restricts the rows this arm admits?', columns: 'none' }],
    }) as SubmitOk;

    expect(outcome.error, 'the zero-column hop commits').toBeUndefined();
    const routed = (outcome.route_outcomes ?? []).find(o => o.nodeId === ZERO_COLUMN_REQUIRED);
    expect(routed, 'the route request is reported').toBeDefined();
    expect(routed?.accepted, `route to ${ZERO_COLUMN_REQUIRED} is accepted, not refused`).toBe(true);

    const next = engine.getHopContext() as { focus_node?: { id: string } };
    expect(next.focus_node?.id, 'the routed neighbour is dispatched for analysis').toBe(ZERO_COLUMN_REQUIRED);
  });

  it('never demands and refuses the same neighbour in one hop', () => {
    const engine = startZeroColumnTrace();
    dispatchZeroColumnFocus(engine);
    const required = engine.requiredNeighborIds(ZERO_COLUMN_FOCUS);
    expect(required.length, 'the invariant is exercised against a non-empty required set').toBeGreaterThan(0);

    const outcome = engine.submitFindings({
      focus_node_id: ZERO_COLUMN_FOCUS,
      sections: [{ angle: 'business' as const, text: 'filter arm restricts the set' }],
      summary: 'filter arm',
      verdict: 'analyze',
      column_flow: [],
      route_requests: required.map(id => ({ nodeId: id, question: `what does ${id} contribute to the admitted rows?`, columns: 'none' })),
    }) as SubmitOk;

    expect(outcome.error, 'the hop commits').toBeUndefined();
    // The deadlock the D1 guard would otherwise hit: a neighbour the engine demands an account for
    // and then refuses to let the model reach. The refused set must never intersect the required set.
    const refused = (outcome.route_outcomes ?? []).filter(o => !o.accepted && !o.deferred).map(o => o.nodeId);
    expect(refused.filter(id => required.includes(id)), 'no required neighbour is refused').toEqual([]);
  });

  it('gives the routed neighbour a detail slot instead of rendering it bare', () => {
    const engine = startZeroColumnTrace();
    dispatchZeroColumnFocus(engine);
    engine.submitFindings({
      focus_node_id: ZERO_COLUMN_FOCUS,
      sections: [{ angle: 'business' as const, text: 'filter arm restricts the set' }],
      summary: 'filter arm',
      verdict: 'analyze',
      column_flow: [],
      route_requests: [{ nodeId: ZERO_COLUMN_REQUIRED, question: 'what restricts the rows this arm admits?', columns: 'none' }],
    });
    const deepCtx = engine.getHopContext() as { focus_node?: { id: string } };
    expect(deepCtx.focus_node?.id).toBe(ZERO_COLUMN_REQUIRED);
    engine.submitFindings({
      focus_node_id: ZERO_COLUMN_REQUIRED,
      sections: [{ angle: 'business' as const, text: 'deep arm is the suppression source' }],
      summary: 'deep arm',
      verdict: 'analyze',
      column_flow: [],
    });

    const result = engine.getResult();
    expect(
      result.detail_slots.map(slot => slot.nodeId),
      'the routed neighbour is analyzed, not left as a bare kept node',
    ).toContain(ZERO_COLUMN_REQUIRED);
  });

  it('records an unresolved route as a notice and still accepts the valid one in the same hop', () => {
    const engine = startZeroColumnTrace();
    dispatchZeroColumnFocus(engine);
    const outcome = engine.submitFindings({
      focus_node_id: ZERO_COLUMN_FOCUS,
      sections: [{ angle: 'business' as const, text: 'filter arm restricts the set' }],
      summary: 'filter arm',
      verdict: 'analyze',
      column_flow: [],
      route_requests: [
        { nodeId: '[ct].[nosuchobject]', question: 'does this exist?', columns: 'none' },
        { nodeId: ZERO_COLUMN_REQUIRED, question: 'what restricts the rows this arm admits?', columns: 'none' },
      ],
    }) as SubmitOk;

    expect(outcome.error, 'a malformed route target never fails the hop').toBeUndefined();
    const outcomes = outcome.route_outcomes ?? [];
    expect(outcomes.find(o => o.nodeId === '[ct].[nosuchobject]')?.reason).toBe('unresolved');
    expect(outcomes.find(o => o.nodeId === ZERO_COLUMN_REQUIRED)?.accepted).toBe(true);
  });

  it('still refuses an excluded route target, and never counts it as required', () => {
    const engine = startZeroColumnTrace([ZERO_COLUMN_REQUIRED]);
    dispatchZeroColumnFocus(engine);
    const required = engine.requiredNeighborIds(ZERO_COLUMN_FOCUS);
    expect(required, 'a user-excluded node is never demanded').not.toContain(ZERO_COLUMN_REQUIRED);

    const outcome = engine.submitFindings({
      focus_node_id: ZERO_COLUMN_FOCUS,
      sections: [{ angle: 'business' as const, text: 'filter arm restricts the set' }],
      summary: 'filter arm',
      verdict: 'analyze',
      column_flow: [],
      route_requests: [{ nodeId: ZERO_COLUMN_REQUIRED, question: 'what restricts the rows this arm admits?', columns: 'none' }],
    }) as SubmitOk;

    expect(outcome.error, 'the hop commits').toBeUndefined();
    expect((outcome.route_outcomes ?? []).find(o => o.nodeId === ZERO_COLUMN_REQUIRED)?.reason).toBe('excluded');
  });

  it('keeps the routed neighbour in the answer when the walk is abandoned before it is analyzed', () => {
    const engine = startZeroColumnTrace();
    dispatchZeroColumnFocus(engine);
    engine.submitFindings({
      focus_node_id: ZERO_COLUMN_FOCUS,
      sections: [{ angle: 'business' as const, text: 'filter arm restricts the set' }],
      summary: 'filter arm',
      verdict: 'analyze',
      column_flow: [],
      route_requests: [{ nodeId: ZERO_COLUMN_REQUIRED, question: 'what restricts the rows this arm admits?', columns: 'none' }],
    });

    // No further hop is driven — the routed neighbour is queued and unvisited.
    const rendered = new Set(engine.getResult().fullNodes.map(n => n.id));
    expect(rendered.has(ZERO_COLUMN_REQUIRED), 'an abandoned walk keeps its queued, unpruned nodes').toBe(true);
  });
});

describe('CT origin seeding — the origin\'s neighbours are always seeded', () => {
  it('seeds the origin\'s directional neighbours on a CT init', () => {
    const engine = startZeroColumnTrace();
    // `[ct].[vwfilterarm]` is on no column_flow edge and was never routed, so the only path onto
    // the agenda is the init-time seed. Deleting the seed makes this dispatch the completion.
    dispatchZeroColumnFocus(engine);
  });

  it('rejects a CT start whose columns resolve empty, so seeding never sees an empty column set', () => {
    const { model, graph } = buildWorld(ZERO_COLUMN_CASE);
    const engine = new NavigationEngine(model, graph, () => {}, {});
    const init = engine.init({
      origin: ZERO_COLUMN_ORIGIN,
      question: 'trace a column the origin does not declare',
      direction: 'upstream',
      analysisMode: 'ct',
      targetColumns: ['NotAColumnOfTheOrigin'],
      depthIntent: { kind: 'explicit', levels: 6 },
    }) as { error?: string };
    expect(init.error, 'CT never starts with an empty resolved column set').toBe('unknown_columns');
  });
});

/**
 * Scope admits a node; only a hop dispositions one. `dimcalendar`, `errorlog`, `auditlog` and
 * `splogaudit` carry no traced value and no disposition — reachability artifacts, not answer
 * evidence. `customermaster` carries no traced value either but is contracted through at hop 1,
 * so it is dispositioned and kept.
 */
const SINK_NODES: ReadonlyArray<readonly [string, ObjectType, string[]]> = [
  ['[ct].[vwdiscountcalc]', V, ['Discount']],
  ['[ct].[salesstaging]', T, ['OrderAmount']],
  ['[ct].[customermaster]', T, ['CustomerTier']],
  ['[ct].[sploadsalesstaging]', P, ['OrderAmount']],
  ['[ct].[dimcalendar]', T, ['DateKey']],
  ['[ct].[spbuildsalesreport]', P, ['Discount']],
  ['[ct].[factsalesreport]', T, ['Discount']],
  ['[ct].[errorlog]', T, ['Message']],
  ['[ct].[splogaudit]', P, ['Note']],
  ['[ct].[auditlog]', T, ['Note']],
];
const SINK_EDGES: ReadonlyArray<readonly [string, string]> = [
  ['[ct].[salesstaging]', '[ct].[vwdiscountcalc]'],
  ['[ct].[customermaster]', '[ct].[vwdiscountcalc]'],
  ['[ct].[sploadsalesstaging]', '[ct].[salesstaging]'],
  ['[ct].[dimcalendar]', '[ct].[sploadsalesstaging]'],
  ['[ct].[vwdiscountcalc]', '[ct].[spbuildsalesreport]'],
  ['[ct].[spbuildsalesreport]', '[ct].[factsalesreport]'],
  ['[ct].[spbuildsalesreport]', '[ct].[errorlog]'],
  ['[ct].[spbuildsalesreport]', '[ct].[splogaudit]'],
  ['[ct].[splogaudit]', '[ct].[auditlog]'],
];

const SINK_CASE: RetentionCase = {
  id: 'undispositioned sinks',
  origin: '[ct].[vwdiscountcalc]',
  tracedColumn: 'Discount',
  nodes: SINK_NODES,
  edges: SINK_EDGES,
  reachRequired: [],
  flow: {
    // `Discount` comes from SalesStaging.OrderAmount; CustomerMaster supplies only the join key,
    // so the model never names it.
    '[ct].[vwdiscountcalc]': [{ out_col: 'Discount', upstream_columns: [{ node: '[ct].[salesstaging]', col: 'OrderAmount' }] }],
    '[ct].[spbuildsalesreport]': [{
      out_col: 'Discount',
      upstream_columns: [{ node: '[ct].[vwdiscountcalc]', col: 'Discount' }],
      writes_to: { node: '[ct].[factsalesreport]', col: 'Discount' },
    }],
    // The convergence routes every in-scope directional neighbour, but the bipartite agenda rule
    // dispatches only bodied focuses: the table neighbours (`salesstaging`, `customermaster`,
    // `dimcalendar`, `factsalesreport`, `errorlog`) are routed and contracted to their bodied
    // writers, so they appear in no flow here — the walk never focuses them.
    // The loader joins DimCalendar to bound the load window and writes ErrorLog on failure; neither
    // carries a value into the traced column, so its flow names neither.
    '[ct].[sploadsalesstaging]': [],
    // Reached only in the routed variant below: routing to `auditlog` contracts through it to its
    // bodied writer, exactly as a BB walk would. The writer carries `Note`, none of the traced
    // `Discount`, so its flow is empty — the node is analysed for what it does, not skipped.
    '[ct].[splogaudit]': [],
  },
  measuredLost: [],
};

/** Runs the walk: every bodied node the column spine reaches, and nothing else. */
function driveSinkWalk(routeFromConsumer?: string): {
  engine: NavigationEngine;
  model: DatabaseModel;
  graph: ReturnType<typeof makeGraph>;
} {
  const { model, graph } = buildWorld(SINK_CASE);
  const engine = new NavigationEngine(model, graph, () => {}, {});
  const init = engine.init({
    origin: SINK_CASE.origin,
    question: 'trace Discount to its sources and its consumers',
    direction: 'bidirectional',
    analysisMode: 'ct',
    targetColumns: ['Discount'],
    depthIntent: { kind: 'explicit', levels: 3 },
  });
  expect('ok' in init, 'CT init succeeds').toBe(true);

  for (let hop = 0; hop < 25; hop++) {
    const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
    if (ctx.done || !ctx.focus_node) return { engine, model, graph };
    const focusId = ctx.focus_node.id;
    // Logging sinks are off the answer path for a column question, so the walk prunes them
    // at their own focus once dispatched — the same decision BB makes, now in CT too. In the routed
    // variant splogaudit is the contracted-through focus of the consumer route, so it is analysed
    // from its scripted flow instead of pruned.
    const pruneAtFocus = new Set(
      routeFromConsumer ? ['[ct].[errorlog]'] : ['[ct].[errorlog]', '[ct].[splogaudit]'],
    );
    if (pruneAtFocus.has(focusId)) {
      engine.submitFindings({
        focus_node_id: focusId,
        sections: [],
        summary: `${focusId} is a logging sink`,
        verdict: 'prune',
      });
      continue;
    }
    const columnFlow = SINK_CASE.flow[focusId];
    expect(columnFlow, `the case scripts a column_flow for dispatched focus ${focusId}`).toBeDefined();
    // CT is held to the same neighbour accounting as BB: every id the guard demands an account
    // for is routed, plus the consumer the variant under test adds on top.
    // `columns` is stated explicitly as the session's own traced target set, the same value the
    // engine's omitted-field fallback used to supply.
    const routes = engine.requiredNeighborIds(focusId).map(id => ({
      nodeId: id,
      question: `What does ${id} decide about the rows ${focusId} admits?`,
      columns: engine.columnAspect?.target_columns,
    }));
    if (routeFromConsumer && focusId === '[ct].[spbuildsalesreport]') {
      routes.push({ nodeId: routeFromConsumer, question: 'what does this record?', columns: engine.columnAspect?.target_columns });
    }
    engine.submitFindings({
      focus_node_id: focusId,
      sections: [{ angle: 'business' as const, text: `capture for ${focusId}` }],
      summary: `${focusId}`,
      verdict: 'analyze',
      column_flow: columnFlow,
      route_requests: routes,
    });
  }
  throw new Error('sink walk did not terminate within 25 hops');
}

/** The render the sink walk produces. */
function sinkWalkResult(routeFromConsumer?: string): SmResult {
  return driveSinkWalk(routeFromConsumer).engine.getResult();
}

describe('CT render bound — scope admits, only a hop dispositions', () => {
  it('drops the logging sinks the walk can disposition — routed-and-deferred sinks stay, as in BB', () => {
    const rendered = new Set(sinkWalkResult().fullNodes.map(n => n.id));
    // The guard demands every in-scope directional neighbour, so `errorlog` is routed and stays;
    // `splogaudit` is dispatched and verdict-pruned; `auditlog` is dispositioned by no hop.
    expect(rendered.has('[ct].[splogaudit]'), 'the dispatched logging proc is pruned at its focus and dropped').toBe(false);
    expect(rendered.has('[ct].[auditlog]'), 'the sink no hop dispositioned is trim-dropped with its pruned supplier').toBe(false);
    expect(rendered.has('[ct].[errorlog]'), 'a guard-demanded sink is routed and renders, the same graph BB produces here').toBe(true);
  });

  it('keeps an undispositioned supplier — a filter join and a sibling-column feed are one shape here', () => {
    const rendered = new Set(sinkWalkResult().fullNodes.map(n => n.id));
    // `dimcalendar` bounds the load window and supplies no `Discount`; `[ct].[prices]` in C8 has the
    // identical structure and is required. The engine cannot separate them, so both stay in the
    // render and the synthesis prompt keeps an undispositioned node out of the section links.
    expect(rendered.has('[ct].[dimcalendar]'), 'a supplier of a rendered node survives the sink trim').toBe(true);
  });

  it('keeps the dispositioned join-key leaf and every column-flow participant', () => {
    const result = sinkWalkResult();
    const rendered = new Set(result.fullNodes.map(n => n.id));
    // `customermaster` supplies no value to `Discount` and appears in no column edge; the origin
    // hop contracted through it, and that disposition is what keeps it in the answer.
    const required = [
      '[ct].[vwdiscountcalc]', '[ct].[salesstaging]', '[ct].[customermaster]',
      '[ct].[sploadsalesstaging]', '[ct].[spbuildsalesreport]', '[ct].[factsalesreport]',
    ];
    expect(required.filter(id => !rendered.has(id)), 'no dispositioned node is dropped').toEqual([]);
    expect(
      result.detail_slots.filter(slot => !rendered.has(slot.nodeId)).map(slot => slot.nodeId),
      'no analyzed detail slot is dropped from the render',
    ).toEqual([]);
  });

  it('keeps an undispositioned node that carries the only path to a kept one', () => {
    // `auditlog` is routed, so it is dispositioned and stays; `splogaudit` is still undispositioned
    // but it is the only path to `auditlog` — a passthrough, not a leaf.
    const rendered = new Set(sinkWalkResult('[ct].[auditlog]').fullNodes.map(n => n.id));
    expect(rendered.has('[ct].[auditlog]'), 'the routed sink is dispositioned and kept').toBe(true);
    expect(rendered.has('[ct].[splogaudit]'), 'the only path to a kept node survives the leaf trim').toBe(true);
  });
});

describe('CT snapshot provenance — the render records the drop it made', () => {
  it('names the dropped ids in the snapshot and carries them through a round trip', () => {
    const { engine, model, graph } = driveSinkWalk();
    const rendered = new Set(engine.getResult().fullNodes.map(n => n.id));
    const snapshot = engine.toJSON();
    const dropped = snapshot.renderDroppedNodeIds ?? [];

    // `auditlog` is the one sink the render itself drops (no hop dispositioned it). `splogaudit`
    // left via an explicit verdict prune (removedSet, not a render drop); `errorlog` was
    // guard-demanded, routed, and deferred as a contracted lead, so it renders.
    expect([...dropped].sort(), 'the snapshot names every sink the render dropped').toEqual(
      ['[ct].[auditlog]'],
    );
    expect(dropped.filter(id => rendered.has(id)), 'a recorded drop is absent from the render').toEqual([]);
    expect(dropped.filter(id => !snapshot.scopeNodeIds.includes(id)), 'a dropped node was in scope').toEqual([]);

    const restored = NavigationEngine.fromJSON(JSON.parse(JSON.stringify(snapshot)), model, graph, () => {});
    expect(restored.toJSON().renderDroppedNodeIds, 'the record survives the checkpoint boundary').toEqual(dropped);
  });

  it('omits the field when the render dropped nothing', () => {
    // C2: every dependency supplies the traced value, so the trim has no candidate.
    const testCase = CASES.find(c => c.id.startsWith('C2'))!;
    const { model, graph } = buildWorld(testCase);
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({
      origin: testCase.origin,
      question: `trace ${testCase.tracedColumn}`,
      direction: 'upstream',
      analysisMode: 'ct',
      targetColumns: [testCase.tracedColumn],
      depthIntent: { kind: 'explicit', levels: 6 },
    });
    driveCt(engine, testCase);
    engine.getResult();

    expect(engine.toJSON().renderDroppedNodeIds, 'no drop, no record').toBeUndefined();
  });
});

/**
 * A hop verdict of `passthrough` keeps a node in the render on its own, even with no column edge
 * pointing anywhere but a log writer. C12 is the counter-case: the same verdict at a focus the
 * tracer did place on a column edge also keeps the node — a column edge is additive, not the
 * retention reason.
 */
const PASSTHROUGH_NODES: ReadonlyArray<readonly [string, ObjectType, string[]]> = [
  ['[ct].[vwsrc]', V, ['Amount']],
  ['[ct].[src]', T, ['Amount']],
  ['[ct].[sparchive]', P, ['Amount']],
  ['[ct].[splog]', P, ['Msg']],
];
const PASSTHROUGH_EDGES: ReadonlyArray<readonly [string, string]> = [
  ['[ct].[src]', '[ct].[vwsrc]'],
  ['[ct].[vwsrc]', '[ct].[sparchive]'],
  ['[ct].[sparchive]', '[ct].[splog]'],
];
const ARCHIVE = '[ct].[sparchive]';
const ARCHIVE_LOG = '[ct].[splog]';

const PASSTHROUGH_CASE: RetentionCase = {
  id: 'submitted passthrough',
  origin: '[ct].[vwsrc]',
  tracedColumn: 'Amount',
  nodes: PASSTHROUGH_NODES,
  edges: PASSTHROUGH_EDGES,
  reachRequired: [],
  flow: { '[ct].[vwsrc]': [{ out_col: 'Amount', upstream_columns: [{ node: '[ct].[src]', col: 'Amount' }] }] },
  measuredLost: [],
};

/** Runs the walk, submitting `archiveFlow` under a passthrough verdict at the archive proc. */
function drivePassthroughWalk(archiveFlow: FlowEntry[]): SmResult {
  const { model, graph } = buildWorld(PASSTHROUGH_CASE);
  const engine = new NavigationEngine(model, graph, () => {}, {});
  const init = engine.init({
    origin: PASSTHROUGH_CASE.origin,
    question: 'trace Amount to its sources and its consumers',
    direction: 'bidirectional',
    analysisMode: 'ct',
    targetColumns: ['Amount'],
    depthIntent: { kind: 'explicit', levels: 3 },
  });
  expect('ok' in init, 'CT init succeeds').toBe(true);

  for (let hop = 0; hop < 25; hop++) {
    const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
    if (ctx.done || !ctx.focus_node) return engine.getResult();
    const focusId = ctx.focus_node.id;
    if (focusId === ARCHIVE_LOG) {
      // Convergence: the log writer is guard-demanded, so the walk routes it; once dispatched it
      // is off the traced column's answer path and prunes at its own focus, as in BB.
      const prune = engine.submitFindings({
        focus_node_id: focusId,
        sections: [],
        summary: `${focusId} is a log writer`,
        verdict: 'prune',
      }) as SubmitOk;
      expect(prune.error, `the hop at ${focusId} commits`).toBeUndefined();
      continue;
    }
    const isArchive = focusId === ARCHIVE;
    const outcome = engine.submitFindings({
      focus_node_id: focusId,
      sections: [{ angle: 'business' as const, text: `capture for ${focusId}` }],
      summary: `${focusId}`,
      verdict: isArchive ? 'passthrough' as const : 'analyze' as const,
      column_flow: isArchive ? archiveFlow : (PASSTHROUGH_CASE.flow[focusId] ?? []),
      route_requests: engine.requiredNeighborIds(focusId).map(id => ({
        nodeId: id,
        question: `What does ${id} decide about the rows ${focusId} admits?`,
        columns: engine.columnAspect?.target_columns,
      })),
    }) as SubmitOk;
    expect(outcome.error, `the hop at ${focusId} commits`).toBeUndefined();
  }
  throw new Error('passthrough walk did not terminate within 25 hops');
}

describe('CT render bound — a submitted passthrough is a hop verdict, same as BB', () => {
  it('C11 — keeps a passthrough proc whose only render edge is its log writer', () => {
    // The flow names a node outside the fixture, so the tracer places the focus on no column edge.
    // Column edges never bound the result: a hop verdict is BB retention, and CT does not drop a
    // visited write-sink BB would keep.
    const result = drivePassthroughWalk([
      { out_col: 'Amount', upstream_columns: [{ node: '[ct].[notinthismodel]', col: 'Amount' }] },
    ]);
    const rendered = new Set(result.fullNodes.map(n => n.id));

    expect(
      result.node_states.find(state => state.nodeId === ARCHIVE)?.reason,
      'the premise: the archive proc was dispatched and returned a passthrough',
    ).toBe('submitted_passthrough');
    expect(rendered.has(ARCHIVE), 'a submitted passthrough stays; CT does not subtract from BB retention').toBe(true);
    expect(result.detail_slots.some(slot => slot.nodeId === ARCHIVE), 'its captured slot survives into the envelope').toBe(true);
    expect(rendered.has(ARCHIVE_LOG), 'the log writer pruned at its own focus is gone').toBe(false);
    expect(rendered.has('[ct].[src]'), 'the value supplier stays').toBe(true);
  });

  it('C12 — keeps a passthrough focus the tracer placed on a column edge', () => {
    const result = drivePassthroughWalk([
      { out_col: 'Amount', upstream_columns: [{ node: '[ct].[vwsrc]', col: 'Amount' }] },
    ]);
    const rendered = new Set(result.fullNodes.map(n => n.id));

    expect(
      result.node_states.find(state => state.nodeId === ARCHIVE)?.reason,
      'the same verdict as C11',
    ).toBe('submitted_passthrough');
    expect(rendered.has(ARCHIVE), 'a hop verdict keeps the node; a column edge is additive, not the retention reason').toBe(true);
  });
});

/**
 * A carrier proc is a column edge's `hop_node`, never its endpoint (`from_node`/`to_node` carry
 * the columns it moved between). A passthrough proc whose `writes_to` target sits outside the
 * depth border has no render-internal outgoing edge, so the endpoint exemption cannot reach it —
 * the sink trim must not delete it on that basis alone.
 */
const CARRIER_NODES: ReadonlyArray<readonly [string, ObjectType, string[]]> = [
  ['[ct].[vwcarriersrc]', V, ['Amount']],
  ['[ct].[carrierbase]', T, ['Amount']],
  ['[ct].[spcarrier]', P, ['Amount']],
  ['[ct].[carrierreport]', T, ['Amount']],
];
const CARRIER_EDGES: ReadonlyArray<readonly [string, string]> = [
  ['[ct].[carrierbase]', '[ct].[vwcarriersrc]'],
  ['[ct].[vwcarriersrc]', '[ct].[spcarrier]'],
  ['[ct].[spcarrier]', '[ct].[carrierreport]'],
];
const CARRIER = '[ct].[spcarrier]';

const CARRIER_CASE: RetentionCase = {
  id: 'column-edge carrier',
  origin: '[ct].[vwcarriersrc]',
  tracedColumn: 'Amount',
  nodes: CARRIER_NODES,
  edges: CARRIER_EDGES,
  reachRequired: [],
  flow: { '[ct].[vwcarriersrc]': [{ out_col: 'Amount', upstream_columns: [{ node: '[ct].[carrierbase]', col: 'Amount' }] }] },
  measuredLost: [],
};

/**
 * Runs the walk at a one-level border, so the carrier proc's write target stays outside the render
 * and the proc is left with no render-internal outgoing edge.
 *
 * @remarks
 * Returns the committed chain beside the result because the two are different surfaces: the render
 * disposition reads every edge the tracer committed, while `SmResult.columnAspect` is the delivered
 * projection, which withholds an edge whose endpoint the render dispositioned away. A premise about
 * what the hop recorded is read from the first; the render verdict itself is read from the second.
 */
function driveCarrierWalk(carrierFlow: FlowEntry[]): { result: SmResult; committed: readonly ColumnEdge[] } {
  const { model, graph } = buildWorld(CARRIER_CASE);
  const engine = new NavigationEngine(model, graph, () => {}, {});
  const init = engine.init({
    origin: CARRIER_CASE.origin,
    question: 'trace Amount to its sources and list its direct consumers',
    direction: 'bidirectional',
    analysisMode: 'ct',
    targetColumns: ['Amount'],
    depthIntent: { kind: 'explicit', levels: 1 },
  });
  expect('ok' in init, 'CT init succeeds').toBe(true);

  for (let hop = 0; hop < 25; hop++) {
    const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
    if (ctx.done || !ctx.focus_node) return { result: engine.getResult(), committed: engine.toJSON().columnAspect?.edges ?? [] };
    const focusId = ctx.focus_node.id;
    const isCarrier = focusId === CARRIER;
    const outcome = engine.submitFindings({
      focus_node_id: focusId,
      sections: [{ angle: 'business' as const, text: `capture for ${focusId}` }],
      summary: `${focusId}`,
      verdict: isCarrier ? 'passthrough' as const : 'analyze' as const,
      column_flow: isCarrier ? carrierFlow : (CARRIER_CASE.flow[focusId] ?? []),
    }) as SubmitOk;
    expect(outcome.error, `the hop at ${focusId} commits`).toBeUndefined();
  }
  throw new Error('carrier walk did not terminate within 25 hops');
}

describe('CT render bound — the hop_node of a column edge carried the column', () => {
  it('C13 — keeps a passthrough write sink the tracer recorded as a column edge hop_node', () => {
    const { result, committed } = driveCarrierWalk([{
      out_col: 'Amount',
      upstream_columns: [{ node: '[ct].[vwcarriersrc]', col: 'Amount' }],
      writes_to: { node: '[ct].[carrierreport]', col: 'Amount' },
    }]);
    const rendered = new Set(result.fullNodes.map(n => n.id));

    expect(
      result.node_states.find(state => state.nodeId === CARRIER)?.reason,
      'the premise: the consumer proc was dispatched and returned a passthrough',
    ).toBe('submitted_passthrough');
    expect(
      committed.some(edge => edge.hop_node === CARRIER
        && edge.from_node !== CARRIER && edge.to_node !== CARRIER),
      'the premise: the proc is the edge hop_node and neither endpoint',
    ).toBe(true);
    expect(rendered.has(CARRIER), 'the carrier of the traced column into its consumer stays').toBe(true);
  });

  it('C14 — keeps the same passthrough write sink when it carried no column', () => {
    // Same shape as C11: the flow names a node outside the fixture, so the tracer records no edge.
    // Column edges never bound the result — a hop verdict is BB retention in both modes.
    const { result, committed } = driveCarrierWalk([
      { out_col: 'Amount', upstream_columns: [{ node: '[ct].[notinthismodel]', col: 'Amount' }] },
    ]);
    const rendered = new Set(result.fullNodes.map(n => n.id));

    expect(
      committed.some(edge => edge.hop_node === CARRIER),
      'the premise: the hop recorded no column edge at all',
    ).toBe(false);
    expect(rendered.has(CARRIER), 'a hop verdict keeps the node; missing column carriage does not subtract it').toBe(true);
    expect(rendered.has('[ct].[carrierbase]'), 'the value supplier stays either way').toBe(true);
  });
});

/**
 * CT is BB plus columns, stated as the invariant it actually is: the same question answered in
 * either mode renders the SAME graph. CT adds column-level detail on the nodes it tracks; it never
 * adds a node BB would not show and never withholds one BB would.
 *
 * The two describes above assert a floor per arm — neither loses a required dependency — which is
 * strictly weaker: both arms could clear their floor and still disagree on everything outside
 * `reachRequired`. This asserts the equality itself, so a mode-dependent render trim fails here.
 */
describe('CT and BB render the same graph for the same question', () => {
  for (const testCase of CASES) {
    it(`${testCase.id}`, () => {
      const ctWorld = buildWorld(testCase);
      const ct = new NavigationEngine(ctWorld.model, ctWorld.graph, () => {}, {});
      expect('ok' in ct.init({
        origin: testCase.origin,
        question: `trace ${testCase.tracedColumn}`,
        direction: 'upstream',
        analysisMode: 'ct',
        targetColumns: [testCase.tracedColumn],
        depthIntent: { kind: 'explicit', levels: 6 },
      }), `${testCase.id}: CT init succeeds`).toBe(true);
      driveCt(ct, testCase);
      const ctSet = new Set(ct.getResult().fullNodes.map(node => node.id));

      // The same question, the same topology, the only difference being the mode.
      const bbWorld = buildWorld(testCase);
      const bb = new NavigationEngine(bbWorld.model, bbWorld.graph, () => {}, {});
      expect('ok' in bb.init({
        origin: testCase.origin,
        question: `trace ${testCase.tracedColumn}`,
        direction: 'upstream',
        depthIntent: { kind: 'explicit', levels: 6 },
      }), `${testCase.id}: BB init succeeds`).toBe(true);
      driveBb(bb, testCase);
      const bbSet = new Set(bb.getResult().fullNodes.map(node => node.id));

      // Reported as two sets so a failure names the whole divergence, and says which way it went:
      // a node only BB shows is a CT loss, a node only CT shows is a CT invention.
      expect(
        {
          missingFromCt: [...bbSet].filter(id => !ctSet.has(id)).sort(),
          addedByCt: [...ctSet].filter(id => !bbSet.has(id)).sort(),
        },
        `${testCase.id}: CT and BB must render the same graph — CT adds columns, never nodes`,
      ).toEqual({ missingFromCt: [], addedByCt: [] });
    });
  }
});

/**
 * Neighbour accounting is one behaviour shared by BB and CT, so CT renders the same
 * `<required_neighbors>` checklist and the same engine guard enforces it.
 *
 * Before the convergence, `CtStrategy.runRequiredNodesGuard` was an empty method body and
 * `buildActiveHopInstruction` bracketed the block out of CT: the checklist was neither shown nor
 * enforced, and an unaccounted required neighbour passed silently.
 */
function ctPromptSession(): AiSession {
  return {
    outputTemplates: EMPTY_AI_TEMPLATES,
    classification: 'business',
    memory: { slotCount: 0, getShortTermMemory: () => [], getRecentRejections: () => [] },
  } as unknown as AiSession;
}

describe('CT neighbour accounting — the same checklist BB gets, shown and enforced', () => {
  it('renders <required_neighbors> in CT for a focus that has required neighbours', () => {
    const engine = startZeroColumnTrace();
    dispatchZeroColumnFocus(engine);
    const required = engine.requiredNeighborIds(ZERO_COLUMN_FOCUS);
    expect(required, 'the engine requires an account for the deeper arm').toContain(ZERO_COLUMN_REQUIRED);

    const hop = buildActiveHopInstruction(ctPromptSession(), engine, ZERO_COLUMN_FOCUS);
    expect(hop.message.includes('<required_neighbors>'), 'CT ships the required-neighbour block').toBe(true);
    expect(hop.message.includes(ZERO_COLUMN_REQUIRED), 'the block names the id the guard will demand').toBe(true);
    expect(hop.memorySections, 'the block is reported in the hop provenance').toContain('required_neighbors');
    // Single source: what the model is shown is exactly what the engine enforces.
    for (const id of required) {
      expect(hop.message.includes(id), `${id} is demanded by the guard, so it must be rendered`).toBe(true);
    }
  });

  it('presents a neighbour carrying none of the traced columns, and routes it', () => {
    const engine = startZeroColumnTrace();
    dispatchZeroColumnFocus(engine);
    const ctx = engine.peekHopContext() as { neighbors?: Array<{ id: string }> } | null;
    expect(
      (ctx?.neighbors ?? []).map(n => n.id),
      'the zero-column neighbour is presented in CT exactly as BB presents it',
    ).toContain(ZERO_COLUMN_REQUIRED);
    const block = /<required_neighbors>([\s\S]*?)<\/required_neighbors>/
      .exec(buildActiveHopInstruction(ctPromptSession(), engine, ZERO_COLUMN_FOCUS).message)?.[1] ?? '';
    expect(
      block.includes(ZERO_COLUMN_REQUIRED),
      'and it is inside the rendered checklist, not withheld for carrying no traced column',
    ).toBe(true);

    const outcome = engine.submitFindings({
      focus_node_id: ZERO_COLUMN_FOCUS,
      sections: [{ angle: 'business' as const, text: 'filter arm restricts the set' }],
      summary: 'filter arm',
      verdict: 'analyze',
      column_flow: [],
      route_requests: [{ nodeId: ZERO_COLUMN_REQUIRED, question: 'what restricts the rows this arm admits?', columns: ['Amount'] }],
    }) as SubmitOk;
    expect(outcome.error, 'routing the zero-column neighbour commits the hop').toBeUndefined();
  });

  it('fills a required neighbour a CT hop left unaccounted, and never drops it', () => {
    const logLines: string[] = [];
    const engine = startZeroColumnTrace(undefined, (_level, msg) => { logLines.push(msg); });
    dispatchZeroColumnFocus(engine);
    const outcome = engine.submitFindings({
      focus_node_id: ZERO_COLUMN_FOCUS,
      sections: [{ angle: 'business' as const, text: 'filter arm restricts the set' }],
      summary: 'filter arm',
      verdict: 'analyze',
      column_flow: [],
    }) as SubmitOk & { detail?: Array<{ id: string }> };

    // Silently accepted before the convergence: CT's strategy implemented the guard as an empty
    // method body, so the neighbour was neither demanded nor kept. The demand now runs in both
    // modes; what satisfies it is an engine-written route, not a refusal — the model is never
    // charged a generation for an id the engine printed in that same hop's checklist.
    expect(outcome.error, 'the unaccounted required neighbour no longer costs the hop').toBeUndefined();
    expect(
      engine.toJSON().scopeNodeIds,
      'the neighbour is in scope after the fill, exactly as a model-authored route would leave it',
    ).toContain(ZERO_COLUMN_REQUIRED);
    expect(
      logLines.some(l => l.includes('[AutoFill]') && l.includes(ZERO_COLUMN_REQUIRED)),
      'CT logs the fill, so an engine-authored route stays auditable',
    ).toBe(true);
  });
});

/**
 * The `a → b → (c, d, e)`, `c → f` shape: `b`'s neighbours `c`, `d`, `e` are all in the
 * origin-rooted scope, so the guard demands an account for each at hop `b` in both modes. `c` is
 * routed (contracts through to `f`), `e` is routed carrying the traced Amount, and `d` — in
 * scope, guard-demanded, and off the answer path — is pruned at the hop. The contract: the prune
 * executes, the hop commits, `d` never renders — identically in both modes.
 */
const HOP_PRUNE_NODES: ReadonlyArray<readonly [string, ObjectType, string[]]> = [
  ['[ct].[vwa]', V, ['Amount']],
  ['[ct].[vwb]', P, ['Amount']],
  ['[ct].[tblc]', T, ['Amount']],
  ['[ct].[tbld]', T, ['Message']],
  ['[ct].[vwe]', P, ['Amount']],
  ['[ct].[vwf]', P, ['Amount']],
];
const HOP_PRUNE_EDGES: Array<[string, string]> = [
  ['[ct].[vwa]', '[ct].[vwb]'],
  ['[ct].[vwb]', '[ct].[tblc]'],
  ['[ct].[vwb]', '[ct].[tbld]'],
  ['[ct].[vwb]', '[ct].[vwe]'],
  ['[ct].[tblc]', '[ct].[vwf]'],
];

function driveHopPruneWalk(mode: 'bb' | 'ct'): SmResult {
  const nodes = HOP_PRUNE_NODES.map(([id, type, columns]) => makeNode({
    id, schema: 'ct', name: id.replace(/^\[ct\]\.\[|\]$/g, ''), type,
    columns: columns.map(c => ({ name: c, type: 'int', nullable: 'NULL', extra: '' })),
  }));
  const engine = new NavigationEngine(makeModel(nodes, HOP_PRUNE_EDGES, ['ct']), makeGraph(nodes, HOP_PRUNE_EDGES), () => {}, {});
  const init = engine.init({
    origin: '[ct].[vwa]',
    question: 'trace Amount',
    direction: 'bidirectional',
    ...(mode === 'ct' ? { analysisMode: mode, targetColumns: ['Amount'] } : {}),
    depthIntent: { kind: 'explicit', levels: 4 },
  });
  expect('ok' in init, `${mode}: init succeeds`).toBe(true);
  for (let hop = 0; hop < 25; hop++) {
    const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
    if (ctx.done || !ctx.focus_node) return engine.getResult();
    const focusId = ctx.focus_node.id;
    // CT states `columns` explicitly as the session's traced target set, the same value the
    // engine's omitted-field fallback used to supply; BB's route shape carries no `columns` field.
    const routes = engine.requiredNeighborIds(focusId)
      .filter(id => id !== '[ct].[tbld]')
      .map(id => ({
        nodeId: id, question: `What does ${id} decide about the rows ${focusId} admits?`,
        ...(mode === 'ct' ? { columns: ['Amount'] } : {}),
      }));
    const prunes = engine.requiredNeighborIds(focusId).includes('[ct].[tbld]') ? ['[ct].[tbld]'] : [];
    // The identical per-hop decision in both modes: every guard-demanded neighbour is routed
    // except `d`, which is pruned at the hop that owns it. CT adds only the column account —
    // the origin produces the traced Amount, `b` carries it from `a`, `e` from `b`, `f` from `c`.
    // Same verdicts, same routes, same prune in both modes.
    const amountChainUpstream: Record<string, { node: string; col: string }[]> = {
      '[ct].[vwa]': [],
      '[ct].[vwb]': [{ node: '[ct].[vwa]', col: 'Amount' }],
      '[ct].[vwe]': [{ node: '[ct].[vwb]', col: 'Amount' }],
      '[ct].[vwf]': [{ node: '[ct].[tblc]', col: 'Amount' }],
    };
    const outcome = engine.submitFindings({
      focus_node_id: focusId,
      sections: [{ angle: 'business' as const, text: `capture for ${focusId}` }],
      summary: `${focusId}`,
      verdict: 'analyze',
      ...(mode === 'ct' && amountChainUpstream[focusId] !== undefined
        ? { column_flow: [{ out_col: 'Amount', upstream_columns: amountChainUpstream[focusId] }] }
        : {}),
      route_requests: routes,
      prune_neighbors: prunes,
    }) as SubmitOk & { error?: string };
    expect(outcome.error, `${mode}: the hop at ${focusId} commits`).toBeUndefined();
  }
  throw new Error(`${mode}: walk did not terminate within 25 hops`);
}

describe('hop-level prune — the in-scope neighbour decision, both modes', () => {
  // One body, one expectation set: the same per-hop decision renders the same graph in either mode,
  // so a mode-dependent render trim fails here rather than passing a mode-specific arm.
  for (const mode of ['ct', 'bb'] as const) {
    it(`executes in ${mode.toUpperCase()}: d is pruned at hop b, the hop commits, d never renders`, () => {
      const result = driveHopPruneWalk(mode);
      const rendered = new Set(result.fullNodes.map(n => n.id));
      expect(rendered.has('[ct].[tbld]'), `${mode}: the hop-level prune removed d from the answer`).toBe(false);
      expect(rendered.has('[ct].[tblc]'), `${mode}: the routed table neighbour stays`).toBe(true);
      expect(rendered.has('[ct].[vwe]'), `${mode}: the routed proc neighbour stays`).toBe(true);
      expect(rendered.has('[ct].[vwf]'), `${mode}: the contraction through the routed table reaches f`).toBe(true);
    });
  }

  it('a queued neighbour is not pulled by prune_neighbors — it keeps its own focus verdict', () => {
    const nodes = HOP_PRUNE_NODES.map(([id, type, columns]) => makeNode({
      id, schema: 'ct', name: id.replace(/^\[ct\]\.\[|\]$/g, ''), type,
      columns: columns.map(c => ({ name: c, type: 'int', nullable: 'NULL', extra: '' })),
    }));
    const engine = new NavigationEngine(makeModel(nodes, HOP_PRUNE_EDGES, ['ct']), makeGraph(nodes, HOP_PRUNE_EDGES), () => {}, {});
    engine.init({
      origin: '[ct].[vwa]', question: 'trace Amount', direction: 'bidirectional',
      analysisMode: 'ct', targetColumns: ['Amount'], depthIntent: { kind: 'explicit', levels: 4 },
    });
    engine.getHopContext();
    // Queue e from the origin hop, then try to prune it at hop b: queued work keeps its hop.
    const origin = engine.submitFindings({
      focus_node_id: '[ct].[vwa]',
      sections: [{ angle: 'business' as const, text: 'a' }],
      summary: 'a', verdict: 'analyze',
      column_flow: [{ out_col: 'Amount', upstream_columns: [{ node: '[ct].[tblc]', col: 'Amount' }] }],
      route_requests: [
        { nodeId: '[ct].[vwb]', question: 'b transforms the amount', columns: ['Amount'] },
        { nodeId: '[ct].[vwe]', question: 'e filters the rows', columns: ['Amount'] },
      ],
    }) as SubmitOk;
    expect(origin.error, 'the origin hop commits').toBeUndefined();
    engine.getHopContext();
    const atB = engine.submitFindings({
      focus_node_id: engine.currentFocus!,
      sections: [{ angle: 'business' as const, text: 'b' }],
      summary: 'b', verdict: 'passthrough',
      column_flow: [{ out_col: 'Amount', upstream_columns: [{ node: '[ct].[tblc]', col: 'Amount' }] }],
      route_requests: [
        { nodeId: '[ct].[tblc]', question: 'c supplies the amount', columns: ['Amount'] },
        { nodeId: '[ct].[tbld]', question: 'd is a logging sink', columns: ['Amount'] },
      ],
      prune_neighbors: ['[ct].[vwe]'],
    }) as SubmitOk;
    expect(atB.error, 'the prune of a queued neighbour is a notice, not a rejection').toBeUndefined();
    const snapshot = engine.toJSON() as { agenda: Array<{ nodeId: string }> };
    expect(snapshot.agenda.some(e => e.nodeId === '[ct].[vwe]'), 'the queued hop stays queued').toBe(true);
  });

  it('don\'t-orphan still guards the hop-level prune — a neighbour carrying the only path to committed work refuses', () => {
    const nodes: LineageNode[] = [
      makeNode({ id: '[ct].[vwa2]', schema: 'ct', name: 'vwa2', type: 'view', columns: [{ name: 'Amount', type: 'int', nullable: 'NULL', extra: '' }] }),
      makeNode({ id: '[ct].[vwb2]', schema: 'ct', name: 'vwb2', type: 'procedure', columns: [] }),
      makeNode({ id: '[ct].[tbld2]', schema: 'ct', name: 'tbld2', type: 'table', columns: [{ name: 'Message', type: 'int', nullable: 'NULL', extra: '' }] }),
      makeNode({ id: '[ct].[vwx2]', schema: 'ct', name: 'vwx2', type: 'view', columns: [] }),
    ];
    const edges: Array<[string, string]> = [
      ['[ct].[vwa2]', '[ct].[vwb2]'],
      ['[ct].[vwb2]', '[ct].[tbld2]'],
      ['[ct].[tbld2]', '[ct].[vwx2]'],
    ];
    const engine = new NavigationEngine(makeModel(nodes, edges, ['ct']), makeGraph(nodes, edges), () => {}, {});
    engine.init({
      origin: '[ct].[vwa2]', question: 'trace Amount', direction: 'bidirectional',
      analysisMode: 'ct', targetColumns: ['Amount'], depthIntent: { kind: 'explicit', levels: 4 },
    });
    engine.getHopContext();
    const origin = engine.submitFindings({
      focus_node_id: '[ct].[vwa2]',
      sections: [{ angle: 'business' as const, text: 'a' }],
      summary: 'a', verdict: 'analyze',
      column_flow: [{ out_col: 'Amount', upstream_columns: [] }],
      route_requests: [
        { nodeId: '[ct].[vwb2]', question: 'b transforms the amount', columns: ['Amount'] },
        { nodeId: '[ct].[vwx2]', question: 'x is committed beyond the pruned table', columns: ['Amount'] },
      ],
    }) as SubmitOk;
    expect(origin.error, 'the origin hop commits and queues x through the d-table path').toBeUndefined();
    engine.getHopContext();
    // x is queued (committed) and its ONLY path runs through tbld2: pruning tbld2 at hop b must
    // refuse with the orphan reason, not execute and not strand x.
    const atB = engine.submitFindings({
      focus_node_id: '[ct].[vwb2]',
      sections: [{ angle: 'business' as const, text: 'b' }],
      summary: 'b', verdict: 'analyze',
      column_flow: [],
      route_requests: [],
      prune_neighbors: ['[ct].[tbld2]'],
    }) as { error?: string; hint?: string; detail?: Array<{ id: string; reason?: string }> };
    expect(atB.error, 'the orphaning prune rejects').toBeTruthy();
    expect(
      JSON.stringify(atB),
      'the rejection attributes the prune as an orphan of committed work',
    ).toMatch(/orphan/i);
  });

  it('cycles: a visited cycle member is never re-demanded — the walk terminates', () => {
    // Walk bounding (visited/queued/removed sets, BFS scope) is shared engine machinery — the CT
    // column overlay plays no part in cycle termination, so the pin runs in BB where the submit
    // carries no column accounting to keep the cycle proof pure.
    const nodes: LineageNode[] = [
      makeNode({ id: '[ct].[cyc1]', schema: 'ct', name: 'cyc1', type: 'view', columns: [] }),
      makeNode({ id: '[ct].[cyc2]', schema: 'ct', name: 'cyc2', type: 'procedure', columns: [] }),
      makeNode({ id: '[ct].[cyc3]', schema: 'ct', name: 'cyc3', type: 'procedure', columns: [] }),
    ];
    const edges: Array<[string, string]> = [
      ['[ct].[cyc1]', '[ct].[cyc2]'],
      ['[ct].[cyc2]', '[ct].[cyc3]'],
      ['[ct].[cyc3]', '[ct].[cyc1]'],
    ];
    const engine = new NavigationEngine(makeModel(nodes, edges, ['ct']), makeGraph(nodes, edges), () => {}, {});
    engine.init({
      origin: '[ct].[cyc1]', question: 'trace the cycle', direction: 'bidirectional',
      depthIntent: { kind: 'explicit', levels: 4 },
    });
    let hops = 0;
    for (; hops < 25; hops++) {
      const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
      if (ctx.done || !ctx.focus_node) break;
      const focusId = ctx.focus_node.id;
      const outcome = engine.submitFindings({
        focus_node_id: focusId,
        sections: [{ angle: 'business' as const, text: 'capture' }],
        summary: focusId, verdict: 'analyze',
        route_requests: engine.requiredNeighborIds(focusId).map(id => ({ nodeId: id, question: 'q' })),
      }) as SubmitOk;
      expect(outcome.error, `the hop at ${focusId} in the cycle commits`).toBeUndefined();
    }
    expect(hops, 'the cycle terminates within the visited/queued bounds').toBeLessThan(25);
  });
});

describe('beyond-scope contraction — a route to a node outside the origin\'s directed closure is refused identically in both modes', () => {
  /**
   * `g` is reached only by crossing sideways into one of `b`'s other inputs, never by a directed
   * walk from `a` on either side, so it sits outside the upstream ∪ downstream closure
   * `computeBfsScope` seeds. Topology: `a` (origin) → `b`; `g` (table) feeds `b`; `w` (procedure)
   * writes `g`. The seed scope from `a` is {a, b} — `g` and `w` are beyond it. A route to `g` is
   * refused `out_of_direction`, mode-neutral, in both modes.
   */
  for (const mode of ['bb', 'ct'] as const) {
    it(`${mode.toUpperCase()}: routing the off-closure table at hop b is refused out_of_direction, so its writer never contracts in`, () => {
      const nodes: LineageNode[] = [
        makeNode({ id: '[ct].[vwa3]', schema: 'ct', name: 'vwa3', type: 'view', columns: [{ name: 'Amount', type: 'int', nullable: 'NULL', extra: '' }] }),
        makeNode({ id: '[ct].[vwb3]', schema: 'ct', name: 'vwb3', type: 'procedure', columns: [{ name: 'Amount', type: 'int', nullable: 'NULL', extra: '' }] }),
        makeNode({ id: '[ct].[tblg3]', schema: 'ct', name: 'tblg3', type: 'table', columns: [{ name: 'Amount', type: 'int', nullable: 'NULL', extra: '' }] }),
        makeNode({ id: '[ct].[vwg3]', schema: 'ct', name: 'vwg3', type: 'procedure', columns: [{ name: 'Amount', type: 'int', nullable: 'NULL', extra: '' }] }),
      ];
      const edges: Array<[string, string]> = [
        ['[ct].[vwa3]', '[ct].[vwb3]'],
        ['[ct].[tblg3]', '[ct].[vwb3]'],
        ['[ct].[vwg3]', '[ct].[tblg3]'],
      ];
      const engine = new NavigationEngine(makeModel(nodes, edges, ['ct']), makeGraph(nodes, edges), () => {}, {});
      engine.init({
        origin: '[ct].[vwa3]', question: 'trace Amount', direction: 'bidirectional',
        ...(mode === 'ct' ? { analysisMode: mode, targetColumns: ['Amount'] } : {}),
        depthIntent: { kind: 'explicit', levels: 4 },
      });
      const flows: Record<string, FlowEntry[]> = {
        '[ct].[vwa3]': [{ out_col: 'Amount', upstream_columns: [] }],
        '[ct].[vwb3]': [{ out_col: 'Amount', upstream_columns: [{ node: '[ct].[tblg3]', col: 'Amount' }] }],
        '[ct].[vwg3]': [{ out_col: 'Amount', upstream_columns: [] }],
      };
      for (let hop = 0; hop < 25; hop++) {
        const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
        if (ctx.done || !ctx.focus_node) break;
        const focusId = ctx.focus_node.id;
        // CT states `columns` explicitly as the session's traced target set, the same value the
        // engine's omitted-field fallback used to supply; BB's route shape carries no `columns` field.
        const routes = engine.requiredNeighborIds(focusId).map(id => ({
          nodeId: id, question: `q ${id}`, ...(mode === 'ct' ? { columns: ['Amount'] } : {}),
        }));
        // `g` is beyond the seed scope, so the guard does not demand it; the model requests it
        // anyway, and `admitsRoute` refuses it as off-closure.
        if (focusId === '[ct].[vwb3]' && !routes.some(r => r.nodeId === '[ct].[tblg3]')) {
          routes.push({ nodeId: '[ct].[tblg3]', question: 'g supplies the amount b joins', ...(mode === 'ct' ? { columns: ['Amount'] } : {}) });
        }
        const outcome = engine.submitFindings({
          focus_node_id: focusId,
          sections: [{ angle: 'business' as const, text: `capture ${focusId}` }],
          summary: focusId,
          verdict: 'analyze',
          ...(mode === 'ct' && flows[focusId] ? { column_flow: flows[focusId] } : {}),
          route_requests: routes,
        }) as SubmitOk;
        expect(outcome.error, `${mode}: the hop at ${focusId} commits`).toBeUndefined();
        if (focusId === '[ct].[vwb3]') {
          const gOutcome = (outcome.route_outcomes ?? []).find(o => o.nodeId === '[ct].[tblg3]');
          expect(gOutcome?.accepted === false && gOutcome?.reason === 'out_of_direction', `${mode}: g is refused out_of_direction, not silently admitted (got ${JSON.stringify(gOutcome)})`).toBe(true);
        }
      }
      const result = engine.getResult();
      const rendered = new Set(result.fullNodes.map(n => n.id));
      expect(rendered.has('[ct].[tblg3]'), `${mode}: the refused table does not render`).toBe(false);
      expect(rendered.has('[ct].[vwg3]'), `${mode}: with no contraction through g, its writer never renders either`).toBe(false);
    });
  }
});

describe('route-border demand — the guard demands only what the router admits (G3)', () => {
  /**
   * The completeness guard may demand an account only for neighbours the router would actually
   * admit. A schema the user filtered on keeps out-of-allowlist neighbours in the seed scope, but
   * the route border refuses them — deferred as a lead, never accepted — so `requiredNeighborIds`
   * must filter on the router's own admission test (`admitsRoute`); the depth axis is the case
   * below.
   */
  const borderNodes: LineageNode[] = [
    makeNode({ id: '[ai].[vwbase]', schema: 'ai', name: 'vwbase', type: 'view', columns: [{ name: 'Amount', type: 'int', nullable: 'NULL', extra: '' }] }),
    makeNode({ id: '[ct].[tblforeign]', schema: 'ct', name: 'tblforeign', type: 'table', columns: [{ name: 'Amount', type: 'int', nullable: 'NULL', extra: '' }] }),
    makeNode({ id: '[ai].[tblhome]', schema: 'ai', name: 'tblhome', type: 'table', columns: [{ name: 'Amount', type: 'int', nullable: 'NULL', extra: '' }] }),
  ];
  const borderEdges: Array<[string, string]> = [
    ['[ct].[tblforeign]', '[ai].[vwbase]'],
    ['[ai].[tblhome]', '[ai].[vwbase]'],
  ];

  it('an out-of-allowlist neighbour in scope is never demanded — routing it defers, the hop commits', () => {
    const engine = new NavigationEngine(
      makeModel(borderNodes, borderEdges, ['ai', 'ct']),
      makeGraph(borderNodes, borderEdges),
      () => {},
      { activeFilter: makeActiveFilter({ schemas: ['ai'] }) },
    );
    engine.init({
      origin: '[ai].[vwbase]', question: 'trace Amount', direction: 'bidirectional',
      depthIntent: { kind: 'explicit', levels: 3 },
    });
    engine.getHopContext();
    const required = new Set(engine.requiredNeighborIds('[ai].[vwbase]'));
    // In the seed scope (the seed deliberately keeps out-of-allowlist nodes so they become gate
    // classes) but past the route border — so never demanded.
    expect(engine.scopeSize > 1, 'the invariant is exercised against a grown scope').toBe(true);
    expect(required.has('[ct].[tblforeign]'), 'the out-of-allowlist neighbour is not guard-demanded').toBe(false);
    // The in-allowlist neighbour keeps its demand — the filter is the border, not the scope.
    expect(required.has('[ai].[tblhome]'), 'the in-allowlist neighbour stays demanded').toBe(true);

    // The model still routes the foreign neighbour (it is the honest answer path); the router
    // defers it as a `schema:` lead and the hop commits — no unmeetable demand anywhere.
    const outcome = engine.submitFindings({
      focus_node_id: '[ai].[vwbase]',
      sections: [{ angle: 'business' as const, text: 'base' }],
      summary: 'base', verdict: 'analyze',
      route_requests: [
        { nodeId: '[ct].[tblforeign]', question: 'the foreign source of the amount' },
        { nodeId: '[ai].[tblhome]', question: 'the home source of the amount' },
      ],
    }) as SubmitOk & { route_outcomes?: Array<{ nodeId: string; accepted: boolean; deferred?: boolean; reason?: string }> };
    expect(outcome.error, 'the hop commits — the deferred lead satisfies nothing the guard demands').toBeUndefined();
    const foreign = (outcome.route_outcomes ?? []).find(o => o.nodeId === '[ct].[tblforeign]');
    expect(foreign?.accepted, 'the out-of-allowlist route is not admitted').toBe(false);
    expect(foreign?.deferred, 'it is deferred as a schema lead the user can approve').toBe(true);
  });

  /**
   * The same invariant on the depth axis: a neighbour inside the schema allowlist but past a
   * level count the user stated clears the border and is still deferred as a lead, never
   * accepted — `admitsRoute` states both the border and depth axes, and both sites read it. The
   * state is reached through a resumed checkpoint because a snapshot persists the depth ceiling
   * independently, so a restored engine is where a scope member past the ceiling is observable.
   */
  const depthNodes: LineageNode[] = [
    makeNode({ id: '[ai].[vwlvl0]', schema: 'ai', name: 'vwlvl0', type: 'view', columns: [{ name: 'Amount', type: 'int', nullable: 'NULL', extra: '' }] }),
    makeNode({ id: '[ai].[vwlvl1]', schema: 'ai', name: 'vwlvl1', type: 'view', columns: [{ name: 'Amount', type: 'int', nullable: 'NULL', extra: '' }] }),
    makeNode({ id: '[ai].[vwlvl2]', schema: 'ai', name: 'vwlvl2', type: 'view', columns: [{ name: 'Amount', type: 'int', nullable: 'NULL', extra: '' }] }),
  ];
  const depthEdges: Array<[string, string]> = [
    ['[ai].[vwlvl0]', '[ai].[vwlvl1]'],
    ['[ai].[vwlvl1]', '[ai].[vwlvl2]'],
  ];

  it('an in-allowlist neighbour past a strict depth ceiling is never demanded — routing it defers, the hop commits', () => {
    const model = makeModel(depthNodes, depthEdges, ['ai']);
    const graph = makeGraph(depthNodes, depthEdges);
    const engine = new NavigationEngine(model, graph, () => {}, { activeFilter: makeActiveFilter({ schemas: ['ai'] }) });
    engine.init({
      origin: '[ai].[vwlvl0]', question: 'trace Amount', direction: 'downstream',
      depthIntent: { kind: 'explicit', levels: 1 },
    });
    engine.getHopContext();
    engine.submitFindings({
      focus_node_id: '[ai].[vwlvl0]',
      sections: [{ angle: 'business' as const, text: 'level 0' }],
      summary: 'level 0', verdict: 'analyze',
      route_requests: [{ nodeId: '[ai].[vwlvl1]', question: 'the level-1 consumer' }],
    });

    const snapshot = JSON.parse(JSON.stringify(engine.toJSON())) as { scopeNodeIds: string[]; scopeSize: number };
    snapshot.scopeNodeIds.push('[ai].[vwlvl2]');
    snapshot.scopeSize = snapshot.scopeNodeIds.length;
    const resumed = NavigationEngine.fromJSON(snapshot, model, graph, () => {});

    const ctx = resumed.getHopContext() as { focus_node?: { id: string } };
    expect(ctx.focus_node?.id, 'the resumed hop focuses the level-1 node').toBe('[ai].[vwlvl1]');
    // In scope, in the allowlist, and past the stated single level — so never demanded.
    const required = new Set(resumed.requiredNeighborIds('[ai].[vwlvl1]'));
    expect(required.has('[ai].[vwlvl2]'), 'the past-the-ceiling neighbour is not guard-demanded').toBe(false);

    // The model still routes it (it is the honest answer path); the router defers it as a depth
    // lead and the hop commits — no unmeetable demand on this axis either.
    const outcome = resumed.submitFindings({
      focus_node_id: '[ai].[vwlvl1]',
      sections: [{ angle: 'business' as const, text: 'level 1' }],
      summary: 'level 1', verdict: 'analyze',
      route_requests: [{ nodeId: '[ai].[vwlvl2]', question: 'the level-2 consumer' }],
    }) as SubmitOk;
    expect(outcome.error, 'the hop commits — the deferred lead satisfies nothing the guard demands').toBeUndefined();
    const deep = (outcome.route_outcomes ?? []).find(o => o.nodeId === '[ai].[vwlvl2]');
    expect(deep?.accepted, 'the past-the-ceiling route is not admitted').toBe(false);
    expect(deep?.deferred, 'it is deferred as a depth lead the user can take up').toBe(true);
    expect(deep?.reason, 'the deferral names the depth axis, not the schema axis').toBe('depth');
  });
});

/**
 * The per-neighbour fork: at `A → C, D` the router carries traced columns through `C` and sends
 * `D` on as a plain whole-object neighbour because it supplies no value and only decides which
 * rows the answer returns. `[ct].[vwrowgate]` declares `Amount` itself, which is exactly why the
 * two decisions must produce the same dispatch: without a route decision saying otherwise, nothing
 * pads the session's target set back onto it. `route_requests[].columns` has two states — a
 * non-empty list, or the literal `'none'` — and an omitted field (`columnCarryFromRoute`) reads as
 * the same `row_role_only` carry as a stated `'none'`, not as "the router had no opinion, so the
 * session's traced targets apply".
 */
const FORK_NODES: ReadonlyArray<readonly [string, ObjectType, string[]]> = [
  ['[ct].[vwforktop]', V, ['Amount']],
  ['[ct].[vwvaluefeed]', V, ['Amount']],
  ['[ct].[forkvaluesrc]', T, ['Amount']],
  ['[ct].[vwrowgate]', V, ['Amount', 'GateFlag']],
  ['[ct].[rowgatesrc]', T, ['Amount', 'GateFlag']],
];
const FORK_EDGES: ReadonlyArray<readonly [string, string]> = [
  ['[ct].[forkvaluesrc]', '[ct].[vwvaluefeed]'],
  ['[ct].[vwvaluefeed]', '[ct].[vwforktop]'],
  ['[ct].[rowgatesrc]', '[ct].[vwrowgate]'],
  ['[ct].[vwrowgate]', '[ct].[vwforktop]'],
];
const FORK_ORIGIN = '[ct].[vwforktop]';
const FORK_CARRIER = '[ct].[vwvaluefeed]';
const FORK_VALUE_SRC = '[ct].[forkvaluesrc]';
const FORK_ROW_GATE = '[ct].[vwrowgate]';

const FORK_CASE: RetentionCase = {
  id: 'per-neighbour fork',
  origin: FORK_ORIGIN,
  tracedColumn: 'Amount',
  nodes: FORK_NODES,
  edges: FORK_EDGES,
  reachRequired: [],
  flow: {},
  measuredLost: [],
};

/** The `columns` decision the fork's row-gate route carries, as the model would submit it. */
type ForkColumns = string[] | 'none' | undefined;

/**
 * Starts the fork trace and commits the origin hop with the given decision for the row gate.
 *
 * @param rowGateColumns - The `columns` decision the origin hop states for the row-gate route.
 * @param opts - `carrierColumns` states a decision for the sibling route the origin's `column_flow`
 *   already attributes `Amount` to; `log` captures the engine's log stream.
 */
function startFork(rowGateColumns: ForkColumns, opts: {
  carrierColumns?: ForkColumns;
  log?: (level: string, message: string) => void;
} = {}): {
  engine: NavigationEngine;
  model: DatabaseModel;
  graph: ReturnType<typeof makeGraph>;
} {
  const { model, graph } = buildWorld(FORK_CASE);
  const engine = new NavigationEngine(model, graph, opts.log ?? (() => {}), {});
  const init = engine.init({
    origin: FORK_ORIGIN,
    question: 'trace Amount',
    direction: 'upstream',
    analysisMode: 'ct',
    targetColumns: ['Amount'],
    depthIntent: { kind: 'explicit', levels: 6 },
  });
  expect('ok' in init, 'CT init succeeds').toBe(true);

  const originCtx = engine.getHopContext() as { focus_node?: { id: string } };
  expect(originCtx.focus_node?.id, 'the origin is dispatched first').toBe(FORK_ORIGIN);
  const committed = engine.submitFindings({
    focus_node_id: FORK_ORIGIN,
    sections: [{ angle: 'business' as const, text: 'origin exposes Amount' }],
    summary: 'origin',
    verdict: 'analyze',
    column_flow: [{ out_col: 'Amount', upstream_columns: [{ node: FORK_CARRIER, col: 'Amount' }] }],
    route_requests: [
      {
        nodeId: FORK_CARRIER,
        question: 'where does vwvaluefeed read Amount from?',
        ...(opts.carrierColumns === undefined ? {} : { columns: opts.carrierColumns }),
      },
      {
        nodeId: FORK_ROW_GATE,
        question: 'which rows does vwrowgate admit into vwforktop?',
        ...(rowGateColumns === undefined ? {} : { columns: rowGateColumns }),
      },
    ],
  }) as SubmitOk;
  expect(committed.error, 'the origin hop commits').toBeUndefined();
  return { engine, model, graph };
}

/**
 * Runs the walk to exhaustion, recording the active column set each focus was dispatched with.
 *
 * @param engine - A fork engine whose origin hop has already committed.
 * @returns Focus id → the active columns that hop actually received.
 */
function driveForkHops(engine: NavigationEngine): Map<string, string[]> {
  const dispatched = new Map<string, string[]>();
  for (let guard = 0; guard < 12; guard++) {
    const ctx = engine.getHopContext() as {
      focus_node?: { id: string };
      working_memory?: { column_aspect?: { active_columns?: string[] } };
    };
    if (!ctx.focus_node) break;
    const focusId = ctx.focus_node.id;
    const active = [...(ctx.working_memory?.column_aspect?.active_columns ?? [])];
    dispatched.set(focusId, active);
    const outcome = engine.submitFindings({
      focus_node_id: focusId,
      sections: [{ angle: 'business' as const, text: `${focusId} analysed` }],
      summary: focusId,
      verdict: 'analyze',
      // Terminal form: this hop accounts for each active column and names no upstream real column.
      column_flow: active.map(col => ({ out_col: col, upstream_columns: [] })),
      // `columns` is stated explicitly as the session's traced target set, the same value the
      // engine's omitted-field fallback used to supply for these downstream, incidental routes.
      route_requests: engine.requiredNeighborIds(focusId).map(id => ({
        nodeId: id, question: `what does ${id} contribute?`, columns: engine.columnAspect?.target_columns,
      })),
    }) as SubmitOk;
    expect(outcome.error, `${focusId} commits`).toBeUndefined();
  }
  return dispatched;
}

describe('CT per-neighbour column carry — three states of route_requests[].columns', () => {
  it('not stated is row_role_only, never an inherited session target set', () => {
    const { engine } = startFork(undefined);
    const dispatched = driveForkHops(engine);
    expect(
      dispatched.get(FORK_ROW_GATE),
      'an omitted decision carries no active column — the same dispatch a stated "none" produces, not a pad from the session target set',
    ).toEqual([]);
  });

  it('stated columns carry exactly those columns', () => {
    const { engine } = startFork(['Amount']);
    const dispatched = driveForkHops(engine);
    expect(dispatched.get(FORK_ROW_GATE), 'the named column reaches the neighbour').toEqual(['Amount']);
  });

  it('stated as none dispatches a plain whole-object hop and is not re-padded', () => {
    const { engine } = startFork('none');
    const dispatched = driveForkHops(engine);
    expect(
      dispatched.get(FORK_ROW_GATE),
      'the row-role neighbour declares Amount and is still dispatched with no active column',
    ).toEqual([]);
    expect(
      dispatched.get(FORK_CARRIER),
      'its sibling on the same fork keeps the column rider',
    ).toEqual(['Amount']);
  });

  it('rejects a none the same hop contradicted in its own column_flow', () => {
    // Two channels, one submission: `column_flow` attributes `Amount` to the carrier (a provenance
    // assertion) while the route for the same node states `none` (an absence claim). One payload
    // contradicting itself is a repairable model error, so the engine refuses it and names both the
    // neighbour and the columns rather than picking a winner behind the model's back.
    //
    // Built inline rather than through `startFork`, whose own precondition is that the origin hop
    // commits — the refusal IS the subject here.
    const { model, graph } = buildWorld(FORK_CASE);
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({
      origin: FORK_ORIGIN,
      question: 'trace Amount',
      direction: 'upstream',
      analysisMode: 'ct',
      targetColumns: ['Amount'],
      depthIntent: { kind: 'explicit', levels: 6 },
    });
    engine.getHopContext();
    const refused = engine.submitFindings({
      focus_node_id: FORK_ORIGIN,
      sections: [{ angle: 'business' as const, text: 'origin exposes Amount' }],
      summary: 'origin',
      verdict: 'analyze',
      column_flow: [{ out_col: 'Amount', upstream_columns: [{ node: FORK_CARRIER, col: 'Amount' }] }],
      route_requests: [
        { nodeId: FORK_CARRIER, question: 'where does vwvaluefeed read Amount from?', columns: 'none' as const },
        { nodeId: FORK_ROW_GATE, question: 'which rows does vwrowgate admit into vwforktop?', columns: 'none' as const },
      ],
    }) as { error?: string; detail?: Array<{ id?: string; path?: string; available_columns?: string[] }> };

    expect(refused.error, 'the self-contradiction is refused, not normalized').toBe('route_columns_flow_conflict');
    const conflict = refused.detail?.find(entry => entry.id === FORK_CARRIER);
    expect(conflict, 'the refusal names the neighbour in conflict').toBeDefined();
    expect(
      conflict?.path,
      'the repair points at the column decision, not the object id',
    ).toBe('route_requests.0.columns');
    expect(
      conflict?.available_columns,
      'and the columns its own column_flow attributed, so the repair needs no guessing',
    ).toEqual(['Amount']);
  });

  it('rejects the same contradiction when BB would defer the neighbour as too deep', () => {
    // Origin depth 0, explicit cap 1: the carrier is in range, its source is depth 2 and
    // would defer. Naming that source as both `none` and an Amount supplier is still one
    // payload contradicting itself — Amount must not land.
    const { model, graph } = buildWorld(FORK_CASE);
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({
      origin: FORK_ORIGIN,
      question: 'trace Amount',
      direction: 'upstream',
      analysisMode: 'ct',
      targetColumns: ['Amount'],
      depthIntent: { kind: 'explicit', levels: 1 },
    });
    engine.getHopContext();
    const refused = engine.submitFindings({
      focus_node_id: FORK_ORIGIN,
      sections: [{ angle: 'business' as const, text: 'origin exposes Amount' }],
      summary: 'origin',
      verdict: 'analyze',
      column_flow: [{ out_col: 'Amount', upstream_columns: [{ node: FORK_VALUE_SRC, col: 'Amount' }] }],
      route_requests: [
        { nodeId: FORK_VALUE_SRC, question: 'where does Amount originate?', columns: 'none' as const },
        { nodeId: FORK_ROW_GATE, question: 'which rows does vwrowgate admit into vwforktop?', columns: 'none' as const },
      ],
    }) as { error?: string; detail?: Array<{ id?: string; path?: string }> };

    expect(refused.error, 'too-deep does not skip the same-submit contradiction').toBe('route_columns_flow_conflict');
    expect(
      refused.detail?.find(entry => entry.id === FORK_VALUE_SRC)?.path,
      'the repair still points at the column decision',
    ).toBe('route_requests.0.columns');
    expect(
      engine.columnAspect?.edges ?? [],
      'Amount is not stored from a neighbour the payload also marked as none',
    ).toEqual([]);
  });

  it('accepts the same hop when the route states the columns its column_flow attributes', () => {
    // The other half of the pair: the same fixture with the route agreeing rather than denying.
    // Pins that the rejection above keys on the contradiction, not merely on column_flow being
    // present alongside a stated decision.
    const { engine } = startFork(undefined, { carrierColumns: ['Amount'] });
    const dispatched = driveForkHops(engine);
    expect(
      dispatched.get(FORK_CARRIER),
      'the agreed column reaches the node the same hop said supplies it',
    ).toEqual(['Amount']);
    const states = new Map(engine.getResult().node_states.map(state => [state.nodeId, state]));
    expect(states.get(FORK_CARRIER)?.columnRole, 'and it is realized as a carrier').toBe('carrier');
  });

  it('marks the two forks apart on the node state that reaches the snapshot and the result', () => {
    const { engine } = startFork('none');
    driveForkHops(engine);
    const states = new Map(engine.getResult().node_states.map(state => [state.nodeId, state]));
    expect(states.get(FORK_ROW_GATE)?.columnRole, 'the row gate is marked row-role-only').toBe('row_role_only');
    expect(states.get(FORK_CARRIER)?.columnRole, 'the carrier is marked a carrier').toBe('carrier');
    // The role is orthogonal to the verdict: both hops submitted `analyze`.
    expect(states.get(FORK_ROW_GATE)?.action, 'the row gate is still analysed').toBe('analyze');
  });

  it('a route stating none wins over the BFS seed already queued for that node', () => {
    // The row gate is a direct neighbour, so `init` seeded it with a `carry` over the target set
    // before the router ever saw it. The route merges onto that entry, and the stated `none`
    // decision replaces the seed's carried columns rather than unioning with them.
    const { engine } = startFork('none');
    const snapshot = engine.toJSON() as { agenda: Array<{ nodeId: string; activeColumns?: string[]; columnCarry?: { kind: string } }> };
    const queued = snapshot.agenda.find(entry => entry.nodeId === FORK_ROW_GATE);
    expect(queued?.columnCarry?.kind, 'the authored decision is on the queued entry').toBe('row_role_only');
    expect(queued?.activeColumns, 'and the projection it implies is empty, not the target set').toEqual([]);
  });

  it('survives a checkpoint round trip', () => {
    const { engine, model, graph } = startFork('none');
    const restored = NavigationEngine.fromJSON(JSON.parse(JSON.stringify(engine.toJSON())), model, graph, () => {}, {});
    const dispatched = driveForkHops(restored);
    expect(
      dispatched.get(FORK_ROW_GATE),
      'the decision is durable — a resumed session does not re-pad the neighbour',
    ).toEqual([]);
  });

  it('restores a checkpoint written before the channel existed, unchanged', () => {
    // Backward compatibility: strip the field the old writer never emitted. An entry with no
    // `columnCarry` at all dispatches on its raw `activeColumns` (the `statedRowRole` base in
    // `getHopContext`), which this pre-channel checkpoint already carried explicitly.
    const { engine, model, graph } = startFork('none');
    const legacy = JSON.parse(JSON.stringify(engine.toJSON())) as {
      agenda: Array<{ nodeId: string; activeColumns?: string[]; columnCarry?: unknown }>;
      nodeStates: Array<{ columnRole?: unknown }>;
    };
    for (const entry of legacy.agenda) {
      delete entry.columnCarry;
      if (entry.nodeId === FORK_ROW_GATE) entry.activeColumns = ['Amount'];
    }
    for (const state of legacy.nodeStates) delete state.columnRole;

    const restored = NavigationEngine.fromJSON(legacy, model, graph, () => {}, {});
    const dispatched = driveForkHops(restored);
    expect(
      dispatched.get(FORK_ROW_GATE),
      'the pre-change checkpoint restores and behaves as it did when it was written',
    ).toEqual(['Amount']);
  });
});

/**
 * A stated subset, separated from a `none` and from an omitted decision on one topology.
 *
 * The fork above proves `none` and an omitted decision dispatch identically (both `row_role_only`),
 * but its traced set is a single column, so "carry these columns" and "carry the full traced set"
 * name the same thing there. Two traced columns and a stated subset separate a real carry from
 * both empty-handed states: a route naming `GateFlag` alone must reach its neighbour as `GateFlag`
 * alone, which neither an omitted decision nor a stated `none` can produce — both dispatch empty.
 *
 * The narrowed neighbour sits at depth 2 on purpose. A direct neighbour is already on the agenda
 * from the origin seed, and a stated `carry` merges into that seeded entry as a union — the seed's
 * carried set is not a competing opinion the router can narrow, only one it can add to.
 */
const NARROW_NODES: ReadonlyArray<readonly [string, ObjectType, string[]]> = [
  ['[ct].[vwnarrowtop]', V, ['Amount', 'GateFlag']],
  ['[ct].[vwnarrowmid]', V, ['Amount', 'GateFlag']],
  ['[ct].[vwnarrowgate]', V, ['Amount', 'GateFlag']],
  ['[ct].[narrowsrc]', T, ['Amount', 'GateFlag']],
];
const NARROW_EDGES: ReadonlyArray<readonly [string, string]> = [
  ['[ct].[narrowsrc]', '[ct].[vwnarrowgate]'],
  ['[ct].[vwnarrowgate]', '[ct].[vwnarrowmid]'],
  ['[ct].[vwnarrowmid]', '[ct].[vwnarrowtop]'],
];
const NARROW_ORIGIN = '[ct].[vwnarrowtop]';
const NARROW_MID = '[ct].[vwnarrowmid]';
const NARROW_GATE = '[ct].[vwnarrowgate]';

const NARROW_CASE: RetentionCase = {
  id: 'stated-subset carry',
  origin: NARROW_ORIGIN,
  tracedColumn: 'Amount',
  nodes: NARROW_NODES,
  edges: NARROW_EDGES,
  reachRequired: [],
  flow: {},
  measuredLost: [],
};

/**
 * Traces `Amount` and `GateFlag` upstream, stating `decision` for the depth-2 route only.
 *
 * @param decision - The `columns` field the mid hop's route to the gate carries, or `undefined` to
 *   omit the field entirely.
 * @returns Focus id → the active columns that hop was dispatched with.
 */
function driveNarrowWalk(decision: ForkColumns): Map<string, string[]> {
  const { model, graph } = buildWorld(NARROW_CASE);
  const engine = new NavigationEngine(model, graph, () => {}, {});
  const init = engine.init({
    origin: NARROW_ORIGIN,
    question: 'trace Amount and GateFlag',
    direction: 'upstream',
    analysisMode: 'ct',
    targetColumns: ['Amount', 'GateFlag'],
    depthIntent: { kind: 'explicit', levels: 6 },
  });
  expect('ok' in init, 'CT init succeeds on both traced columns').toBe(true);

  const dispatched = new Map<string, string[]>();
  for (let guard = 0; guard < 12; guard++) {
    const ctx = engine.getHopContext() as {
      focus_node?: { id: string };
      working_memory?: { column_aspect?: { active_columns?: string[] } };
    };
    if (!ctx.focus_node) break;
    const focusId = ctx.focus_node.id;
    const active = [...(ctx.working_memory?.column_aspect?.active_columns ?? [])];
    dispatched.set(focusId, active);
    // The origin attributes both traced columns to the mid node, so the spine reaches it; every
    // later hop is terminal and names no further upstream column, which keeps the dispatched set a
    // statement about the carry decision alone.
    const columnFlow = focusId === NARROW_ORIGIN
      ? active.map(col => ({ out_col: col, upstream_columns: [{ node: NARROW_MID, col }] }))
      : active.map(col => ({ out_col: col, upstream_columns: [] }));
    const outcome = engine.submitFindings({
      focus_node_id: focusId,
      sections: [{ angle: 'business' as const, text: `${focusId} analysed` }],
      summary: focusId,
      verdict: 'analyze',
      column_flow: columnFlow,
      // Every route except the mid→gate edge under test states `columns` explicitly as the
      // session's traced target set — the same value the engine's omitted-field fallback used to
      // supply for these incidental routes. The mid→gate edge alone carries `decision` verbatim
      // (including `undefined`, to omit the field), since that is the carry under test.
      route_requests: engine.requiredNeighborIds(focusId).map(id => ({
        nodeId: id,
        question: `what does ${id} contribute?`,
        ...(focusId === NARROW_MID && id === NARROW_GATE
          ? (decision !== undefined ? { columns: decision } : {})
          : { columns: engine.columnAspect?.target_columns }),
      })),
    }) as SubmitOk;
    expect(outcome.error, `${focusId} commits`).toBeUndefined();
  }
  return dispatched;
}

describe('CT per-neighbour column carry — a stated subset is not an inherit', () => {
  // The fork suite above already proves omitted/`none` dispatch empty on a single-column trace;
  // the one new claim two traced columns can prove that a single column cannot is the subset case.
  it('carries only the stated subset, never the wider set it was queued under', () => {
    expect(
      driveNarrowWalk(['GateFlag']).get(NARROW_GATE),
      'the router named one of the two traced columns and that is what the neighbour is asked about',
    ).toEqual(['GateFlag']);
  });
});

/**
 * F1 (agenda-column-carry-merge) — a node two siblings both reach: one route states `columns:
 * 'none'` for it, a sibling's later hop then commits a column_flow edge naming it as the supplier
 * of a traced column. The stated `'none'` is honoured on the agenda entry (not overturned at
 * enqueue time), but the dispatch-time spine bind still binds the column when the node is
 * actually dispatched — the LAST place the engine resolves the disagreement on the AI's behalf.
 */
describe('F1 — a stated "none" on the agenda entry does not drop the column a later committed edge attributes', () => {
  it('agenda entry keeps "none"; dispatch still binds the column the committed edge names', () => {
    const col = (name: string) => ({ name, type: 'int' as const, nullable: 'NOT NULL' as const, extra: '' });
    const nodes: LineageNode[] = [
      makeNode({ id: 'f1_origin', schema: 'dbo', name: 'f1_origin', type: 'view', columns: [col('TargetCol')] }),
      makeNode({ id: 'f1_carrier', schema: 'dbo', name: 'f1_carrier', type: 'view', columns: [col('TargetCol')] }),
      makeNode({ id: 'f1_filter', schema: 'dbo', name: 'f1_filter', type: 'view', columns: [col('FilterKey')] }),
      makeNode({ id: 'f1_shared', schema: 'dbo', name: 'f1_shared', type: 'view', columns: [col('TargetCol')] }),
    ];
    const edges: Array<[string, string]> = [
      ['f1_carrier', 'f1_origin'], ['f1_filter', 'f1_origin'], ['f1_shared', 'f1_carrier'], ['f1_shared', 'f1_filter'],
    ];
    const engine = new NavigationEngine(makeModel(nodes, edges, ['dbo']), makeGraph(nodes, edges), () => {}, {});
    engine.init({ origin: 'f1_origin', question: 'trace TargetCol upstream', direction: 'upstream', analysisMode: 'ct', targetColumns: ['TargetCol'] });
    engine.getHopContext();
    engine.submitFindings({
      focus_node_id: 'f1_origin',
      sections: [{ angle: 'business' as const, text: 'origin' }], summary: 'origin', verdict: 'analyze',
      column_flow: [{ out_col: 'TargetCol', upstream_columns: [{ node: 'f1_carrier', col: 'TargetCol' }] }],
      route_requests: [
        { nodeId: 'f1_carrier', question: 'where does TargetCol come from?', columns: ['TargetCol'] },
        { nodeId: 'f1_filter', question: 'which rows does this admit?', columns: 'none' as const },
      ],
    });
    engine.getHopContext();
    expect(engine.currentFocus, 'the carrier dequeues first').toBe('f1_carrier');
    engine.submitFindings({
      focus_node_id: 'f1_carrier',
      sections: [{ angle: 'business' as const, text: 'carrier' }], summary: 'carrier', verdict: 'analyze',
      column_flow: [{ out_col: 'TargetCol', upstream_columns: [{ node: 'f1_shared', col: 'TargetCol' }] }],
      route_requests: [{ nodeId: 'f1_shared', question: 'where does TargetCol come from?', columns: ['TargetCol'] }],
    });
    engine.getHopContext();
    expect(engine.currentFocus, 'the filter branch dequeues next').toBe('f1_filter');
    engine.submitFindings({
      focus_node_id: 'f1_filter',
      sections: [{ angle: 'business' as const, text: 'filter' }], summary: 'filter', verdict: 'analyze',
      column_flow: [],
      route_requests: [{ nodeId: 'f1_shared', question: 'which rows does this admit?', columns: 'none' as const }],
    });

    interface SnapshotAgendaEntry { nodeId: string; activeColumns?: string[]; columnCarry?: { kind: string } }
    const shared = (JSON.parse(JSON.stringify(engine.toJSON())) as { agenda: SnapshotAgendaEntry[] })
      .agenda.find(entry => entry.nodeId === 'f1_shared');
    expect(shared?.columnCarry?.kind, 'the later route said "none" and the entry records "none"').toBe('row_role_only');
    expect(shared?.activeColumns?.length ?? 0, 'no column is padded back on at enqueue time').toBe(0);

    engine.getHopContext();
    expect(engine.currentFocus, 'the shared node dispatches').toBe('f1_shared');
    expect(engine.columnAspect?.active_columns.join(','), 'the proven column is not dropped at dispatch').toBe('TargetCol');
  });
});

/**
 * ct-border-endpoint-prune-disposition — a submit that names a node both as a column_flow
 * writes_to target and in prune_neighbors contradicts itself; the prune is refused and the node
 * stays reachable for a clean resubmit.
 */
describe('CT — a same-submit writes_to plus prune_neighbors naming the same node is refused', () => {
  it('the contradiction is refused, the node is never removed, and a clean resubmit commits the edge', () => {
    const col = { name: 'Amt', type: 'int', nullable: 'NULL' as const, extra: '' };
    const nodes = [
      makeNode({ id: 'bp_origin', schema: 'x', name: 'bp_origin', type: 'view', columns: [col] }),
      makeNode({ id: 'bp_spmove', schema: 'x', name: 'bp_spmove', type: 'procedure', columns: [col] }),
      makeNode({ id: 'bp_archive', schema: 'x', name: 'bp_archive', type: 'table', columns: [col] }),
    ];
    const edges: Array<[string, string]> = [['bp_origin', 'bp_spmove'], ['bp_spmove', 'bp_archive']];
    const engine = new NavigationEngine(makeModel(nodes, edges, ['x']), makeGraph(nodes, edges), () => {}, {});
    engine.init({
      origin: 'bp_origin', question: 'trace Amt downstream', direction: 'downstream',
      analysisMode: 'ct', targetColumns: ['Amt'], depthIntent: { kind: 'explicit', levels: 1 },
    });
    engine.getHopContext();
    engine.submitFindings({
      focus_node_id: 'bp_origin', sections: [{ angle: 'business' as const, text: 'origin carries Amt' }],
      summary: 'origin carries Amt', verdict: 'analyze', column_flow: [{ out_col: 'Amt', upstream_columns: [] }],
      route_requests: engine.requiredNeighborIds('bp_origin').map(id => ({ nodeId: id, question: `what does ${id} decide?` })),
    });
    engine.getHopContext();
    expect(engine.currentFocus).toBe('bp_spmove');
    const contradicted = engine.submitFindings({
      focus_node_id: 'bp_spmove', sections: [{ angle: 'business' as const, text: 'spmove writes Amt into archive' }],
      summary: 'spmove writes Amt into archive', verdict: 'analyze',
      column_flow: [{ out_col: 'Amt', upstream_columns: [{ node: 'bp_origin', col: 'Amt' }], writes_to: { node: 'bp_archive', col: 'Amt' } }],
      prune_neighbors: ['bp_archive'],
    }) as { error?: string; hint?: string };
    expect(contradicted.error, 'the same-submit prune of the staged writes_to target is refused').toBe('prune_would_orphan_noted');

    const clean = engine.submitFindings({
      focus_node_id: 'bp_spmove', sections: [{ angle: 'business' as const, text: 'spmove writes Amt into archive' }],
      summary: 'spmove writes Amt into archive', verdict: 'analyze',
      column_flow: [{ out_col: 'Amt', upstream_columns: [{ node: 'bp_origin', col: 'Amt' }], writes_to: { node: 'bp_archive', col: 'Amt' } }],
    });
    expect('error' in clean, 'the clean resubmit commits').toBe(false);
    const snapshot = engine.toJSON();
    expect(snapshot.removedSet.includes('bp_archive'), 'archive is never removed').toBe(false);
    expect((snapshot.columnAspect?.edges ?? []).some(e => e.to_node === 'bp_archive'), 'the column edge into archive is committed').toBe(true);
  });
});

/**
 * ct-chain-connectivity — the committed column edges form one component containing the origin; a
 * neighbour reached without a route carry dispatches column-less and cannot stage a detached one.
 */
describe('CT chain connectivity — the committed column-edge graph forms one component containing the origin', () => {
  it('a plain chain commits one connected component; an omitted route carry forecloses a detached one', () => {
    const nodes: LineageNode[] = ['cx_report', 'cx_carrier', 'cx_vendor'].map(id =>
      makeNode({ id, schema: 'dbo', name: id, type: 'view', columns: [{ name: 'amount', type: 'int', nullable: 'NOT NULL', extra: '' }] }));
    const edges: Array<[string, string]> = [['cx_carrier', 'cx_report'], ['cx_vendor', 'cx_carrier']];
    const engine = new NavigationEngine(makeModel(nodes, edges, ['dbo']), makeGraph(nodes, edges), () => {}, {});
    engine.init({ origin: 'cx_report', question: 'trace amount', direction: 'upstream', analysisMode: 'ct', targetColumns: ['amount'], depthIntent: { kind: 'explicit', levels: 3 } });
    const chainFlow: Record<string, Array<{ out_col: string; upstream_columns: Array<{ node: string; col: string }> }>> = {
      cx_report: [{ out_col: 'amount', upstream_columns: [{ node: 'cx_carrier', col: 'amount' }] }],
      cx_carrier: [{ out_col: 'amount', upstream_columns: [{ node: 'cx_vendor', col: 'amount' }] }],
      cx_vendor: [{ out_col: 'amount', upstream_columns: [] }],
    };
    for (let hop = 0; hop < 5; hop++) {
      const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
      if (ctx.done || !ctx.focus_node) break;
      engine.submitFindings({ focus_node_id: ctx.focus_node.id, sections: [{ angle: 'business' as const, text: 'ok' }], summary: 'ok', verdict: 'passthrough', column_flow: chainFlow[ctx.focus_node.id] });
    }
    const edgesOut = engine.getResult().columnAspect?.edges ?? [];
    expect(edgesOut.length, 'the chain commits an edge at report and at carrier').toBe(2);
    expect(edgesOut.some(e => e.from_node === 'cx_report' || e.to_node === 'cx_report'), 'the component contains the origin').toBe(true);

    // Detach: cx_carrier separately routes `cx_gadget` with NO columns field. Omitted route carry
    // resolves to row_role_only, so gadget dispatches with no active column and cannot stage an edge.
    const detachNodes = [...nodes, makeNode({ id: 'cx_gadget', schema: 'dbo', name: 'cx_gadget', type: 'view', columns: [{ name: 'amount', type: 'int', nullable: 'NOT NULL', extra: '' }] })];
    const detachEdges: Array<[string, string]> = [...edges, ['cx_gadget', 'cx_carrier']];
    const engine2 = new NavigationEngine(makeModel(detachNodes, detachEdges, ['dbo']), makeGraph(detachNodes, detachEdges), () => {}, {});
    engine2.init({ origin: 'cx_report', question: 'trace amount', direction: 'upstream', analysisMode: 'ct', targetColumns: ['amount'], depthIntent: { kind: 'explicit', levels: 4 } });
    engine2.getHopContext();
    engine2.submitFindings({ focus_node_id: 'cx_report', sections: [{ angle: 'business' as const, text: 'ok' }], summary: 'ok', verdict: 'passthrough', column_flow: chainFlow.cx_report });
    engine2.getHopContext();
    engine2.submitFindings({
      focus_node_id: 'cx_carrier', sections: [{ angle: 'business' as const, text: 'ok' }], summary: 'ok', verdict: 'passthrough',
      column_flow: [{ out_col: 'amount', upstream_columns: [] }],
      route_requests: [{ nodeId: 'cx_gadget', question: 'what feeds this' }],
    });
    engine2.getHopContext();
    const outcome = engine2.submitFindings({
      focus_node_id: 'cx_gadget', sections: [{ angle: 'business' as const, text: 'ok' }], summary: 'ok', verdict: 'passthrough',
      column_flow: [{ out_col: 'amount', upstream_columns: [{ node: 'cx_report', col: 'amount' }] }],
    }) as { error?: string };
    expect(outcome.error, 'the omitted-carry route leaves gadget with no active column to declare').toBe('out_col_not_tracked');
  });
});

/**
 * ct-neighbor-attributed-columns — a hop's neighbour list discloses what committed column_flow
 * edges already attribute to each neighbour, before the model states a route_requests[].columns
 * decision for it. Purely additive disclosure: the same spine the override later acts on, surfaced
 * one hop earlier instead of applied only at the moment a route is accepted.
 */
describe('hop_context.neighbors[] discloses columns a committed column_flow edge already attributed', () => {
  const nodes: LineageNode[] = [
    makeNode({ id: 'na_origin', schema: 'dbo', name: 'na_origin', type: 'view', columns: [{ name: 'Amount', type: 'int', nullable: 'NULL', extra: '' }] }),
    makeNode({ id: 'na_hub', schema: 'dbo', name: 'na_hub', type: 'view' }),
    makeNode({ id: 'na_sup', schema: 'dbo', name: 'na_sup', type: 'table', columns: [{ name: 'RawAmount', type: 'int', nullable: 'NULL', extra: '' }] }),
    makeNode({ id: 'na_other', schema: 'dbo', name: 'na_other', type: 'view' }),
  ];
  const edges: Array<[string, string]> = [['na_hub', 'na_origin'], ['na_sup', 'na_hub'], ['na_other', 'na_hub']];

  it('shows the attributed column on the named neighbour, and nothing on an untouched sibling', () => {
    const engine = new NavigationEngine(makeModel(nodes, edges, ['dbo']), makeGraph(nodes, edges), () => {}, {});
    engine.init({ origin: 'na_origin', question: 'trace Amount', direction: 'upstream', analysisMode: 'ct', targetColumns: ['Amount'], depthIntent: { kind: 'explicit', levels: 3 } });
    engine.getHopContext();
    engine.submitFindings({
      focus_node_id: 'na_origin', sections: [{ angle: 'business' as const, text: 'origin computes Amount from na_sup' }],
      summary: 'origin', verdict: 'analyze',
      column_flow: [{ out_col: 'Amount', upstream_columns: [{ node: 'na_sup', col: 'RawAmount' }] }],
      route_requests: [{ nodeId: 'na_hub', question: 'what does hub do with the value?', columns: 'none' as const }],
    });
    const ctx = engine.getHopContext() as { focus_node?: { id: string }; neighbors?: Array<{ id: string; attributed_columns?: string[] }> };
    expect(ctx.focus_node?.id, 'hub dispatches next').toBe('na_hub');
    const byId = new Map((ctx.neighbors ?? []).map(n => [n.id, n]));
    expect(byId.get('na_sup')?.attributed_columns, "origin's column_flow named na_sup as the supplier of Amount before this hop").toEqual(['RawAmount']);
    expect(byId.get('na_other')?.attributed_columns, 'no hop has ever named na_other in a column_flow entry').toBeUndefined();
  });

  it('discloses nothing in BB mode — no column channel to read from', () => {
    const bbNodes: LineageNode[] = [makeNode({ id: 'na_origin', schema: 'dbo', name: 'na_origin', type: 'view' }), makeNode({ id: 'na_hub', schema: 'dbo', name: 'na_hub', type: 'view' })];
    const bbEdges: Array<[string, string]> = [['na_hub', 'na_origin']];
    const engine = new NavigationEngine(makeModel(bbNodes, bbEdges, ['dbo']), makeGraph(bbNodes, bbEdges), () => {}, {});
    engine.init({ origin: 'na_origin', question: 'trace origin back to its sources', direction: 'upstream', depthIntent: { kind: 'explicit', levels: 2 } });
    const ctx = engine.getHopContext() as { neighbors?: Array<{ id: string; attributed_columns?: string[] }> };
    expect((ctx.neighbors ?? []).length, 'na_hub is a neighbour of the BB seed').toBeGreaterThan(0);
    for (const neighbor of ctx.neighbors ?? []) expect(neighbor.attributed_columns, `BB neighbour ${neighbor.id} carries no column channel at all`).toBeUndefined();
  });
});

/**
 * ct-reopen-carrier-row-role-merge / ct-reopen-open-column-end — a column a committed column_flow
 * edge leaves open at a non-bodied carrier stays owed by that carrier's producer. The reopen it
 * triggers dispatches the producer with the column active even when: (a) a different router later
 * states a row role about another carrier the producer also reads (a row role never outranks a
 * committed edge), and (b) the producer was already visited (BB's visited guard) before the
 * column reached it — a new column on it is a new question, reopened rather than skipped.
 */
describe('CT reopen — a committed edge left open outranks both a later row role and the visited flag', () => {
  it('reopens the producer with the owed column though a later router states a row role about a different carrier it also reads', () => {
    const col = (name: string) => ({ name, type: 'int', nullable: 'NULL' as const, extra: '' });
    const nodes: LineageNode[] = [
      makeNode({ id: 'rp_calc', schema: 'ct', name: 'rp_calc', type: 'view', columns: [col('Discount')] }),
      makeNode({ id: 'rp_staging', schema: 'ct', name: 'rp_staging', type: 'table', columns: [col('Amount')] }),
      makeNode({ id: 'rp_master', schema: 'ct', name: 'rp_master', type: 'table', columns: [col('Tier')] }),
      makeNode({ id: 'rp_loader', schema: 'ct', name: 'rp_loader', type: 'procedure', columns: [] }),
      makeNode({ id: 'rp_rawview', schema: 'ct', name: 'rp_rawview', type: 'view', columns: [col('Amount')] }),
      makeNode({ id: 'rp_cleaner', schema: 'ct', name: 'rp_cleaner', type: 'procedure', columns: [] }),
      makeNode({ id: 'rp_rawsrc', schema: 'ct', name: 'rp_rawsrc', type: 'table', columns: [col('RawAmount')] }),
    ];
    const edges: Array<[string, string]> = [
      ['rp_staging', 'rp_calc'], ['rp_master', 'rp_calc'], ['rp_loader', 'rp_staging'], ['rp_rawview', 'rp_loader'],
      ['rp_cleaner', 'rp_rawview'], ['rp_rawsrc', 'rp_cleaner'], ['rp_master', 'rp_cleaner'],
    ];
    const engine = new NavigationEngine(makeModel(nodes, edges, ['ct']), makeGraph(nodes, edges), () => {}, {});
    engine.init({ origin: 'rp_calc', question: 'Trace rp_calc.Discount back to its original sources', direction: 'bidirectional', analysisMode: 'ct', targetColumns: ['Discount'], depthIntent: { kind: 'full_frontier' } });

    const dispatched: Array<{ focusId: string; active: string[] }> = [];
    for (let hop = 0; hop < 15; hop++) {
      const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
      if (ctx.done || !ctx.focus_node) break;
      const focusId = ctx.focus_node.id;
      const active = [...(engine.columnAspect?.active_columns ?? [])];
      dispatched.push({ focusId, active });
      const routes = engine.requiredNeighborIds(focusId).map(id => ({ nodeId: id, question: `what does ${id} do?` }));
      let flow: Array<{ out_col: string; upstream_columns: Array<{ node: string; col: string }>; writes_to?: { node: string; col: string } }> = [];
      if (focusId === 'rp_calc') flow = [{ out_col: 'Discount', upstream_columns: [{ node: 'rp_staging', col: 'Amount' }, { node: 'rp_master', col: 'Tier' }] }];
      else if (focusId === 'rp_loader') flow = [{ out_col: 'Amount', upstream_columns: [{ node: 'rp_rawview', col: 'Amount' }], writes_to: { node: 'rp_staging', col: 'Amount' } }];
      else if (focusId === 'rp_rawview') flow = [{ out_col: 'Amount', upstream_columns: [{ node: 'rp_cleaner', col: 'Amount' }] }];
      else if (focusId === 'rp_cleaner' && active.includes('Amount')) flow = [{ out_col: 'Amount', upstream_columns: [{ node: 'rp_rawsrc', col: 'RawAmount' }], writes_to: { node: 'rp_rawview', col: 'Amount' } }];
      engine.submitFindings({ focus_node_id: focusId, sections: [{ angle: 'business' as const, text: 'ok' }], summary: 'ok', verdict: 'analyze', column_flow: flow, route_requests: routes });
    }
    const cleanerHops = dispatched.filter(d => d.focusId === 'rp_cleaner');
    expect(cleanerHops.length, 'cleaner is visited early (as a co-reader of master) and reopened once the column reaches it').toBe(2);
    expect(cleanerHops[1].active, 'the reopened hop asks for the owed column').toEqual(['Amount']);
  });

  it('reopens a producer the BB visited guard already dispatched, once a new column names it', () => {
    const col = (name: string) => ({ name, type: 'decimal' as const, nullable: 'NULL' as const, extra: '' });
    const nodes: LineageNode[] = [
      makeNode({ id: 'ro_origin', schema: 'ai', name: 'ro_origin', type: 'view', columns: [col('Discount')] }),
      makeNode({ id: 'ro_customer', schema: 'ai', name: 'ro_customer', type: 'table', columns: [col('CustomerTier')] }),
      makeNode({ id: 'ro_cleaner', schema: 'ai', name: 'ro_cleaner', type: 'procedure', columns: [] }),
      makeNode({ id: 'ro_cleaned', schema: 'ai', name: 'ro_cleaned', type: 'table', columns: [col('OrderAmount')] }),
      makeNode({ id: 'ro_import', schema: 'ai', name: 'ro_import', type: 'table', columns: [col('RawAmount')] }),
    ];
    const edges: Array<[string, string]> = [
      ['ro_customer', 'ro_origin'], ['ro_cleaner', 'ro_cleaned'], ['ro_customer', 'ro_cleaner'], ['ro_import', 'ro_cleaner'], ['ro_cleaned', 'ro_origin'],
    ];
    const engine = new NavigationEngine(makeModel(nodes, edges, ['ai']), makeGraph(nodes, edges), () => {}, {});
    engine.init({ origin: 'ro_origin', question: 'Trace ro_origin.Discount', direction: 'bidirectional', analysisMode: 'ct', targetColumns: ['Discount'], depthIntent: { kind: 'full_frontier' } });

    const dispatchedAt = new Map<string, string[][]>();
    for (let hop = 0; hop < 15; hop++) {
      const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
      if (ctx.done || !ctx.focus_node) break;
      const focusId = ctx.focus_node.id;
      const active = [...(engine.columnAspect?.active_columns ?? [])];
      const seen = dispatchedAt.get(focusId); if (seen) seen.push(active); else dispatchedAt.set(focusId, [active]);
      const routes = engine.requiredNeighborIds(focusId).map(id => ({ nodeId: id, question: `what does ${id} do?` }));
      let flow: Array<{ out_col: string; upstream_columns: Array<{ node: string; col: string }> }> = [];
      if (focusId === 'ro_origin') flow = [{ out_col: 'Discount', upstream_columns: [{ node: 'ro_customer', col: 'CustomerTier' }, { node: 'ro_cleaned', col: 'OrderAmount' }] }];
      else if (focusId === 'ro_cleaner' && active.includes('OrderAmount')) flow = [{ out_col: 'OrderAmount', upstream_columns: [{ node: 'ro_import', col: 'RawAmount' }] }];
      engine.submitFindings({ focus_node_id: focusId, sections: [{ angle: 'business' as const, text: 'ok' }], summary: 'ok', verdict: 'analyze', column_flow: flow, route_requests: routes });
    }
    const cleanerDispatches = dispatchedAt.get('ro_cleaner') ?? [];
    expect(cleanerDispatches.some(active => active.includes('OrderAmount')), 'cleaner (visited early as a co-reader of customer) is reopened with OrderAmount active once cleaned names it').toBe(true);
    expect(cleanerDispatches.length, 'cleaner is dispatched at most twice — once per column question, not repeatedly').toBeLessThanOrEqual(2);
  });
});
