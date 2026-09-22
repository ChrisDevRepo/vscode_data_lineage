/**
 * A column endpoint one hop past the render border is dispositioned, not delivered on trust.
 *
 * A hop names its read source and its write target by node, and the neighbour just outside the
 * depth border is a correct answer to the question it was asked — the node is simply not a render
 * member, so a delivered chain that names it points at something the panel never draws. The
 * discriminator is not scope membership, which is identical for every endpoint below, but whether
 * the render keeps anything the endpoint supplies: a terminal write sink is not evidence at either
 * layer, while an endpoint a rendered node reads is.
 *
 * Each case carries both verdicts on one walk, so a fix that keyed on the border, on the direction,
 * on the endpoint position or on a node name would fail one endpoint of the same case.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { ColumnEdge } from '../../../src/ai/sm/smTypes';
import type { LineageNode, ObjectType } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

const V = 'view' as const, T = 'table' as const, P = 'procedure' as const;

interface ColumnRef { node: string; col: string }
interface FlowEntry { out_col: string; upstream_columns: ColumnRef[]; writes_to?: ColumnRef }

interface BorderCase {
  readonly id: string;
  readonly nodes: ReadonlyArray<readonly [string, ObjectType, string[]]>;
  readonly edges: ReadonlyArray<readonly [string, string]>;
  readonly flow: Readonly<Record<string, FlowEntry[]>>;
  /** Endpoints the walk names from outside the render, and whether the chain still names them. */
  readonly borderEndpoints: ReadonlyArray<readonly [string, boolean]>;
}

const ORIGIN = '[x].[vworders]';
const TRACED = 'Amt';

const CASES: readonly BorderCase[] = [
  {
    id: 'a terminal write sink is withheld while a read source on the same border is delivered',
    nodes: [
      [ORIGIN, V, [TRACED]],
      ['[x].[spmove]', P, [TRACED]],
      ['[x].[archive]', T, [TRACED]],
      ['[x].[base]', T, [TRACED]],
    ],
    edges: [
      ['[x].[base]', ORIGIN],
      [ORIGIN, '[x].[spmove]'],
      ['[x].[spmove]', '[x].[archive]'],
    ],
    flow: {
      [ORIGIN]: [{ out_col: TRACED, upstream_columns: [{ node: '[x].[base]', col: TRACED }] }],
      '[x].[spmove]': [{
        out_col: TRACED,
        upstream_columns: [{ node: ORIGIN, col: TRACED }],
        writes_to: { node: '[x].[archive]', col: TRACED },
      }],
    },
    // `base` supplies the rendered origin; `archive` supplies nothing the render keeps.
    borderEndpoints: [['[x].[base]', true], ['[x].[archive]', false]],
  },
  {
    id: 'a write target past the border that a rendered node reads is delivered',
    nodes: [
      [ORIGIN, V, [TRACED]],
      ['[x].[spmove]', P, [TRACED]],
      ['[x].[handoff]', T, [TRACED]],
      ['[x].[vwreport]', V, [TRACED]],
    ],
    edges: [
      [ORIGIN, '[x].[spmove]'],
      ['[x].[spmove]', '[x].[handoff]'],
      ['[x].[handoff]', '[x].[vwreport]'],
      [ORIGIN, '[x].[vwreport]'],
    ],
    flow: {
      [ORIGIN]: [{ out_col: TRACED, upstream_columns: [] }],
      '[x].[spmove]': [{
        out_col: TRACED,
        upstream_columns: [{ node: ORIGIN, col: TRACED }],
        writes_to: { node: '[x].[handoff]', col: TRACED },
      }],
      '[x].[vwreport]': [{ out_col: TRACED, upstream_columns: [{ node: ORIGIN, col: TRACED }] }],
    },
    // Same position and same border as `archive` above, and delivered — because `vwreport` reads it.
    borderEndpoints: [['[x].[handoff]', true]],
  },
];

/** Builds the case's world: one node per declared id, one directed edge per declared pair. */
function buildWorld(testCase: BorderCase): { model: ReturnType<typeof makeModel>; graph: ReturnType<typeof makeGraph> } {
  const nodes: LineageNode[] = testCase.nodes.map(([id, type, columns]) => {
    const [, schema, name] = /^\[([^\]]+)\]\.\[([^\]]+)\]$/.exec(id) ?? ['', 'x', id];
    return makeNode({
      id, schema, name, type,
      columns: columns.map(columnName => ({ name: columnName, type: 'int', nullable: 'NULL', extra: '' })),
    });
  });
  const edgePairs = testCase.edges.map(([source, target]) => [source, target] as [string, string]);
  return { model: makeModel(nodes, edgePairs, ['x']), graph: makeGraph(nodes, edgePairs) };
}

/** A CT engine on the case's world, seeded one level deep so the border sits inside the topology. */
function startCt(testCase: BorderCase): { engine: NavigationEngine; model: ReturnType<typeof makeModel>; graph: ReturnType<typeof makeGraph> } {
  const { model, graph } = buildWorld(testCase);
  const engine = new NavigationEngine(model, graph, () => {}, {});
  const init = engine.init({
    origin: ORIGIN,
    question: `trace ${TRACED} downstream`,
    direction: 'downstream',
    analysisMode: 'ct',
    targetColumns: [TRACED],
    // One level, so the nodes the hops name by column sit one hop past the border they draw.
    depthIntent: { kind: 'explicit', levels: 1 },
  });
  expect('ok' in init, `${testCase.id}: CT init succeeds`).toBe(true);
  return { engine, model, graph };
}

/** Drives the CT walk, submitting the case's scripted flow at each dispatched focus. */
function driveCt(engine: NavigationEngine, testCase: BorderCase): void {
  for (let hop = 0; hop < 15; hop++) {
    const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
    if (ctx.done || !ctx.focus_node) return;
    const focusId = ctx.focus_node.id;
    const columnFlow = testCase.flow[focusId];
    expect(columnFlow, `${testCase.id}: the case scripts a column_flow for dispatched focus ${focusId}`).toBeDefined();
    const outcome = engine.submitFindings({
      focus_node_id: focusId,
      sections: [{ angle: 'business' as const, text: `capture for ${focusId}` }],
      summary: `${focusId} carries ${TRACED}`,
      verdict: 'analyze',
      column_flow: columnFlow,
      route_requests: engine.requiredNeighborIds(focusId).map(id => ({
        nodeId: id,
        question: `What does ${id} decide about the rows ${focusId} admits?`,
      })),
    });
    expect('error' in outcome, `${testCase.id}: the scripted hop at ${focusId} is accepted, not rejected`).toBe(false);
  }
  throw new Error(`${testCase.id}: CT walk did not terminate within 15 hops`);
}

/** Identity of one column edge, so an edge is compared across two projections by what it says. */
const key = (e: ColumnEdge): string => `${e.hop_node}|${e.from_node}.${e.from_col}->${e.to_node}.${e.to_col}`;

/** Keys of the edges naming a node at either endpoint position. */
const namingEndpoint = (edges: readonly ColumnEdge[], id: string): string[] =>
  edges.filter(e => e.from_node === id || e.to_node === id).map(key);

describe('CT — a column endpoint past the render border is dispositioned by sink-ness', () => {
  for (const testCase of CASES) {
    it(`${testCase.id}`, () => {
      const { engine, model } = startCt(testCase);
      driveCt(engine, testCase);

      const result = engine.getResult();
      const rendered = new Set(result.fullNodes.map(n => n.id));
      const committed = engine.toJSON().columnAspect?.edges ?? [];
      const delivered = result.columnAspect?.edges ?? [];
      const withheld = new Set<string>();

      for (const [endpoint, expectDelivered] of testCase.borderEndpoints) {
        // The premise every endpoint shares: outside the render, and named by a hop anyway.
        expect(rendered.has(endpoint), `${testCase.id}: ${endpoint} is past the render border`).toBe(false);
        const named = namingEndpoint(committed, endpoint);
        expect(named.length, `${testCase.id}: a hop committed an edge naming ${endpoint}`).toBeGreaterThan(0);

        // The one fact that separates them, read off the model rather than the case's own word.
        const suppliesRendered = model.edges.some(e => e.source === endpoint && rendered.has(e.target));
        expect(suppliesRendered, `${testCase.id}: ${endpoint} supplies the render`).toBe(expectDelivered);

        expect(
          namingEndpoint(delivered, endpoint),
          `${testCase.id}: the chain names ${endpoint} only when a rendered node reads it`,
        ).toEqual(expectDelivered ? named : []);
        if (!expectDelivered) for (const k of named) withheld.add(k);
      }

      // Withheld, not trimmed: every other committed edge is delivered, in order and unchanged.
      expect(delivered.map(key), `${testCase.id}: nothing but the withheld endpoints' edges changes`)
        .toEqual(committed.map(key).filter(k => !withheld.has(k)));
    });
  }

  it('a withheld edge survives in the checkpoint, so a resume traces the chain it committed', () => {
    const testCase = CASES[0];
    const sink = testCase.borderEndpoints.find(([, delivered]) => !delivered)![0];
    const { engine, model } = startCt(testCase);
    driveCt(engine, testCase);

    const delivered = engine.getResult().columnAspect?.edges ?? [];
    const snapshot = engine.toJSON();
    expect(namingEndpoint(delivered, sink), 'the chain the answer is built from withholds it').toEqual([]);
    expect(
      namingEndpoint(snapshot.columnAspect?.edges ?? [], sink).length,
      'the checkpoint keeps it: delivery is a projection, not a trim',
    ).toBeGreaterThan(0);

    const restored = NavigationEngine.fromJSON(
      snapshot,
      model,
      makeGraph(testCase.nodes.map(([id]) => ({ id })), testCase.edges.map(([s, t]) => [s, t] as [string, string])),
      () => {},
      {},
    );
    expect(restored.toJSON().columnAspect?.edges, 'the restored engine carries the same committed chain')
      .toEqual(snapshot.columnAspect?.edges);
  });
});
