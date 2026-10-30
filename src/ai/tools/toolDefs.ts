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
    modelDescription: 'Search database objects by name or column (substring or regex). Returns object IDs, metadata, per-kind `by_type` counts, `in_user_filter`, and `name_match` (`unique` or `ambiguous` ids for an exact name, in-filter first). When an in-filter search is empty but out-of-filter hits exist, widen `schemas` on the next call. Use lineage_search_ddl to grep SQL bodies.',
    progressLabel: 'Searching database objects…',
  },
  {
    name: 'lineage_get_scope_bundle', title: 'Get Lineage Scope', inputSchema: GetScopeBundleModelSchema, tags: ['lineage', 'lineage-research'], effect: 'scope_store',
    userDescription: 'Get a bounded BFS scope in one call, with optional DDL for all nodes in scope.',
    modelDescription: 'Graph-scope retrieval for multi-object lineage questions. In `nodes[]`, the origin carries `in` (writes INTO it) and `out` (reads FROM it); every node carries `uh`/`dh`, its hop distance upstream/downstream from the origin on the side(s) it was reached (the origin is 0 on both; a node reached on both sides carries both) — read this instead of re-deriving reach from edge order. `edges` are positional [source, target, type]. Set include_ddl=true when the user wants scope logic. Keep lineage_get_object_detail for one object.',
    progressLabel: 'Gathering object dependencies…',
  },
  {
    name: 'lineage_start_exploration', title: 'Start Exploration', inputSchema: StartExplorationProviderInputSchema, tags: ['lineage', 'lineage-engine'], effect: 'session_start',
    userDescription: 'Start an autonomous exploration of database objects for data flow, business rules, or investigations.',
    modelDescription: 'Proposes a hop-by-hop exploration from `origin` for user approval, or revises its pending proposal via `proposalRevision`.',
    progressLabel: 'Starting exploration…',
  },
  {
    name: 'lineage_submit_findings', title: 'Submit Findings', inputSchema: SubmitFindingsModelSchema, tags: ['lineage', 'lineage-engine'], effect: 'hop_commit',
    userDescription: 'Submit analysis of the current node and each neighbor\'s prune or question decision.',
    modelDescription: 'Commits this hop: the focus node\'s analysis, and its neighbor decisions.',
  },
  {
    name: 'lineage_prune_current', title: 'Prune Current Node', inputSchema: PruneCurrentInputSchema, tags: ['lineage', 'lineage-engine'], effect: 'hop_commit',
    userDescription: 'Remove the current irrelevant SQL node reached through a storage carrier.',
    modelDescription: 'Alternative to submit_findings for SQL hops reached via auto-forwarded storage carriers. Hard-cuts the current node and unreachable unvisited descendants when SQL confirms it is irrelevant to the investigation (lists node in `pruned` and cut nodes in `cut_ids`). Rejected if committed analysis or column mappings depend on this node.',
  },
  {
    name: 'lineage_present_result', title: 'Present Lineage View', inputSchema: PresentResultModelSchema, tags: ['lineage-presentation'], effect: 'presentation_commit',
    userDescription: 'Generate a report and visualization for the current lineage scope.',
    modelDescription: 'Authors the presentation layer for the current engine-owned scope: required report sections, node badges, notes, and graph role/color highlights such as source/transform/target. Completed exploration follow-ups may also prune or add nodes. Use this for presentation-only changes.',
    progressLabel: 'Formatting final report…',
  },
  {
    name: 'lineage_get_object_detail', title: 'Get Object Detail', inputSchema: GetObjectDetailInputSchema, tags: ['lineage', 'lineage-research'], effect: 'read',
    userDescription: 'Get full details for a specific database object.',
    modelDescription: 'Primary single-object lookup. Use this when the user asks about one specific object (DDL, columns, direct neighbors). For graph-scope lineage questions, prefer lineage_get_scope_bundle instead of chaining repeated per-node detail calls.',
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
    modelDescription: 'Grep view, procedure and function bodies. Each hit has object, line, matched line, context, `commented: true` when the match sits in a SQL comment, and `enclosing_predicate` with the governing IF/WHILE condition when the match is inside one. `by_object` is the per-object hit count. No matches is `total: 0`; a bad pattern is `invalid_regex` with the repair. Use lineage_search_objects for names.',
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
