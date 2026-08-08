import type { ColumnEdge, SmNodeState } from '../sm/smTypes';
import type { AIViewMetadata } from '../../engine/projectStore';

/** Canonical bounded BFS captured by `lineage_get_scope_bundle` for one host turn. */
export interface DiscoveryScopeArtifact {
  readonly turnEpoch: number;
  readonly origin: string;
  readonly direction: 'upstream' | 'downstream' | 'bidirectional';
  readonly nodeIds: readonly string[];
  readonly edges: readonly [string, string, string][];
}

/** Validated presentation committed by either a bounded preview or SM synthesis. */
export interface PresentationArtifact {
  readonly name: string;
  readonly nodeIds: readonly string[];
  readonly aiMetadata: AIViewMetadata & { readonly summary: string; readonly description: string };
}

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
  /** The exploration mode and origin context that generated this graph. */
  source: string;
  /** The starting node ID of the exploration; used for topological sorting. */
  originNodeId?: string;
  /** AI-authored node captions from the latest `present_result.notes[]`. */
  notes?: Array<{ nodeId: string; summary: string }>;
  /** AI-suggested grouping of nodes into narrative sections. */
  suggested_sections?: Array<{ label: string; node_ids: string[] }>;
  /** Engine-owned lifecycle state for nodes; detail slots are content only. */
  node_states?: SmNodeState[];
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
  /** AI-supplied report sections from `present_result.input.sections[]`. */
  sections?: Array<{ label: string; node_ids?: string[]; text?: string }>;
  /**
   * Column lineage chain from a CT session, serialized into AI metadata for React canvas
   * rendering. `ctPrunedNodeIds` identifies visited nodes that contributed no flow edges.
   */
  columnAspect?: { edges: ColumnEdge[]; ctPrunedNodeIds: string[] };
}

/**
 * Schema version of the AI output-templates contract (the `aiOutputTemplates.yaml` structure).
 *
 * @remarks
 * The single source of truth for template-structure compatibility. The built-in YAML carries a
 * matching `schemaVersion`; a user's custom overlay (`ai.outputTemplateFile`) is honoured only when
 * its `schemaVersion` equals this. **Bump this whenever the template structure changes** (a key
 * renamed/removed, or the `instruction` shape changed) so an out-of-date custom YAML is rejected with
 * a clear Output-channel warning instead of being silently mis-applied. Additive-only changes (a new
 * optional key that older YAML simply lacks) do NOT require a bump — the overlay tolerates absent keys.
 */
export const AI_TEMPLATE_SCHEMA_VERSION = 1;

/**
 * Collection of Markdown-formatted instructions for AI report generation.
 *
 * @remarks
 * These templates are loaded from `assets/aiOutputTemplates.yaml` during extension activation
 * and guide the AI in synthesizing its findings into a structured, user-friendly report.
 */
export interface AiOutputTemplates {
  /**
   * Discovery-phase chat output — editable via the YAML overlay for tuning
   * answer length, citation discipline, single-vs-balanced format, no-padding
   * rule, and the biz / tech / math reference shapes used when writing chat
   * prose. NOT a capture template; full angle templates ship only after SM
   * gate approval.
   */
  discovery_chat: string;
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
  /**
   * Cross-section depth floor at SYNTHESIS. Conditional rendering directives
   * (column-rename tables, LaTeX formulas, code-fenced source guards, numbered
   * state transitions) lifted across every section when the underlying capture
   * material supports them. Always-on at synthesis; conditional-by-content.
   */
  general: string;
  /**
   * Big-picture ETL closing pattern at SYNTHESIS — TECHNICAL angle only.
   * When all bodied procedures share a load shape (TRUNCATE+INSERT, append,
   * upsert, historization, purge, orchestration), name it once in the closing
   * note. Classification-gated to `technical` and `both`.
   */
  loading_pattern: string;
  /**
   * Column Trace capture rules — fired at ACTIVE phase when CT mode is on (`targetColumns` set).
   * Provides per-hop instructions for filling the `column_flow` JSON provenance record.
   * CT-mode-gated — does not fire on Blackboard sessions without column targets.
   * Additive alongside classification-gated templates (business_capture / technical_capture).
   */
  column_trace_capture: string;
}

/**
 * Default empty state for AI output templates.
 *
 * @remarks
 * Prevents runtime errors if template loading fails or is delayed.
 */
export const EMPTY_AI_TEMPLATES: AiOutputTemplates = {
  discovery_chat: '',
  summary: '',
  title: '',
  intro: '',
  closing: '',
  highlights: '',
  notes: '',
  business_capture: '',
  technical_capture: '',
  structural_summary: '',
  general: '',
  loading_pattern: '',
  column_trace_capture: '',
};
