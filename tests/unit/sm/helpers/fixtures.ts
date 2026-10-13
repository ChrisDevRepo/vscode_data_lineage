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
