/**
 * Shared fixtures and catalog rows for the lineage-cases contract and functional suites
 * (tests/cases/lineage-cases.yaml).
 */
import { createRequire } from 'node:module';
import { expect } from 'vitest';
import { ColumnTracer } from '../../../../src/ai/sm/columnTracer';
import type {
  ColumnEdge,
  ColumnFlowEntry,
} from '../../../../src/ai/sm/smTypes';
import { NavigationEngine } from '../../../../src/ai/sm/smBase';
import type { LineageNode, ObjectType } from '../../../../src/engine/types';
import {
  makeGraph,
  makeIndexedModel,
  makeModel,
  makeNode,
} from '../../helpers/modelFixtures';
import { buildColumnTraceView } from '../../../../src/engine/columnTraceView';
import { DEFAULT_CONFIG } from '../../../../src/engine/types';

/** CJS catalog loader bound for ESM suites that share lineage-cases.yaml. */
export const { loadCases } = createRequire(import.meta.url)(
  '../../../cases/loadCases.cjs',
) as {
  loadCases: (runner?: string) => CatalogRow[];
};

interface FlowColumn {
  readonly node: string;
  readonly col: string;
  readonly transforms?: readonly string[];
  readonly note?: string;
}

interface CaseNode {
  readonly id: string;
  readonly type: ObjectType;
  readonly columns?: readonly string[];
}

interface CaseExpect {
  readonly edges?: readonly string[];
  readonly invalid?: readonly unknown[];
  readonly invalid_kind?: string;
  readonly reason_contains?: string;
}

interface LineageCase {
  readonly id: string;
  readonly active: readonly string[];
  readonly nodes: readonly CaseNode[];
  readonly focus: string;
  readonly out: string;
  readonly direction: 'upstream' | 'downstream';
  readonly roots?: readonly { node: string; col: string }[];
  readonly upstream?: readonly FlowColumn[];
  readonly extra?: readonly { out: string; upstream?: readonly FlowColumn[] }[];
  readonly matrix?: readonly FlowColumn[];
  readonly expect: CaseExpect;
}

interface CatalogRow {
  readonly id: string;
  readonly contract?: 'stored-arrival' | 'self-prune';
  readonly runners?: readonly string[];
  readonly prompt?: string;
  readonly dacpac?: string;
  readonly expect?: CaseExpect & { terminal?: string };
}

interface StoredArrivalCase {
  id: string;
  receiver_type: 'procedure' | 'view';
  sql: string;
  receiver_columns: string[];
  sink_columns: string[];
  column_flow: ColumnFlowEntry[];
  expect: {
    mapped_inputs: string[];
    receiver_rows: string[];
    sink_mode: 'ct' | 'bb';
    sink_columns: string[];
  };
}

interface SelfPruneCase {
  id: string;
  story: string;
  mode: 'bb' | 'ct' | Array<'bb' | 'ct'>;
  direction?: 'upstream' | 'downstream';
  route:
    | 'inherited'
    | 'authored'
    | 'mapped'
    | 'root'
    | 'function'
    | 'mixed'
    | 'held-mapping'
    | 'pending-sender';
  through_storage?: boolean;
  /** Arbitrary topology: short object names are qualified in the synthetic d schema. */
  graph: { edges: Array<[string, string]> };
  expect: {
    eligible: boolean;
    /** Eligible, but the removal is rejected because committed column mappings name the node. */
    refused?: boolean;
    pruned: string[];
    unvisited?: string[];
    inspected?: string[];
    kept?: string[];
    edges?: Array<[string, string]>;
  };
}

/** Full scripted catalog so contract and functional suites read the same rows. */
export const scriptedCatalog = loadCases('scripted');

/** Scripted rows that carry no contract tag, the default column-flow cases. */
export const scriptedCases = scriptedCatalog.filter(
  (row) => row.contract === undefined,
) as unknown as LineageCase[];

/** Catalog rows tagged stored-arrival for the arrival contract suite. */
export const storedArrivalCases = scriptedCatalog.filter(
  (row) => row.contract === 'stored-arrival',
) as unknown as StoredArrivalCase[];

/** Self-prune rows expanded once per mode so each mode is asserted on its own. */
export const selfPruneCases = (
  scriptedCatalog.filter(
    (row) => row.contract === 'self-prune',
  ) as unknown as SelfPruneCase[]
).flatMap((row) =>
  [row.mode].flat().map((mode) => ({
    ...row,
    mode,
    id: Array.isArray(row.mode) ? `${mode}-${row.id}` : row.id,
  })),
);

/** Column shape synthetic model nodes need when a case names a column. */
export function column(name: string) {
  return { name, type: 'int', nullable: 'NULL' as const, extra: '' };
}

/** Depth intent for a full upstream trace and no downstream expansion. */
export const upstreamAll = {
  upstream: { levels: 'all' as const, exactness: 'exact' as const },
  downstream: { levels: 0, exactness: 'exact' as const },
};

/** Builds a navigation engine on a synthetic graph, with no database. */
export function engineFor(
  nodes: LineageNode[],
  pairs: ReadonlyArray<readonly [string, string]>,
  mutate?: (model: ReturnType<typeof makeIndexedModel>) => void,
) {
  const model = makeIndexedModel(nodes, pairs);
  mutate?.(model);
  return new NavigationEngine(
    model,
    makeGraph(
      nodes,
      pairs.map(([from, to]) => [from, to]),
    ),
    () => {},
    {},
  );
}

/** Uses the same declared objects and topology to check delivered column rows. */
export function columnViewFor(
  nodes: LineageNode[],
  pairs: ReadonlyArray<readonly [string, string]>,
  edges: readonly ColumnEdge[],
) {
  return buildColumnTraceView({
    config: DEFAULT_CONFIG,
    objects: new Map(
      nodes.map((node) => [
        node.id.toLowerCase(),
        {
          id: node.id,
          label: node.name,
          schema: node.schema,
          objectType: node.type,
        },
      ]),
    ),
    objectEdges: pairs.map(([source, target]) => ({ source, target })),
    relations: edges.map((edge) => ({
      fromNode: edge.from_node,
      fromCol: edge.from_col,
      toNode: edge.to_node,
      toCol: edge.to_col,
      hopNode: edge.hop_node,
    })),
  });
}

function run(row: LineageCase, upstream: readonly FlowColumn[]) {
  const nodes = row.nodes.map((node) =>
    makeNode({
      id: node.id,
      schema: 'dbo',
      name: node.id,
      type: node.type,
      columns: (node.columns ?? []).map(column),
    }),
  );
  const result = new ColumnTracer([...row.active]).validateColumnFlow(
    row.focus,
    {
      summary: 's',
      sections: [],
      column_flow: [
        { out_col: row.out, upstream_columns: upstream },
        ...(row.extra ?? []).map((entry) => ({
          out_col: entry.out,
          upstream_columns: entry.upstream ?? [],
        })),
      ],
    } as never,
    new Map<string, LineageNode>(nodes.map((node) => [node.id, node])),
    makeModel(nodes, [], ['dbo']),
    null,
    undefined,
    undefined,
    row.direction,
    undefined,
    [],
    [],
    row.roots ?? [],
  );
  return result;
}

/** Checks one case expectation against the column-tracer result for that row. */
export function check(row: LineageCase, upstream: readonly FlowColumn[]) {
  const result = run(row, upstream);
  const wanted = row.expect;
  if (wanted.edges)
    expect(result.stagedEdges.map((edge) => edge.from_col)).toEqual(
      wanted.edges,
    );
  if (wanted.invalid) expect(result.invalidRoutes).toEqual(wanted.invalid);
  if (wanted.invalid_kind)
    expect(result.invalidRoutes[0]?.kind).toBe(wanted.invalid_kind);
  if (wanted.reason_contains)
    expect(result.invalidRoutes[0]?.reason).toContain(wanted.reason_contains);
}
