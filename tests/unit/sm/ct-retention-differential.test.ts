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
import { bfsReachable } from '../../../src/engine/graphGuards';
import type { DatabaseModel, LineageNode, ObjectType } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

interface ColumnRef { node: string; col: string }
interface FlowEntry { out_col: string; upstream_columns: ColumnRef[] }

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
