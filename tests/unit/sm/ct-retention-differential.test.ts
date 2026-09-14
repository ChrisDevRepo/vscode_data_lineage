/**
 * CT retention differential — a measured defect, reproduced deterministically.
 *
 * Recorded runs measured 10 required dependencies lost across 8 of 11 real-model cases, with BB
 * losing none. Every loss had the same signature: the node was in `scopeNodeIds`, absent from
 * `removedSet`, and absent from the result — admitted, never pruned, and gone. These cases
 * reproduce that signature with no model and no network, one minimal topology per measured
 * case, so the fix can be developed and regression-guarded offline.
 *
 * Each case keeps only what decides retention: the traced column's value supplier, and the
 * dependency that supplies no value to it. `flow` is the column_flow the measured run's model
 * submitted at each bodied focus.
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
  /** Case id as recorded in CR section 6. */
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
  /** Required nodes the measured CT run lost and the BB run kept (CR section 6). */
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
    // `[ct].[stgorders]` is the non-bodied carrier between the origin and the rest of the chain,
    // and it declares none of the traced column. The carrier's bind empties the projection; the
    // walk continues through it exactly as BB's does, so `[ct].[vworderfeed]` is reached on the
    // first path and re-derives its own `NetAmount` at dispatch. This case carries the acceptance
    // pair for that: the node is handed the real column it declares, and the rejection hint fires
    // only for a column that genuinely is not on the node.
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
      // Both halves of the acceptance pair are asserted on this node: it is handed the real column
      // it declares (see `expectActiveColumns`), and a flow naming that column commits instead of
      // being refused as `out_col_not_on_node`. The carrier's own empty projection annotates the
      // carrier; it no longer decides what the node behind it is allowed to carry.
      '[ct].[vworderfeed]': [{ out_col: 'NetAmount', upstream_columns: [{ node: '[ct].[orders]', col: 'OrderAmount' }] }],
    },
    expectActiveColumns: { '[ct].[vworderfeed]': ['NetAmount'] },
    measuredLost: [],
  },
  {
    // Every case above traces upstream, where each scope node supplies the one below it, so the
    // render's sink trim has no candidate and the drop stage of this suite never runs. This case
    // gives it one. `[audit].[loadlog]` is a write sink outside the user's schema filter: the BFS
    // seed deliberately keeps out-of-allowlist reachables (they are the gate classes a user can
    // approve), while the route path refuses them, so no hop is ever demanded to account for it
    // and it reaches `getResult` in scope, unpruned and dispositioned by nobody. Supplying nothing
    // the render keeps, it is a side-effect sink, not answer evidence — and CT drops it for the
    // same reason BB does, which is what the paired arms below check.
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
      verdict: 'analyze',
      column_flow: columnFlow,
      route_requests: engine.requiredNeighborIds(focusId).map(id => ({
        nodeId: id,
        question: `What does ${id} decide about the rows ${focusId} admits?`,
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
function startZeroColumnTrace(excludeNodeIds?: string[]): NavigationEngine {
  const { model, graph } = buildWorld(ZERO_COLUMN_CASE);
  const engine = new NavigationEngine(model, graph, () => {}, {});
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
      route_requests: [{ nodeId: ZERO_COLUMN_REQUIRED, question: 'what restricts the rows this arm admits?' }],
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
      route_requests: required.map(id => ({ nodeId: id, question: `what does ${id} contribute to the admitted rows?` })),
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
      route_requests: [{ nodeId: ZERO_COLUMN_REQUIRED, question: 'what restricts the rows this arm admits?' }],
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
        { nodeId: '[ct].[nosuchobject]', question: 'does this exist?' },
        { nodeId: ZERO_COLUMN_REQUIRED, question: 'what restricts the rows this arm admits?' },
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
      route_requests: [{ nodeId: ZERO_COLUMN_REQUIRED, question: 'what restricts the rows this arm admits?' }],
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
      route_requests: [{ nodeId: ZERO_COLUMN_REQUIRED, question: 'what restricts the rows this arm admits?' }],
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
 * Scope-resident sinks and filter leaves no hop dispositioned.
 *
 * Measured shape (T8, `[ai].[vwDiscountCalc]` / `Discount`, bidirectional): scope admitted 21
 * nodes and exactly four of them carried no `nodeStates` entry, no investigation task and no
 * column edge — `dimcalendar` (read by the loader, never for `Discount`), `errorlog` and
 * `auditlog` (write sinks), `splogaudit` (EXEC-only, and the only path to `auditlog`). Scope
 * admits a node; only a hop dispositions one, so these four are reachability artifacts, not
 * answer evidence. `customermaster` has the same "carries no traced value" shape but was
 * contracted through at hop 1 — dispositioned, therefore kept.
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
    // so the model never names it — the acda2ff9 shape.
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

/** Runs the measured T8 walk: every bodied node the column spine reaches, and nothing else. */
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
        sections: [{ angle: 'business' as const, text: `logging sink, off the traced column's answer path` }],
        summary: `${focusId} is a logging sink`,
        verdict: 'prune',
      });
      continue;
    }
    const columnFlow = SINK_CASE.flow[focusId];
    expect(columnFlow, `the case scripts a column_flow for dispatched focus ${focusId}`).toBeDefined();
    // CT is held to the same neighbour accounting as BB: every id the guard demands an account
    // for is routed, plus the consumer the variant under test adds on top.
    const routes = engine.requiredNeighborIds(focusId).map(id => ({
      nodeId: id,
      question: `What does ${id} decide about the rows ${focusId} admits?`,
    }));
    if (routeFromConsumer && focusId === '[ct].[spbuildsalesreport]') {
      routes.push({ nodeId: routeFromConsumer, question: 'what does this record?' });
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

/** The render the measured T8 walk produces. */
function sinkWalkResult(routeFromConsumer?: string): SmResult {
  return driveSinkWalk(routeFromConsumer).engine.getResult();
}

describe('CT render bound — scope admits, only a hop dispositions', () => {
  it('drops the logging sinks the walk can disposition — routed-and-deferred sinks stay, as in BB', () => {
    const rendered = new Set(sinkWalkResult().fullNodes.map(n => n.id));
    // Convergence: the guard demands every in-scope directional neighbour, so `errorlog` is
    // routed (accepted, contracted to no unvisited bodied neighbour, deferred as a lead) and stays
    // in the render exactly as a BB walk on this topology renders it. What still drops:
    // `splogaudit`, dispatched and verdict-pruned (a logging sink is off the answer path),
    // and `auditlog`, which no hop ever dispositioned. The old pin (all three sinks dropped) was
    // CT-specific: CT's guard used to be a no-op, so `errorlog` was never routed at all.
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

    // Convergence: `auditlog` is the one sink the render itself drops (no hop dispositioned
    // it). `splogaudit` left via an explicit verdict prune (removedSet, not a render drop), and
    // `errorlog` was guard-demanded, routed, and deferred as a contracted lead — it renders, as in
    // BB. The old pin named all three because CT's guard used to demand nothing, so all three sat
    // undispositioned; the snapshot now names exactly the render's own drops instead of leaving a
    // reader to infer them from scope minus the rendered set.
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
 * A submitted passthrough is not evidence the render needs the node.
 *
 * Measured shape (T8, `[ai].[sparchiveoldorders]`): a hop dispatched the archive proc, the model
 * returned `verdict=passthrough` — its own assertion that the focus transforms nothing on the
 * traced path — and the node stayed in the render on the strength of that entry alone, with its
 * one render-internal outgoing edge pointing at its own log writer. C12 is the counter-case: the
 * same verdict at a focus the tracer did place on a column edge keeps the node.
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
        sections: [{ angle: 'business' as const, text: `log writer, off the traced column's answer path` }],
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
 * A carrier proc is a column edge's `hop_node`, never its endpoint.
 *
 * Measured shape (T8S @ 37875e19, `[ai].[spbuildsalesreport]`): the question asked for the traced
 * column's direct consumers, the hop dispatched the consumer proc, the model returned
 * `verdict=passthrough`, and the proc's own `writes_to` target sat outside the depth border — so its
 * only render-internal outgoing edges were absent and the sink trim deleted the one node that
 * answered the question. A procedure appears in `ColumnAspect.edges` only as `hop_node`
 * (`from_node`/`to_node` carry the columns it moved between), so the endpoint exemption structurally
 * cannot reach it.
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
 * and the proc is left with no render-internal outgoing edge — the measured T8S shape.
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
      route_requests: [{ nodeId: ZERO_COLUMN_REQUIRED, question: 'what restricts the rows this arm admits?' }],
    }) as SubmitOk;
    expect(outcome.error, 'routing the zero-column neighbour commits the hop').toBeUndefined();
  });

  it('rejects a CT hop that leaves a required neighbour unaccounted', () => {
    const engine = startZeroColumnTrace();
    dispatchZeroColumnFocus(engine);
    const outcome = engine.submitFindings({
      focus_node_id: ZERO_COLUMN_FOCUS,
      sections: [{ angle: 'business' as const, text: 'filter arm restricts the set' }],
      summary: 'filter arm',
      verdict: 'analyze',
      column_flow: [],
    }) as SubmitOk & { detail?: Array<{ id: string }> };

    // Silently accepted before the convergence: CT's strategy implemented the guard as an empty
    // method body. The neighbour decision runs in both modes, and the column overlay is what CT
    // adds on top of the shared BB accounting.
    expect(outcome.error, 'the unaccounted required neighbour rejects in CT, as it does in BB').toBe('missing_required_route');
    expect((outcome.detail ?? []).map(d => d.id), 'the rejection names the unaccounted neighbour').toContain(ZERO_COLUMN_REQUIRED);
  });
});

/**
 * The hop-level prune proofs — the `a → b → (c, d, e)`, `c → f` shape, as the PM drew it: `b`'s
 * neighbours `c`, `d`, `e` are all inside the origin-rooted scope, so the guard demands an
 * account for each at hop `b` in BOTH modes. At hop `b` the model decides per neighbour: `c` is
 * routed BB-style (a table — the route contracts through to `f`), `e` is routed with the CT
 * column overlay (it carries the traced Amount onward), and `d` — in scope, guard-demanded, and
 * provably off the answer path — is PRUNED at the hop. The converged contract: the prune
 * executes (don't-orphan-guarded), the hop commits, and `d` never renders. Both modes, identical
 * behaviour, identical render.
 *
 * The amount chain is real and checkable end to end — the origin produces it, `b` carries it
 * from `a`, `e` from `b`, `f` from `c` — so every CT column_flow names a column its named
 * upstream really declares (nothing the rejection would refuse), and no hop needs the
 * passthrough escape: every focus either carries or produces the traced column.
 *
 * Red reproductions (written before the fix): in-scope prune targets were protected no-ops, so the
 * required-neighbour guard rejected the hop with `missing_required_route` and `d` could never be
 * dropped — the one decision the shared BB/CT contract could not express.
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
    const routes = engine.requiredNeighborIds(focusId)
      .filter(id => id !== '[ct].[tbld]')
      .map(id => ({ nodeId: id, question: `What does ${id} decide about the rows ${focusId} admits?` }));
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
        { nodeId: '[ct].[vwb]', question: 'b transforms the amount' },
        { nodeId: '[ct].[vwe]', question: 'e filters the rows' },
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
        { nodeId: '[ct].[tblc]', question: 'c supplies the amount' },
        { nodeId: '[ct].[tbld]', question: 'd is a logging sink' },
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
        { nodeId: '[ct].[vwb2]', question: 'b transforms the amount' },
        { nodeId: '[ct].[vwx2]', question: 'x is committed beyond the pruned table' },
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

describe('beyond-scope contraction — a routed table reaches its bodied writer in both modes', () => {
  /**
   * The table row of the decision space: a route to a table is accepted (the guard is satisfied)
   * and then contracts through to its unvisited bodied writers. The bodied writer can lie outside
   * the origin-rooted seed scope — the model read the table off the focus's own dependencies, so
   * the route is the approved growth, and the contraction is the walk's continuation of that
   * route, not a second ask. Pre-fix this admission was CT-only: BB silently dropped the writer
   * ("enqueue drop — out-of-scope target") while CT admitted it — a walk-machinery divergence the
   * same-graph contract forbids. Both modes must admit, enqueue, and render it identically.
   *
   * Topology: `a` (origin) → `b`; `g` (table) feeds `b`; `w` (procedure) writes `g`. The seed scope
   * from `a` is {a, b} — `g` and `w` are beyond it. At hop `b` the model routes `g`; the
   * contraction must reach `w` in both modes.
   */
  for (const mode of ['bb', 'ct'] as const) {
    it(`${mode.toUpperCase()}: routing the off-scope table at hop b contracts through to its writer`, () => {
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
        const routes = engine.requiredNeighborIds(focusId).map(id => ({ nodeId: id, question: `q ${id}` }));
        // The BB-style arm: `g` is beyond the seed scope, so the guard does not demand it — the
        // model reads it off the focus's own dependencies and routes it (legal in both modes).
        if (focusId === '[ct].[vwb3]' && !routes.some(r => r.nodeId === '[ct].[tblg3]')) {
          routes.push({ nodeId: '[ct].[tblg3]', question: 'g supplies the amount b joins' });
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
      }
      const result = engine.getResult();
      const rendered = new Set(result.fullNodes.map(n => n.id));
      expect(rendered.has('[ct].[tblg3]'), `${mode}: the routed table renders`).toBe(true);
      expect(rendered.has('[ct].[vwg3]'), `${mode}: the contraction through the routed table reaches its writer`).toBe(true);
    });
  }
});

describe('route-border demand — the guard demands only what the router admits (G3)', () => {
  /**
   * The no-unmeetable-demand invariant of the decision space: the completeness guard may demand
   * an account only for neighbours the router would actually admit. A schema the user filtered on
   * keeps out-of-allowlist neighbours in the seed scope (the seed deliberately skips the allowlist
   * so they become `schema:` gate classes) but the route border refuses them — a route to one is
   * deferred as a lead, never accepted — so demanding it is a demand the model cannot meet: the
   * hop could never commit. `requiredNeighborIds` must therefore filter on the router's own
   * admission test (`admitsRoute`), of which this is the border axis; the depth axis is the case
   * below (validated shape on record in `0852aadb`).
   *
   * Red pre-fix: the guard demanded the out-of-allowlist neighbour and rejected the hop with
   * `missing_required_route` however the model accounted for it.
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
   * The same invariant on the **depth** axis. Route admission is border AND depth: `checkBorder`
   * carries no depth axis for any purpose, so a neighbour inside the schema allowlist but past a
   * level count the user stated clears the border and is still deferred as a lead, never accepted.
   * Filtering the demand on the border alone therefore left the unmeetable demand standing on the
   * axis it did not cover — `admitsRoute` states both axes once and both sites read it.
   *
   * The state is reached through a resumed checkpoint because every in-session scope-growth path
   * depth-checks its own admission (route accept, contraction, `supplementAgenda`), while a
   * snapshot persists `scopeNodeIds` and the depth ceiling independently — so a restored engine is
   * where a scope member past the ceiling is actually observable, and the ceiling still binds.
   *
   * Red pre-fix: the guard demanded the past-the-ceiling neighbour and rejected the hop with
   * `missing_required_route` however the model accounted for it.
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
 * rows the answer returns.
 *
 * `[ct].[vwrowgate]` declares `Amount` itself, so the engine has every reason to hand it the
 * traced column and did so before this channel existed: the omission was re-padded from the
 * session's target set at `agendaColumnsFor` and again at dispatch. The three states of
 * `route_requests[].columns` — not stated, stated as columns, stated as none — are what separates
 * "the router had no opinion" from "the router said none", and only the third suppresses the pad.
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
      route_requests: engine.requiredNeighborIds(focusId).map(id => ({ nodeId: id, question: `what does ${id} contribute?` })),
    }) as SubmitOk;
    expect(outcome.error, `${focusId} commits`).toBeUndefined();
  }
  return dispatched;
}

describe('CT per-neighbour column carry — three states of route_requests[].columns', () => {
  it('not stated inherits the traced columns, exactly as before the channel existed', () => {
    const { engine } = startFork(undefined);
    const dispatched = driveForkHops(engine);
    expect(
      dispatched.get(FORK_ROW_GATE),
      'an omitted decision still inherits the session target set — the pre-existing behaviour',
    ).toEqual(['Amount']);
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

  it('normalizes a none the same hop contradicted in column_flow, and says so in the log', () => {
    // Two channels, one hop: `column_flow` attributes `Amount` to the carrier (a provenance
    // assertion) while the route for the same node states `none` (an absence claim). The evidence
    // wins. Without the normalization the carrier is dispatched with no active column and the very
    // edge the same submit staged has nothing to continue from.
    const logs: string[] = [];
    const { engine } = startFork(undefined, { carrierColumns: 'none', log: (_l, m) => logs.push(m) });
    const dispatched = driveForkHops(engine);
    expect(
      dispatched.get(FORK_CARRIER),
      'the attributed column reaches the node the same hop said supplies it',
    ).toEqual(['Amount']);
    const states = new Map(engine.getResult().node_states.map(state => [state.nodeId, state]));
    expect(states.get(FORK_CARRIER)?.columnRole, 'and it is realized as a carrier, not a row gate').toBe('carrier');
    expect(
      logs.some(line => line.includes('[Normalize] route carry') && line.includes(FORK_CARRIER) && line.includes('from=none')),
      'the overridden claim is logged, never silently dropped',
    ).toBe(true);
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
    // The row gate is a direct neighbour, so `init` seeded it with the target set before the
    // router ever saw it. The route merges onto that entry, and the stated decision replaces the
    // seed's inherited columns rather than unioning with them.
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
    // authored decision is `inherit`, which is the behaviour that checkpoint was written under.
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
 * The three carry states, separated on one topology by the set each one dispatches.
 *
 * The fork above proves `none` apart from the other two, but its traced set is a single column, so
 * "carry these columns" and "inherit the session's" name the same set there and either state
 * satisfies the other's assertion. Two traced columns and a stated subset separate them: a route
 * naming `GateFlag` alone must reach its neighbour as `GateFlag` alone, which an inherit cannot
 * produce and a `none` cannot either.
 *
 * The narrowed neighbour sits at depth 2 on purpose. A direct neighbour is already on the agenda
 * from the origin seed, and a stated `carry` merges into that seeded entry as a union — the seed's
 * inherited set is not a competing opinion the router can narrow, only one it can add to.
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
      route_requests: engine.requiredNeighborIds(focusId).map(id => ({
        nodeId: id,
        question: `what does ${id} contribute?`,
        ...(focusId === NARROW_MID && id === NARROW_GATE && decision !== undefined ? { columns: decision } : {}),
      })),
    }) as SubmitOk;
    expect(outcome.error, `${focusId} commits`).toBeUndefined();
  }
  return dispatched;
}

describe('CT per-neighbour column carry — a stated subset is not an inherit', () => {
  it('inherits both traced columns when the route states nothing', () => {
    expect(
      driveNarrowWalk(undefined).get(NARROW_GATE)?.slice().sort(),
      'no opinion stated, so the session target set applies unchanged',
    ).toEqual(['Amount', 'GateFlag']);
  });

  it('carries only the stated subset, never the wider set it was queued under', () => {
    expect(
      driveNarrowWalk(['GateFlag']).get(NARROW_GATE),
      'the router named one of the two traced columns and that is what the neighbour is asked about',
    ).toEqual(['GateFlag']);
  });

  it('carries nothing when the route states none', () => {
    expect(
      driveNarrowWalk('none').get(NARROW_GATE),
      'a row-role neighbour declaring both traced columns is still dispatched with neither',
    ).toEqual([]);
  });

  it('gives the three states three different dispatches on one topology', () => {
    // The discriminator, stated once: same graph, same question, same walk — only the `columns`
    // field differs, and no two states may produce the same set. Collapsing any pair in the engine
    // fails here rather than passing under the other's assertion.
    const sets = [undefined, ['GateFlag'] as string[], 'none' as const]
      .map(decision => (driveNarrowWalk(decision).get(NARROW_GATE) ?? []).slice().sort().join('|'));
    expect(new Set(sets).size, `three states, three dispatched sets (got ${sets.join(' / ')})`).toBe(3);
  });
});
