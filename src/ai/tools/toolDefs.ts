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
  /** Progress label shown while the tool executes. */
  readonly progressLabel: string;
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
    modelDescription: 'Search database objects by name or column name using substring or regex matching. Returns object IDs and metadata. Each result carries an `in_user_filter` flag — when an in-filter search returns 0 hits but out-of-filter results exist, include that schema in the next search; the active filter is a display preference, not a boundary.',
    progressLabel: 'Searching database objects…',
  },
  {
    name: 'lineage_get_scope_bundle', inputSchema: GetScopeBundleModelSchema, tags: ['lineage', 'lineage-research'], effect: 'scope_store',
    userDescription: 'Get a bounded BFS scope in one call, with optional DDL for all nodes in scope.',
    modelDescription: 'Discovery graph-scope retrieval for multi-object lineage questions. Set upstream_depth and downstream_depth (hops each side): equal values give a symmetric scope, "all" a whole chain, 0 excludes that side. Set include_ddl=true when the user wants scope logic. Keep lineage_get_object_detail for one object.',
    progressLabel: 'Gathering object dependencies…',
  },
  {
    name: 'lineage_start_exploration', inputSchema: StartExplorationProviderInputSchema, tags: ['lineage', 'lineage-engine'], effect: 'session_start',
    userDescription: 'Start an autonomous exploration of database objects for data flow, business rules, or investigations.',
    modelDescription: 'Proposes approval-gated hop-by-hop exploration. Fresh calls require origin, analysisMode, and classification. Choose a symmetric or bidirectional upstream/downstream starting depth, use "all", or omit depth for the reviewed default of 3. BB has no target columns; CT traces named targetColumns. Completed follow-ups use supplement:{nodeIds:[...]}.',
    progressLabel: 'Starting exploration…',
  },
  {
    name: 'lineage_submit_findings', inputSchema: SubmitFindingsModelSchema, tags: ['lineage', 'lineage-engine'], effect: 'hop_commit',
    userDescription: 'Submit analysis of the current node and propose next routes in the exploration.',
    modelDescription: 'Submits current focus-node analysis and next-hop route decisions. BB may prune current-hop neighbors; CT requires `column_flow` and rejects BB prune fields.',
    progressLabel: 'Saving findings…',
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
    modelDescription: 'Primary single-object lookup for discovery and synthesis. Use this when the user asks about one specific object (DDL, columns, direct neighbors). For graph-scope lineage questions, prefer lineage_get_scope_bundle instead of chaining repeated per-node detail calls. During active SM exploration, use lineage_get_neighbor_columns instead.',
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
    modelDescription: 'Performs a regex search across view, procedure, and function DDL bodies. Returns matching lines with context.',
    progressLabel: 'Searching SQL bodies…',
  },
  {
    name: 'lineage_get_neighbor_columns', inputSchema: GetNeighborColumnsInputSchema, tags: ['lineage'], effect: 'read',
    userDescription: 'Inspect a neighbor\'s columns for pruning decisions during active SM exploration.',
    modelDescription: 'Returns structural metadata (columns, types, nullability, foreign keys) for direct neighbors. Use this exclusively when the focus DDL is opaque (e.g., \'SELECT *\' or ambiguous joins) and the column names are hidden. For explicit DDL, derive the structure directly from the text instead. NEVER returns DDL bodies. Pass neighbor ids only, excluding the focus node itself.',
    progressLabel: 'Inspecting neighbor columns…',
  },
] as const satisfies readonly ToolContract[];

/** Closed union of the canonical catalog names used for exhaustive dispatch typing. */
export type ToolName = (typeof TOOL_DEFS)[number]['name'];
