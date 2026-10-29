/** One semantic reply of a walk hop; short object names, no wire fields. */
export interface WalkDecision {
  /** CT: one entry per output column at the focus; `to` names the written object at a procedure. */
  map?: Array<{ col: string; to?: string; from: Array<{ node: string; col: string; transforms?: string[] }> }>;
  /** Neighbors that receive a question. */
  ask?: string[];
  /** Neighbors voted off the answer. */
  prune?: string[];
}

/** How a refused reply is malformed on the wire: tool-call notation inside the text of `field`, `field` delivered as cut-off JSON text, or plain text with no tool call at all. */
export type WalkWire = 'notation' | 'cut_off_json' | 'text_only';

/** A reply the backend must reject: the rejection code, the offending field path and the issue code at it. Without `wire` the reply is well formed and the decision itself is refused. */
export interface WalkRefusal extends WalkDecision {
  kind: string;
  field: string;
  issue: string;
  wire?: WalkWire;
}

/** The hop the walk reaches at `at`, in order; `refuse` is submitted first and `decide` is the correction or the plain reply. */
export interface WalkHop {
  at: string;
  /** The mode the hop is served in; a BB row expects `bb` at every hop, a CT row states it where the engine hands over a BB hop. */
  mode?: 'bb' | 'ct';
  /** The qualified column endpoints the hop's column tasks start from, with the side of the trace each one continues. */
  arrives?: Array<{ node: string; col: string; side: 'upstream' | 'downstream' }>;
  refuse?: WalkRefusal;
  decide: WalkDecision;
}

/** A `contract: walk` row: a synthetic graph, an exploration init, the scripted decisions per hop and the independent final graph. */
export interface WalkCase extends CatalogCase {
  contract: 'walk';
  mode: 'bb' | 'ct';
  direction: 'upstream' | 'downstream' | 'bidirectional';
  graph: {
    origin: string;
    nodes: Record<string, 'table' | 'view' | 'procedure'>;
    /** Columns of every table and view, and the traced columns at the origin; a procedure carries none. */
    columns: string[];
    /** Declared columns of single objects that differ from `columns`. */
    node_columns?: Record<string, string[]>;
    /** Objects the user passes through: the AI does not analyze them. */
    pass?: string[];
    /** `[source, target]`: the target reads the source, or a procedure source writes the target. */
    edges: Array<[string, string]>;
    excluded?: string[];
    levels?: number;
  };
  hops: WalkHop[];
  expect: { nodes: string[]; edges: Array<[string, string]>; column_edges?: Array<[string, string, string, string]>;
    /** Objects whose follow-up question the exploration keeps without visiting them. */
    deferred?: string[] };
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
