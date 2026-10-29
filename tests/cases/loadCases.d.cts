/** One semantic reply of a walk hop; short object names, no wire fields. */
export interface WalkDecision {
  /** CT: one entry per output column at the focus; `to` names the written object at a procedure. */
  map?: Array<{ col: string; to?: string; from: Array<{ node: string; col: string; transforms?: string[] }> }>;
  /** Neighbors that receive a question. */
  ask?: string[];
  /** Neighbors voted off the answer. */
  prune?: string[];
}

/** A reply the backend must reject: the rejection code, the offending field path and the issue code at it. */
export interface WalkRefusal extends WalkDecision {
  kind: string;
  field: string;
  issue: string;
}

/** The hop the walk reaches at `at`, in order; `refuse` is submitted first and `decide` is the correction or the plain reply. */
export interface WalkHop {
  at: string;
  refuse?: WalkRefusal;
  decide: WalkDecision;
}

/** A `contract: walk` row: a synthetic graph, an exploration init, the scripted decisions per hop and the independent final graph. */
export interface WalkCase extends CatalogCase {
  contract: 'walk';
  mode: 'bb' | 'ct';
  direction: 'upstream' | 'downstream';
  graph: {
    origin: string;
    nodes: Record<string, 'table' | 'view' | 'procedure'>;
    /** Columns of every table and view; a procedure carries none. */
    columns: string[];
    /** `[source, target]`: the target reads the source, or a procedure source writes the target. */
    edges: Array<[string, string]>;
    excluded?: string[];
    levels?: number;
  };
  hops: WalkHop[];
  expect: { nodes: string[]; edges: Array<[string, string]>; column_edges?: Array<[string, string, string, string]> };
}

export interface CatalogCase {
  id: string;
  contract?: 'stored-arrival' | 'self-prune' | 'walk';
  story?: string;
  runners?: string[];
  prompt?: string;
  command?: string;
  dacpac?: string;
  expect?: { graph?: boolean; terminal?: string; phase?: string };
}

/** Rows from tests/cases/lineage-cases.yaml tagged for one runner. */
export function loadCases(runner?: string): CatalogCase[];
