/**
 * Categorizes nodes based on their semantic relevance to an AI-driven lineage investigation.
 * 
 * @remarks
 * Used for both graph visualization (React Flow) and AI reasoning (BFS/DFS).
 * - `trace`: Part of the active lineage path.
 * - `pass`: Node was traversed but deemed a non-critical passthrough.
 * - `prune`: Node and its descendants were explicitly excluded.
 * - `noted`: Node has a high-signal business annotation.
 * - `bridge`: Structural node connecting critical parts of the graph.
 * - `origin`: The starting point of the lineage investigation.
 */
export type NodeRole = 'trace' | 'pass' | 'prune' | 'noted' | 'bridge' | 'origin';

/** 
 * Represents the grounded findings of an AI session, serialized for visualization.
 * 
 * @remarks
 * This structure is typically populated by `ColumnTrace` or `Blackboard` modes and
 * consumed by the `present_result` synthesis logic to generate the final interactive report.
 */
export interface ResultGraph {
  /** IDs of nodes that are part of the result scope. */
  nodeIds: string[];
  /** Tuple representation of edges: [sourceNodeId, targetNodeId, edgeType]. */
  edges: [string, string, string][];
  /** Maps node IDs to their semantic roles in the result set. */
  verdicts: Record<string, NodeRole>;
  /** The exploration mode and origin context that generated this graph. */
  source: string;
  /** The starting node ID of the exploration; used for topological sorting. */
  originNodeId?: string;
  /** Summary notes linked to specific nodes for auto-populating reports. */
  notes?: Array<{ nodeId: string; summary: string }>;
  /** AI-suggested UI labels (badges) for specific nodes. */
  suggested_labels?: Array<{ node_id: string; text: string }>;
  /** AI-suggested descriptive text (notes) for specific nodes. */
  suggested_notes?: Array<{ node_id: string; text: string }>;
  /** AI-suggested grouping of nodes into narrative sections. */
  suggested_sections?: Array<{ label: string; node_ids: string[] }>;
  /**
   * Engine-assembled markdown body produced by `present_result` (engine output, not AI input).
   * Populated by the tool handler from `orderAndAssemble()` output so `GET /session/:id/state`
   * carries the full synthesized description, not just topology + suggested_* fields.
   */
  description?: string;
  /** AI-supplied one-line digest from `present_result.input.summary`. */
  summary?: string;
  /** AI-supplied document heading from `present_result.input.title`. */
  title?: string;
  /** AI-supplied context paragraph from `present_result.input.intro`. */
  intro?: string;
  /** AI-supplied closing note from `present_result.input.closing`. */
  closing?: string;
  /**
   * AI-supplied report sections from `present_result.input.sections[]`. Each carries the
   * verbatim section body lifted from per-node detail-memory at synthesis.
   */
  sections?: Array<{ label: string; node_ids?: string[]; text: string }>;
}

/** 
 * Collection of Markdown-formatted instructions for AI report generation.
 * 
 * @remarks
 * These templates are loaded from `assets/aiOutputTemplates.yaml` during extension activation
 * and guide the AI in synthesizing its findings into a structured, user-friendly report.
 */
export interface AiOutputTemplates {
  /** Instructions for generating the high-level summary. */
  summary: string;
  /** Instructions for the document heading rendered as `# …` above sections. */
  title: string;
  /** Instructions for the 2-4 sentence intro paragraph before the sections. */
  intro: string;
  /** Instructions for the 1-2 sentence closing rendered after the sections. */
  closing: string;
  /** Instructions for identifying critical highlights and takeaways. */
  highlights: string;
  /** Instructions for extracting and formatting node-level notes. */
  notes: string;
  /**
   * Business-angle capture rules — fired at ACTIVE phase. Governs the body
   * of the section the AI submits with `angle: 'business'` per hop: meaning,
   * formulas, column renames, ⚠️ invariants, question-relevance evidence.
   * The section body arrives at synthesis already formatted and is lifted
   * verbatim into a peer entry of `present_result.sections[]`.
   */
  business_capture: string;
  /**
   * Technical-angle capture rules — fired at ACTIVE phase. Governs the body
   * of the section the AI submits with `angle: 'technical'` per hop:
   * verbatim SQL snippets, loading pattern, join types, antipatterns,
   * distribution hints, DDL annotations. The section body arrives at
   * synthesis already formatted and is lifted verbatim.
   */
  technical_capture: string;
  /** Reduced active-phase template for non-bodied origin nodes (Purpose/Columns/Upstream/Downstream/Grain). */
  structural_summary: string;
}

/**
 * Default empty state for AI output templates.
 *
 * @remarks
 * Prevents runtime errors if template loading fails or is delayed.
 */
export const EMPTY_AI_TEMPLATES: AiOutputTemplates = {
  summary: '',
  title: '',
  intro: '',
  closing: '',
  highlights: '',
  notes: '',
  business_capture: '',
  technical_capture: '',
  structural_summary: '',
};

/** 
 * A high-level, human-readable summary of an active AI session's state.
 * 
 * @remarks
 * Primarily used for logging, telemetry, and updating VS Code UI elements
 * (like the Status Bar or Chat Participant metadata).
 */
export interface SessionSummary {
  /** Unique session identifier. */
  id: string;
  /** The name of the active project, if any. */
  projectName: string | null;
  /** Total number of nodes in the current database model. */
  modelNodes: number;
  /** Number of nodes explored by the AI in the current session. */
  visitedNodes: number;
  /** Percentage of the total model that has been explored. */
  coveragePct: number;
  /** Total number of hops (visits) performed by the AI. */
  hopCount: number;
}
