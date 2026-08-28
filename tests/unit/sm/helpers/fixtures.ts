/**
 * Shared fixture builders for tests/unit/sm/**.
 *
 * NOT a test file itself — imported by tests/unit/sm/*.test.ts files.
 *
 * These synthetic NavigationEngine test graphs predate `LineageNode.fullName`,
 * `DatabaseModel.schemas: SchemaInfo[]`, and the `'body' | 'exec'` LineageEdge.type
 * union — fields tightened after these fixtures were written (fixture-shape drift,
 * not a behavioral gap).
 *
 * None of these tests read `fullName`, per-schema `nodeCount`/`types` breakdowns, or
 * a populated `catalog`/`neighborIndex` — they drive NavigationEngine purely off the
 * synthetic id/edge topology. These builders backfill the now-required fields with
 * inert defaults so the fixtures type-check without changing what the tests exercise:
 *   - `edgeApiType()` (src/ai/support/aiPresenter.ts) maps any unrecognized edge type,
 *     including a non-member `'SELECT'` literal, to `'read'` — the same fallback it
 *     gives `'body'`. Retagging edges 'body' is a no-op for every present hop.
 *   - `buildHopFocusNode` (src/ai/tools/tools.ts) only reads `neighborIndex` for
 *     non-bodied (table/external) focus nodes, and the bipartite agenda rule means a
 *     table/external node is never dispatched as a hop focus — so an empty
 *     `neighborIndex: {}` is never observed by the engine paths these tests drive.
 *   - `model.catalog` is not read anywhere in the NavigationEngine/ColumnTracer code
 *     paths these tests exercise.
 */
import type { NavigationEngine } from '../../../../src/ai/sm/smBase';
import type {
  DatabaseModel,
  LineageEdge,
  LineageNode,
  ObjectType,
  SchemaInfo,
} from '../../../../src/engine/types';

/**
 * Build a LineageNode fixture. `fullName` defaults to `id` — these synthetic graphs
 * use flat, already-qualified ids for both — unless explicitly overridden.
 */
export function makeNode(
  node: Omit<LineageNode, 'fullName'> & Partial<Pick<LineageNode, 'fullName'>>,
): LineageNode {
  return { fullName: node.id, ...node };
}

/**
 * Build a `LineageEdge[]` fixture from `[source, target]` pairs. Every synthetic edge
 * is tagged `'body'`; see the module doc for why this is behaviorally inert versus a
 * non-member `'SELECT'` literal.
 */
export function makeEdges(pairs: ReadonlyArray<readonly [string, string]>): LineageEdge[] {
  return pairs.map(([source, target]) => ({ source, target, type: 'body' }));
}

const ZERO_TYPE_COUNTS: Record<ObjectType, number> = {
  table: 0,
  view: 0,
  procedure: 0,
  function: 0,
  external: 0,
};

/**
 * Build a minimal `SchemaInfo[]` fixture from bare schema names. `nodeCount`/`types`
 * are zeroed rather than computed — no test in this directory reads them.
 */
export function makeSchemas(names: ReadonlyArray<string>): SchemaInfo[] {
  return names.map((name) => ({ name, nodeCount: 0, types: { ...ZERO_TYPE_COUNTS } }));
}

/**
 * Build a full `DatabaseModel` fixture from nodes + `[source, target]` edge pairs +
 * schema names. `catalog`/`neighborIndex` default to empty (see module doc).
 */
export function makeModel(
  nodes: LineageNode[],
  edgePairs: ReadonlyArray<readonly [string, string]>,
  schemaNames: ReadonlyArray<string>,
  dbPlatform = 'SQL Server',
): DatabaseModel {
  return {
    nodes,
    edges: makeEdges(edgePairs),
    schemas: makeSchemas(schemaNames),
    catalog: {},
    neighborIndex: {},
    dbPlatform,
  };
}

// ─── Engine walking ───────────────────────────────────────────────────────────

/**
 * How `driveEngine` answers each hop it is handed.
 *
 * @remarks
 * Exactly one routing strategy applies per walk. `routes` wins over `succ`, and both win
 * over `followDownstream`; with none set the walk routes nothing and the engine advances
 * on its own seeded agenda.
 */
export interface DriveOptions {
  /** Focus id → the single successor to route on to. */
  succ?: Record<string, string | undefined>;
  /** Focus id → every successor to route on to. */
  routes?: Record<string, string[]>;
  /** Route every downstream neighbour the hop context offers. */
  followDownstream?: boolean;
  /** Ids to submit as `passthrough` rather than `analyze`. */
  passthrough?: ReadonlySet<string>;
  /** Prefixes the section text and summary, to tell two walks of one graph apart. */
  tag?: string;
  /** Hop ceiling, so a routing bug fails the test instead of hanging it. */
  limit?: number;
}

/**
 * Drives a NavigationEngine to completion, analyzing each dispatched focus in turn.
 *
 * @param engine - An initialized engine; `init` must already have been called.
 * @param options - Routing strategy and submission shape. See {@link DriveOptions}.
 * @returns The focus ids visited, in dispatch order.
 *
 * @remarks
 * Replaces the near-identical `drain` / `driveWalk` / `drainChain` / `driveRoutes` loops
 * that each nav-engine suite carried its own copy of. Tests that assert on submitted prose
 * author their own `submitFindings` call rather than routing it through here.
 */
export function driveEngine(
  engine: Pick<NavigationEngine, 'getHopContext' | 'submitFindings'>,
  options: DriveOptions = {},
): string[] {
  const { succ, routes, followDownstream, passthrough, tag, limit = 50 } = options;
  const visited: string[] = [];

  for (let hop = 0; hop < limit; hop++) {
    const ctx = engine.getHopContext() as {
      done?: boolean;
      focus_node?: { id: string };
      neighbors?: Array<{ id: string; edge_direction?: string }>;
    };
    if (ctx.done || !ctx.focus_node) break;

    const id = ctx.focus_node.id;
    visited.push(id);

    let targets: string[];
    if (routes) targets = routes[id] ?? [];
    else if (succ) targets = succ[id] ? [succ[id] as string] : [];
    else if (followDownstream) {
      targets = (ctx.neighbors ?? [])
        .filter((neighbor) => neighbor.edge_direction === 'downstream')
        .map((neighbor) => neighbor.id);
    } else targets = [];

    const label = tag ? `${tag}: ${id}` : id;
    engine.submitFindings({
      focus_node_id: id,
      sections: [{ angle: 'business', text: `analysis for ${label}` }],
      summary: label,
      verdict: passthrough?.has(id) ? 'passthrough' : 'analyze',
      route_requests: targets.map((target) => ({ nodeId: target, question: 'trace downstream' })),
    });
  }

  return visited;
}
