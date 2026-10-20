/** The AI tool catalog. */
import type { z } from 'zod';
import type { ToolDefinition } from './registry';
import { EXTERNAL_TOOL_NAMES } from './toolPolicy';
import {
  GetContextInputSchema,
  GetScreenStateInputSchema,
  SearchObjectsInputSchema,
  GetScopeBundleModelSchema,
  StartExplorationProviderInputSchema,
  SubmitFindingsModelSchema,
  PruneCurrentInputSchema,
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
  /** Human-readable display name: VS Code manifest `displayName`. */
  readonly title: string;
  /** Concise text shown to users by the host manifest. */
  readonly userDescription: string;
  /** Selection and behavior guidance sent to language models. */
  readonly modelDescription: string;
  /** Zod source for provider schema generation and boundary validation. */
  readonly inputSchema: TSchema;
  /** Progress label shown while the tool executes. Omitted on tools that run repeatedly inside one user-visible operation (per-hop commits) — a registered tool without a label emits no status update, so the operation-level status stays visible instead of flickering per call. */
  readonly progressLabel?: string;
  /** Lifecycle mutation class used for execution serialization. */
  readonly effect: ToolEffect;
  /** Manifest grouping labels retained for registration parity. */
  readonly tags?: readonly string[];
}

/** The canonical tool catalog, in registration order. */
export const TOOL_DEFS = [
  {
    name: 'lineage_get_context', title: 'Get Lineage Context', inputSchema: GetContextInputSchema, tags: ['lineage', 'lineage-research'], effect: 'read',
    userDescription: 'Shows what is currently loaded and visible in the lineage graph.',
    modelDescription: 'Returns the current database context including loaded schemas, stats, and active UI filters.',
    progressLabel: 'Reading graph context…',
  },
  {
    name: 'lineage_search_objects', title: 'Search Objects', inputSchema: SearchObjectsInputSchema, tags: ['lineage', 'lineage-research'], effect: 'read',
    userDescription: 'Search for database objects by name or column.',
    modelDescription: 'Search database objects by name or column (substring or regex). Returns object IDs, metadata, `by_type` counts, `in_user_filter`, and `name_match` (`unique` or `ambiguous` IDs, in-filter first). If an in-filter search returns no matches, widen `schemas` on subsequent calls. Use `lineage_search_ddl` to search SQL text.',
    progressLabel: 'Searching database objects…',
  },
  {
    name: 'lineage_get_scope_bundle', title: 'Get Lineage Scope', inputSchema: GetScopeBundleModelSchema, tags: ['lineage', 'lineage-research'], effect: 'scope_store',
    userDescription: 'Get a bounded BFS scope in one call, with optional DDL for all nodes in scope.',
    modelDescription: 'Retrieves bounded graph scope for multi-object lineage inquiries. In `nodes[]`, the origin separates neighbors into `in` (upstream, writes into origin) and `out` (downstream, reads from origin); each node specifies `uh` and `dh` distances from the origin (0 for origin itself). `edges` lists [source, target, type] tuples. Set `include_ddl` to include object definitions. Use `lineage_get_object_detail` for single-object queries.',
    progressLabel: 'Gathering object dependencies…',
  },
  {
    name: 'lineage_start_exploration', title: 'Start Exploration', inputSchema: StartExplorationProviderInputSchema, tags: ['lineage', 'lineage-engine'], effect: 'session_start',
    userDescription: 'Start an autonomous exploration of database objects for data flow, business rules, or investigations.',
    modelDescription: 'Proposes an autonomous hop-by-hop exploration for user approval: a new trace from `origin`, a revision via `proposalRevision`, or a `supplement` of named objects after completed exploration.',
    progressLabel: 'Starting exploration…',
  },
  {
    name: 'lineage_submit_findings', title: 'Submit Findings', inputSchema: SubmitFindingsModelSchema, tags: ['lineage', 'lineage-engine'], effect: 'hop_commit',
    userDescription: 'Submit analysis of the current node and each neighbor\'s prune or question decision.',
    modelDescription: 'Submits or repairs the focus node\'s SQL findings and neighbor decisions.',
  },
  {
    name: 'lineage_prune_current', title: 'Prune Current Node', inputSchema: PruneCurrentInputSchema, tags: ['lineage', 'lineage-engine'], effect: 'hop_commit',
    userDescription: 'Remove the current irrelevant SQL node reached through a storage carrier.',
    modelDescription: 'Alternative to submit_findings for SQL hops reached via auto-forwarded storage carriers. Hard-cuts the current node and unreachable unvisited descendants when SQL confirms it is irrelevant to the investigation (lists node in `pruned` and cut nodes in `cut_ids`). Rejected if committed analysis or column mappings depend on this node.',
  },
  {
    name: 'lineage_present_result', title: 'Present Lineage View', inputSchema: PresentResultModelSchema, tags: ['lineage-presentation'], effect: 'presentation_commit',
    userDescription: 'Generate a report and visualization for the current lineage scope.',
    modelDescription: 'Renders the final report and diagram in the lineage panel: structured report sections (labels map to node badges), notes, and color highlights (`source`, `transform`, `target`). Follow-up updates can modify text, prune (`prune_node_ids`), or reveal nodes (`add_node_ids`).',
    progressLabel: 'Formatting final report…',
  },
  {
    name: 'lineage_get_object_detail', title: 'Get Object Detail', inputSchema: GetObjectDetailInputSchema, tags: ['lineage', 'lineage-research'], effect: 'read',
    userDescription: 'Get full details for a specific database object.',
    modelDescription: 'Fetches full definition, column metadata, and direct neighbors for a single object. For multi-object inquiries, use `lineage_get_scope_bundle`.',
    progressLabel: 'Fetching object details…',
  },
  {
    name: 'lineage_detect_graph_patterns', title: 'Detect Graph Patterns', inputSchema: DetectGraphPatternsInputSchema, tags: ['lineage', 'lineage-research'], effect: 'read',
    userDescription: 'Find structural patterns like hubs, cycles, or orphans in the graph.',
    modelDescription: 'Analyzes the entire graph for specific structural patterns such as hubs, islands, orphans, longest paths, cycles, or external references. Graph edges point upstream to downstream: inDegree counts incoming links from objects this node depends on; outDegree counts outgoing links to objects that depend on this node. Island results exclude singletons and components above the effective size limit; orphan results identify isolated nodes.',
    progressLabel: 'Detecting graph patterns…',
  },
  {
    name: 'lineage_search_ddl', title: 'Search DDL', inputSchema: SearchDdlInputSchema, tags: ['lineage', 'lineage-research'], effect: 'read',
    userDescription: 'Search SQL body scripts for a text pattern.',
    modelDescription: 'Searches view, procedure, and function bodies via regex. Returns matching lines with object ID, line number, matched text, surrounding context, `commented` (when inside SQL comment), and `enclosing_predicate` (when governed by IF/WHILE). `by_object` summarizes counts. Use `lineage_search_objects` for object names.',
    progressLabel: 'Searching SQL bodies…',
  },
  {
    name: 'lineage_get_neighbor_columns', title: 'Get Neighbor Columns', inputSchema: GetNeighborColumnsInputSchema, tags: ['lineage'], effect: 'read',
    userDescription: 'Inspect a neighbor\'s columns for pruning decisions during an approved deep analysis.',
    modelDescription: 'Column metadata (types, keys) for direct neighbors of the focus, without SQL. Use it only when the focus SQL hides which neighbor columns it reads (SELECT *, dynamic SQL); a neighbor shown without cols needs no call.',
    progressLabel: 'Inspecting neighbor columns…',
  },
  {
    name: 'lineage_get_screen_state', title: 'Get Screen State', inputSchema: GetScreenStateInputSchema, tags: ['lineage', 'lineage-research'], effect: 'read',
    userDescription: 'Shows what is currently on screen: active trace, analysis, or applied bookmark.',
    modelDescription: 'Returns what is on screen: active trace, graph analysis, applied bookmark, and view. Optional `ids` recall objects from a stored AI run; optional `filter` lists pruned, open_leads, or stale. `ids` and `filter` need a stored run; without one they answer `no_run_memory`. Omit input for the screen card.',
    progressLabel: 'Reading screen state…',
  },
] as const satisfies readonly ToolContract[];

/** Closed union of the canonical catalog names used for exhaustive dispatch typing. */
export type ToolName = (typeof TOOL_DEFS)[number]['name'];

/** The catalog as served to callers without a chat turn (`vscode.lm` and the generated `languageModelTools` manifest): the tools the `external` policy stage allows, in catalog order, each with its input contract. */
export const EXTERNAL_TOOL_DEFS: readonly ToolContract[] = (TOOL_DEFS as readonly ToolContract[])
  .filter(def => EXTERNAL_TOOL_NAMES.has(def.name));
