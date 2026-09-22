/**
 * The AI tool catalog.
 *
 * @remarks
 * One entry per registered `languageModelTool`, pairing the model-facing name with its
 * single Zod input schema. This is the authoritative, **VS Code-free** list that drives
 * host registration: `registerAiTools` builds a {@link ToolRegistry} from it and binds
 * each entry's handler.
 */
import type { z } from 'zod';
import type { ToolDefinition } from './registry';
import {
  GetContextInputSchema,
  GetScreenStateInputSchema,
  SearchObjectsInputSchema,
  GetScopeBundleModelSchema,
  StartExplorationProviderInputSchema,
  SubmitFindingsModelSchema,
  PresentResultModelSchema,
  GetObjectDetailInputSchema,
  DetectGraphPatternsInputSchema,
  SearchDdlInputSchema,
  GetNeighborColumnsInputSchema,
} from './toolSchemas';

/** Lifecycle effect of a tool invocation after successful validation. */
type ToolEffect = NonNullable<ToolDefinition['effect']>;

/** Canonical user- and model-facing contract for one registered lineage tool. */
export interface ToolContract<TSchema extends z.ZodType = z.ZodType> {
  /** Stable provider-visible tool name. */
  readonly name: string;
  /** Concise text shown to users by the host manifest. */
  readonly userDescription: string;
  /** Selection and behavior guidance sent to language models. */
  readonly modelDescription: string;
  /** Zod source for provider schema generation and boundary validation. */
  readonly inputSchema: TSchema;
  /**
   * Progress label shown while the tool executes. Omitted on tools that run repeatedly inside one
   * user-visible operation (per-hop commits) — a registered tool without a label emits no status
   * update, so the operation-level status stays visible instead of flickering per call.
   */
  readonly progressLabel?: string;
  /** Lifecycle mutation class used for execution serialization. */
  readonly effect: ToolEffect;
  /** Manifest grouping labels retained for registration parity. */
  readonly tags?: readonly string[];
}

/**
 * The canonical tool catalog, in registration order.
 *
 * @remarks
 * The model descriptions mirror the public manifest and are used directly by API adapters.
 * `submit_findings` and `present_result` use model-facing schemas whose runtime dispatch
 * narrows to the strict phase/mode-specific variants.
 */
export const TOOL_DEFS = [
  {
    name: 'lineage_get_context', inputSchema: GetContextInputSchema, tags: ['lineage', 'lineage-research'], effect: 'read',
    userDescription: 'Shows what is currently loaded and visible in the lineage graph.',
    modelDescription: 'Returns the current database context including loaded schemas, stats, and active UI filters.',
    progressLabel: 'Reading graph context…',
  },
  {
    name: 'lineage_search_objects', inputSchema: SearchObjectsInputSchema, tags: ['lineage', 'lineage-research'], effect: 'read',
    userDescription: 'Search for database objects by name or column.',
    modelDescription: 'Search database objects by name or column (substring or regex). Returns object IDs, metadata, per-kind `by_type` counts, and `in_user_filter`. When an in-filter search is empty but out-of-filter hits exist, widen `schemas` on the next call. Use lineage_search_ddl to grep SQL bodies.',
    progressLabel: 'Searching database objects…',
  },
  {
    name: 'lineage_get_scope_bundle', inputSchema: GetScopeBundleModelSchema, tags: ['lineage', 'lineage-research'], effect: 'scope_store',
    userDescription: 'Get a bounded BFS scope in one call, with optional DDL for all nodes in scope.',
    modelDescription: 'Discovery graph-scope retrieval for multi-object lineage questions. In `nodes[]`, the origin carries `in` (writes INTO it) and `out` (reads FROM it); `edges` are positional [source, target, type]. Set include_ddl=true when the user wants scope logic. Keep lineage_get_object_detail for one object.',
    progressLabel: 'Gathering object dependencies…',
  },
  {
    name: 'lineage_start_exploration', inputSchema: StartExplorationProviderInputSchema, tags: ['lineage', 'lineage-engine'], effect: 'session_start',
    userDescription: 'Start an autonomous exploration of database objects for data flow, business rules, or investigations.',
    modelDescription: 'Proposes approval-gated hop-by-hop exploration. Fresh calls require origin, analysisMode, and classification. BB has no target columns; CT traces named targetColumns. Completed follow-ups use supplement:{nodeIds:[...]}.',
    progressLabel: 'Starting exploration…',
  },
  {
    name: 'lineage_submit_findings', inputSchema: SubmitFindingsModelSchema, tags: ['lineage', 'lineage-engine'], effect: 'hop_commit',
    userDescription: 'Submit analysis of the current node and propose next routes in the exploration.',
    modelDescription: 'Submits current focus-node analysis and next-hop route decisions. May prune current-hop neighbors; CT also requires `column_flow`.',
  },
  {
    name: 'lineage_present_result', inputSchema: PresentResultModelSchema, tags: ['lineage-presentation'], effect: 'presentation_commit',
    userDescription: 'Generate a report and visualization for the current lineage scope.',
    modelDescription: 'Authors the presentation layer for the current engine-owned scope: required report sections, node badges, notes, and graph role/color highlights such as source/transform/target. Completed exploration follow-ups may also prune or add nodes. Use this for presentation-only changes.',
    progressLabel: 'Formatting final report…',
  },
  {
    name: 'lineage_get_object_detail', inputSchema: GetObjectDetailInputSchema, tags: ['lineage', 'lineage-research'], effect: 'read',
    userDescription: 'Get full details for a specific database object.',
    modelDescription: 'Primary single-object lookup for discovery and synthesis. Use this when the user asks about one specific object (DDL, columns, direct neighbors). For graph-scope lineage questions, prefer lineage_get_scope_bundle instead of chaining repeated per-node detail calls.',
    progressLabel: 'Fetching object details…',
  },
  {
    name: 'lineage_detect_graph_patterns', inputSchema: DetectGraphPatternsInputSchema, tags: ['lineage', 'lineage-research'], effect: 'read',
    userDescription: 'Find structural patterns like hubs, cycles, or orphans in the graph.',
    modelDescription: 'Analyzes the entire graph for specific structural patterns such as hubs, islands, orphans, longest paths, cycles, or external references.',
    progressLabel: 'Detecting graph patterns…',
  },
  {
    name: 'lineage_search_ddl', inputSchema: SearchDdlInputSchema, tags: ['lineage', 'lineage-research'], effect: 'read',
    userDescription: 'Search SQL body scripts for a text pattern.',
    modelDescription: 'Grep view, procedure and function bodies. Each hit has object, line, matched line, context, `commented: true` when the match sits in a SQL comment, and `enclosing_predicate` with the governing IF/WHILE condition when the match is inside one. `by_object` is the per-object hit count. No matches is `total: 0`; a bad pattern is `invalid_regex` with the repair. Use lineage_search_objects for names.',
    progressLabel: 'Searching SQL bodies…',
  },
  {
    name: 'lineage_get_neighbor_columns', inputSchema: GetNeighborColumnsInputSchema, tags: ['lineage'], effect: 'read',
    userDescription: 'Inspect a neighbor\'s columns for pruning decisions during active SM exploration.',
    modelDescription: 'Returns structural metadata (columns, types, nullability, foreign keys) for direct neighbors. DDL text is not returned. Pass neighbor ids only, excluding the focus node itself.',
    progressLabel: 'Inspecting neighbor columns…',
  },
  {
    name: 'lineage_get_screen_state', inputSchema: GetScreenStateInputSchema, tags: ['lineage', 'lineage-research'], effect: 'read',
    userDescription: 'Shows what is currently on screen: active trace, analysis, or applied bookmark.',
    modelDescription: 'Returns what is on screen: active trace, graph analysis, applied bookmark, and view. Optional `ids` recall objects from a stored AI run; optional `filter` lists pruned, open_leads, or stale. Omit input for the screen card.',
    progressLabel: 'Reading screen state…',
  },
] as const satisfies readonly ToolContract[];

/** Closed union of the canonical catalog names used for exhaustive dispatch typing. */
export type ToolName = (typeof TOOL_DEFS)[number]['name'];
