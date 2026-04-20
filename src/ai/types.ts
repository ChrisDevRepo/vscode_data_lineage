/**
 * Categorizes nodes based on their semantic relevance to an AI-driven lineage investigation.
 * 
 * @remarks
 * Used for both graph visualization (React Flow) and AI reasoning (BFS/DFS).
 * - `trace`: Part of the active lineage path.
 * - `pass`: Node was traversed but deemed less relevant.
 * - `prune`: Node and its descendants were explicitly excluded.
 * - `noted`: Node has a high-signal business annotation.
 * - `bridge`: Structural node connecting critical parts of the graph.
 * - `origin`: The starting point of the lineage investigation.
 * - `relevant`: Node contains important semantic context.
 */
export type NodeRole = 'trace' | 'pass' | 'prune' | 'noted' | 'bridge' | 'origin' | 'relevant';

/** 
 * Represents the grounded findings of an AI session, serialized for visualization.
 * 
 * @remarks
 * This structure is typically populated by `ColumnTrace` or `Blackboard` modes and
 * consumed by the `enrich_view` synthesis logic to generate the final interactive report.
 */
export interface ResultGraph {
  /** IDs of nodes that are part of the result scope. */
  nodeIds: string[];
  /** Tuple representation of edges: [sourceNodeId, targetNodeId, edgeType]. */
  edges: [string, string, string][];
  /** Maps node IDs to their semantic roles in the result set. */
  verdicts: Record<string, NodeRole>;
  /** The exploration mode that generated this graph. */
  source: 'column_trace' | 'blackboard';
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
  /** Instructions for generating the detailed technical description. */
  description: string;
  /** Instructions for grouping nodes into logical sections. */
  sections: string;
  /** Instructions for the 1-2 sentence closing rendered after the sections. */
  closing: string;
  /** Instructions for identifying critical highlights and takeaways. */
  highlights: string;
  /** Instructions for extracting and formatting node-level notes. */
  notes: string;
  /**
   * AI-inferred SP loading pattern (reload / append / upsert / historization
   * / purge / orchestration). SP-only; omitted for views and UDFs. Rendered
   * inside the metadata band above the sections. Synthesis stage.
   */
  loading_pattern: string;
  /**
   * Business-angle capture rules — shown at ACTIVE phase so the AI writes
   * business meaning, formulas, column renames, and question-relevance
   * evidence into `detail_analysis` per hop.
   */
  business_capture: string;
  /**
   * Business-angle render rules — shown at SYNTHESIS phase. Tells the AI
   * how the business content captured at ACTIVE becomes the main body of
   * each section's text (no subheading).
   */
  business_subsection: string;
  /**
   * Technical-angle capture rules — shown at ACTIVE phase so the AI writes
   * SQL snippets, LaTeX formulas, observations, join types, antipatterns,
   * and distribution hints into `detail_analysis` per hop.
   */
  technical_capture: string;
  /**
   * Technical-angle render rules — shown at SYNTHESIS phase when the
   * resolved classification is `technical` or `both`. Tells the AI how to
   * emit a `#### Technical` block below the business body.
   */
  technical_subsection: string;
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
  description: '',
  sections: '',
  closing: '',
  highlights: '',
  notes: '',
  loading_pattern: '',
  business_capture: '',
  business_subsection: '',
  technical_capture: '',
  technical_subsection: '',
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
