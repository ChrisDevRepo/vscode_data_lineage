/**
 * CT retention differential — the wave-1 defect, reproduced deterministically.
 *
 * Wave 1 measured 10 required dependencies lost across 8 of 11 real-model cases, with BB
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
import type { SmResult } from '../../../src/ai/sm/smTypes';
import { bfsReachable } from '../../../src/engine/graphGuards';
import type { DatabaseModel, LineageNode, ObjectType } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

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

/** Drives a CT walk, submitting the case's scripted column_flow at each dispatched focus. */
function driveCt(engine: NavigationEngine, testCase: RetentionCase): void {
  for (let hop = 0; hop < 25; hop++) {
    const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
    if (ctx.done || !ctx.focus_node) return;
    const focusId = ctx.focus_node.id;
    const columnFlow = testCase.flow[focusId];
    expect(columnFlow, `${testCase.id}: the case scripts a column_flow for dispatched focus ${focusId}`).toBeDefined();
    const outcome = engine.submitFindings({
      focus_node_id: focusId,
      sections: [{ angle: 'business' as const, text: `capture for ${focusId}` }],
      summary: `${focusId} carries ${testCase.tracedColumn}`,
      verdict: 'analyze',
      column_flow: columnFlow,
    });
    expect('error' in outcome, `${testCase.id}: the scripted hop at ${focusId} is accepted, not rejected`).toBe(false);
  }
  throw new Error(`${testCase.id}: CT walk did not terminate within 25 hops`);
}

/** Drives a BB walk, routing every required neighbour the hop offers. */
function driveBb(engine: NavigationEngine): void {
  for (let hop = 0; hop < 25; hop++) {
    const ctx = engine.getHopContext() as {
      done?: boolean;
      focus_node?: { id: string };
      required_neighbors?: string[];
      neighbors?: Array<{ id: string; edge_direction?: string }>;
    };
    if (ctx.done || !ctx.focus_node) return;
    const focusId = ctx.focus_node.id;
    const targets = ctx.required_neighbors
      ?? (ctx.neighbors ?? []).filter(n => n.edge_direction === 'upstream').map(n => n.id);
    engine.submitFindings({
      focus_node_id: focusId,
      sections: [{ angle: 'business' as const, text: `capture for ${focusId}` }],
      summary: `${focusId}`,
      verdict: 'analyze',
      route_requests: targets.map(id => ({ nodeId: id, question: 'what does this contribute upstream?' })),
    });
  }
  throw new Error('BB walk did not terminate within 25 hops');
}

describe('CT retention — every required dependency survives into the result', () => {
  for (const testCase of CASES) {
    it(`${testCase.id}`, () => {
      const { model, graph } = buildWorld(testCase);
      const engine = new NavigationEngine(model, graph, () => {}, {});
      const init = engine.init({
        origin: testCase.origin,
        question: `trace ${testCase.tracedColumn}`,
        direction: 'upstream',
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
      expect(lost, `${testCase.id}: required dependencies missing from the answer (wave 1 measured: ${testCase.measuredLost.join(', ') || 'none'})`).toEqual([]);

      // Causation: a node admitted to scope and never pruned must reach the result. A failure here
      // is a silent engine drop, not a model decision.
      const state = engine.toJSON();
      const survivors = bfsReachable(graph, testCase.origin, new Set(state.removedSet), undefined, new Set(state.scopeNodeIds));
      survivors.add(testCase.origin);
      for (const id of survivors) {
        expect(rendered.has(id), `${testCase.id}: ${id} is in scope and unpruned, so it is not silently dropped`).toBe(true);
      }

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
      const engine = new NavigationEngine(model, graph, () => {}, {});
      const init = engine.init({
        origin: testCase.origin,
        question: 'what feeds this object and what restricts its rows?',
        direction: 'upstream',
        depthIntent: { kind: 'explicit', levels: 6 },
      });
      expect('ok' in init, `${testCase.id}: BB init succeeds`).toBe(true);

      driveBb(engine);
      const rendered = new Set(engine.getResult().fullNodes.map(n => n.id));
      const lost = testCase.reachRequired.filter(required => !rendered.has(required));
      expect(lost, `${testCase.id}: BB keeps every required dependency`).toEqual([]);
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
    // The loader joins DimCalendar to bound the load window and writes ErrorLog on failure; neither
    // carries a value into the traced column, so its flow names neither.
    '[ct].[sploadsalesstaging]': [],
  },
  measuredLost: [],
};

/** Runs the measured T8 walk: every bodied node the column spine reaches, and nothing else. */
function driveSinkWalk(routeFromConsumer?: string): SmResult {
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
    if (ctx.done || !ctx.focus_node) return engine.getResult();
    const focusId = ctx.focus_node.id;
    const columnFlow = SINK_CASE.flow[focusId];
    expect(columnFlow, `the case scripts a column_flow for dispatched focus ${focusId}`).toBeDefined();
    engine.submitFindings({
      focus_node_id: focusId,
      sections: [{ angle: 'business' as const, text: `capture for ${focusId}` }],
      summary: `${focusId}`,
      verdict: 'analyze',
      column_flow: columnFlow,
      ...(routeFromConsumer && focusId === '[ct].[spbuildsalesreport]'
        ? { route_requests: [{ nodeId: routeFromConsumer, question: 'what does this record?' }] }
        : {}),
    });
  }
  throw new Error('sink walk did not terminate within 25 hops');
}

describe('CT render bound — scope admits, only a hop dispositions', () => {
  it('drops the write sinks no hop ever dispositioned, chain and all', () => {
    const rendered = new Set(driveSinkWalk().fullNodes.map(n => n.id));
    // `splogaudit` supplies only `auditlog`, so the pair peels as a unit.
    const sinks = ['[ct].[errorlog]', '[ct].[splogaudit]', '[ct].[auditlog]'];
    expect(
      sinks.filter(id => rendered.has(id)),
      'a scope-resident node with no state, no task and no column edge, supplying nothing the render keeps, is not answer evidence',
    ).toEqual([]);
  });

  it('keeps an undispositioned supplier — a filter join and a sibling-column feed are one shape here', () => {
    const rendered = new Set(driveSinkWalk().fullNodes.map(n => n.id));
    // `dimcalendar` bounds the load window and supplies no `Discount`; `[ct].[prices]` in C8 has the
    // identical structure and is required. The engine cannot separate them, so both stay in the
    // render and the synthesis prompt keeps an undispositioned node out of the section links.
    expect(rendered.has('[ct].[dimcalendar]'), 'a supplier of a rendered node survives the sink trim').toBe(true);
  });

  it('keeps the dispositioned join-key leaf and every column-flow participant', () => {
    const result = driveSinkWalk();
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
    const rendered = new Set(driveSinkWalk('[ct].[auditlog]').fullNodes.map(n => n.id));
    expect(rendered.has('[ct].[auditlog]'), 'the routed sink is dispositioned and kept').toBe(true);
    expect(rendered.has('[ct].[splogaudit]'), 'the only path to a kept node survives the leaf trim').toBe(true);
  });
});
