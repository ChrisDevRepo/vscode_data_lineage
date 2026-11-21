import type { ColumnEdge, SmNodeState, SmState } from '../sm/smTypes';
import type { AIViewMetadata } from '../../engine/projectStore';

/** Canonical bounded BFS captured by `lineage_get_scope_bundle` for one host turn. */
export interface DiscoveryScopeArtifact {
  /**
   * Epoch of the host turn that captured (or, for a preview, re-armed) this scope; a consumer that
   * renders it requires the live turn's epoch, and discovery tells its own walk from an earlier
   * one.
   */
  readonly turnEpoch: number;
  /** Canonical id of the node the BFS walked from. */
  readonly origin: string;
  readonly direction: 'upstream' | 'downstream' | 'bidirectional';
  /** Ids of every node in the scope, origin included. */
  readonly nodeIds: readonly string[];
  /** Tuple representation of the scope's edges: [sourceNodeId, targetNodeId, edgeType]. */
  readonly edges: readonly [string, string, string][];
}

/** Validated presentation committed by either a bounded preview or SM synthesis. */
export interface PresentationArtifact {
  readonly name: string;
  /** Canonical node ids rendered in the view. */
  readonly nodeIds: readonly string[];
  /** Validated AI view metadata; `summary` and `description` are always present. */
  readonly aiMetadata: AIViewMetadata & { readonly summary: string; readonly description: string };
  readonly runId?: string;
  /** Serialized engine state captured at present time; absent when no engine was live. */
  readonly checkpoint?: SmState;
}

/**
 * The grounded findings of an AI session, serialized for visualization; populated by `ColumnTrace`
 * or `Blackboard` modes and consumed by `present_result` synthesis to build the interactive report.
 */
export interface ResultGraph {
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
   * Engine-assembled markdown body from `present_result` (engine output, not AI input) — carries
   * the full synthesized description, not just topology.
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
   * AI-supplied report sections from `present_result.input.sections[]` with evidence references
   * already expanded. Ids number the captured archive in slot order, so a later capture could
   * renumber them before an amendment retains the section.
   */
  sections?: Array<{ label: string; node_ids?: string[]; text?: string }>;
  /**
   * The `explorationRunId` that authored {@link sections} — distinguishes sections a later render
   * may retain from ones left over from a previous run.
   */
  sectionsRunId?: string;
  /** Column lineage chain from a CT session. */
  columnAspect?: { edges: ColumnEdge[] };
}

/**
 * Schema version of the AI output-templates contract (`aiOutputTemplates.yaml`). A custom overlay
 * (`ai.outputTemplateFile`) is honoured only when its `schemaVersion` equals this. Bump whenever the
 * shipped file adds, removes, renames or retypes a key or field; a wording change never bumps. On
 * mismatch the overlay is skipped with an Output-channel warning; there is no migration code.
 */
export const AI_TEMPLATE_SCHEMA_VERSION = 3;

/**
 * Markdown-formatted instructions for AI report generation, loaded from
 * `assets/aiOutputTemplates.yaml` at activation.
 */
export interface AiOutputTemplates {
  /** Discovery-phase chat output: tunes answer length, citation, format; NOT a capture template. */
  discovery_chat: string;
  summary: string;
  /** Instructions for the document heading rendered as `# …` above sections. */
  title: string;
  /** Instructions for the 2-4 sentence intro paragraph before the sections. */
  intro: string;
  /** Instructions for the 1-2 sentence closing rendered after the sections. */
  closing: string;
  highlights: string;
  notes: string;
  /**
   * Business-angle capture rules, fired at ACTIVE phase: govern the body of the section submitted
   * with `angle: 'business'` per hop (meaning, formulas, column renames, ⚠️ invariants,
   * question-relevance evidence). The body arrives at synthesis formatted and is lifted verbatim
   * into a peer entry of `present_result.sections[]`.
   */
  business_capture: string;
  /**
   * Technical-angle capture rules, fired at ACTIVE phase: govern the body of the section submitted
   * with `angle: 'technical'` per hop (verbatim SQL, loading pattern, join types, antipatterns,
   * distribution hints, DDL annotations). Lifted verbatim at synthesis.
   */
  technical_capture: string;
  /**
   * The ⚠️ structural-callout contract, fired at ACTIVE phase on every bodied focus, once per hop
   * beside whichever capture recipes the classification fires. One home for the exposure classes
   * and the one-line form both angles cite.
   */
  structural_callouts: string;
  /**
   * Coverage shared by every fired capture recipe, served once per bodied hop ahead of the
   * recipes so classification `both` does not repeat it per angle.
   */
  shared_capture: string;
  /** Reduced active-phase template for non-bodied origin nodes (Purpose/Columns/Upstream/...). */
  structural_summary: string;
  /**
   * Cross-section depth floor at SYNTHESIS: conditional rendering directives (column-rename tables,
   * LaTeX formulas, code-fenced source guards, numbered state transitions) lifted across every
   * section when the capture material supports them. Always on; conditional by content.
   */
  general: string;
  /**
   * Big-picture ETL closing pattern at SYNTHESIS, TECHNICAL angle only: when all bodied procedures
   * share a load shape (TRUNCATE+INSERT, append, upsert, historization, purge, orchestration), name
   * it once in the closing note. Classification-gated to `technical` and `both`.
   */
  loading_pattern: string;
  /**
   * Column Trace capture rules, fired at ACTIVE phase when CT mode is on (`targetColumns` set):
   * per-hop instructions for filling the `column_flow` provenance record. CT-mode-gated (not on
   * Blackboard sessions) and additive to the classification-gated templates.
   */
  column_trace_capture: string;
}

/** Capture angle whose recipe declares `sections` labels. */
export type AiSectionAngle = 'business' | 'technical';

/**
 * Template key whose recipe declares the section labels of each {@link AiSectionAngle}. Its
 * `sections` field is the single home of the bold labels the angle writes; synthesis serves the
 * active angle's list from it, so a label is never listed twice.
 */
export const AI_SECTION_KEY_BY_ANGLE: Readonly<Record<AiSectionAngle, 'business_capture' | 'technical_capture'>> = {
  business: 'business_capture',
  technical: 'technical_capture',
};

/** Ordered section labels per capture angle, from the optional `sections` field of the recipes. */
export type AiOutputSections = Readonly<Partial<Record<AiSectionAngle, readonly string[]>>>;

/** No declared section labels: a synthesis template carrying the placeholder gets an empty list. */
export const EMPTY_AI_SECTIONS: AiOutputSections = {};

/** Placeholder in the `general` instruction replaced at synthesis by the active angle's labels. */
export const SECTIONS_PLACEHOLDER = '{{sections}}';

/** Loader result: the instruction strings plus the section labels declared beside them. */
export interface AiOutputTemplateSet {
  readonly templates: AiOutputTemplates;
  /** Section labels per capture angle. */
  readonly sections: AiOutputSections;
}

/** Empty default for AI output templates, so a failed or late load cannot break runtime. */
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
  structural_callouts: '',
  shared_capture: '',
  structural_summary: '',
  general: '',
  loading_pattern: '',
  column_trace_capture: '',
};
