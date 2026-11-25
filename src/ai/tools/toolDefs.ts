/**
 * The AI tool catalog: one entry per lineage tool, pairing the model-facing name with its single
 * Zod input schema. The authoritative **VS Code-free** list that drives `buildAiToolRegistry`,
 * which binds each handler.
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
  GetTraceInputSchema,
  GetPathInputSchema,
  CreateGraphPreviewInputSchema,
} from './toolSchemas';

/** Lifecycle effect of a tool invocation after successful validation. */
type ToolEffect = NonNullable<ToolDefinition['effect']>;

/** Canonical user- and model-facing contract for one registered lineage tool. */
export interface ToolContract<TSchema extends z.ZodType = z.ZodType> {
  /** Stable provider-visible tool name. */
  readonly name: string;
  /** Selection and behavior guidance sent to language models. */
  readonly modelDescription: string;
  /** Zod source for provider schema generation and boundary validation. */
  readonly inputSchema: TSchema;
  /**
   * Progress label shown while the tool executes. Omitted on tools that run repeatedly inside one
   * user-visible operation (per-hop commits): a tool without a label emits no status update, so the
   * operation-level status stays visible instead of flickering per call.
   */
  readonly progressLabel?: string;
  /** Lifecycle mutation class used for execution serialization. */
  readonly effect: ToolEffect;
}

/**
 * The canonical tool catalog, in registration order. The model descriptions are used directly
 * by API adapters; `submit_findings` and `present_result` use model-facing
 * schemas whose runtime dispatch narrows to the strict phase/mode-specific variants.
 */
export const TOOL_DEFS = [
  {
    name: 'lineage_get_context', inputSchema: GetContextInputSchema, effect: 'read',
    modelDescription: 'Returns the current database context including loaded schemas, stats, and active UI filters.',
    progressLabel: 'Reading graph context…',
  },
  {
    name: 'lineage_search_objects', inputSchema: SearchObjectsInputSchema, effect: 'read',
    modelDescription: 'Search database objects by name (substring or regex) or by column (substring only). Returns object IDs, metadata, per-kind `by_type` counts, `in_user_filter`, and `name_match` `{status: unique|ambiguous, ids}` for an exact name.',
    progressLabel: 'Searching database objects…',
  },
  {
    name: 'lineage_get_scope_bundle', inputSchema: GetScopeBundleModelSchema, effect: 'scope_store',
    modelDescription: 'Graph-scope retrieval for multi-object lineage questions. In `nodes[]`, the origin carries `in` (upstream neighbors) and `out` (downstream neighbors), each with edge verb `e`; every node carries `uh`/`dh`, its hop distance upstream/downstream from the origin on the side(s) it was reached (the origin is 0 on both; a node reached on both sides carries both) — read this instead of re-deriving reach from edge order. `edges` are positional [source, target, type]. Keep lineage_get_object_detail for one object.',
    progressLabel: 'Gathering object dependencies…',
  },
  {
    name: 'lineage_start_exploration', inputSchema: StartExplorationProviderInputSchema, effect: 'session_start',
    modelDescription: 'Proposes a hop-by-hop exploration for the user to approve: a fresh one from origin, or a supplement of named objects after a completed exploration.',
    progressLabel: 'Starting exploration…',
  },
  {
    name: 'lineage_submit_findings', inputSchema: SubmitFindingsModelSchema, effect: 'hop_commit',
    modelDescription: 'Commits this hop: the focus node\'s verdict and analysis, and its neighbor decisions.',
  },
  {
    name: 'lineage_present_result', inputSchema: PresentResultModelSchema, effect: 'presentation_commit',
    modelDescription: 'Authors the presentation layer for the current engine-owned scope: required report sections, node badges, notes, and graph role/color highlights such as source/transform/target. Completed exploration follow-ups may also prune or add nodes. Use this for presentation-only changes.',
    progressLabel: 'Formatting final report…',
  },
  {
    name: 'lineage_get_object_detail', inputSchema: GetObjectDetailInputSchema, effect: 'read',
    modelDescription: 'Primary single-object lookup. Use this when the user asks about one specific object (DDL, columns, direct neighbors).',
    progressLabel: 'Fetching object details…',
  },
  {
    name: 'lineage_detect_graph_patterns', inputSchema: DetectGraphPatternsInputSchema, effect: 'read',
    modelDescription: 'Analyzes the entire graph for specific structural patterns such as hubs, islands, orphans, longest paths, cycles, or external references.',
    progressLabel: 'Detecting graph patterns…',
  },
  {
    name: 'lineage_search_ddl', inputSchema: SearchDdlInputSchema, effect: 'read',
    modelDescription: 'Grep view, procedure and function bodies. `by_object` lists each object with its `hits` count and its hits under `matches`. Each hit has line, context, `commented: true` when the match sits in a SQL comment, and `enclosing_predicate` with the governing IF/WHILE condition when the match is inside one. No matches is `total: 0`; a bad pattern is `invalid_regex` with the repair. Use lineage_search_objects for names.',
    progressLabel: 'Searching SQL bodies…',
  },
  {
    name: 'lineage_get_neighbor_columns', inputSchema: GetNeighborColumnsInputSchema, effect: 'read',
    modelDescription: 'Column metadata (types, keys) for direct neighbors of the focus, without SQL. Use it only when the focus SQL hides which neighbor columns it reads (SELECT *, dynamic SQL); a neighbor shown without cols needs no call.',
    progressLabel: 'Inspecting neighbor columns…',
  },
  {
    name: 'lineage_get_screen_state', inputSchema: GetScreenStateInputSchema, effect: 'read',
    modelDescription: 'Returns what is on screen: active trace, graph analysis, applied bookmark, and view. `ids` or `filter` recall the stored run.',
    progressLabel: 'Reading screen state…',
  },
  {
    name: 'lineage_get_trace', inputSchema: GetTraceInputSchema, effect: 'read',
    modelDescription: 'The graph view\'s trace from one object, within the user filter (the whole model when the object is outside it). Each object in `nodes` carries `up`/`down`, the level it was reached at on each side (the origin is 0), and `in_user_filter`; `edges` are positional [source, target, type]. Use lineage_get_path for the route between two objects.',
  },
  {
    name: 'lineage_get_path', inputSchema: GetPathInputSchema, effect: 'read',
    modelDescription: 'The graph view\'s Find Path on the whole model: the shortest directed path between `start` and `end`, tried in both directions. `nodes` in path order with `in_user_filter`, `edges` positional [source, target, type]; `found: false` when neither direction connects them. Use lineage_get_trace for everything around one object.',
  },
  {
    name: 'lineage_create_graph_preview', inputSchema: CreateGraphPreviewInputSchema, effect: 'preview_commit',
    modelDescription: 'Shows the `ids` objects and every edge between them as the AI graph preview in the graph view, optionally styled. Returns the objects and edges shown, `edges` positional [source, target, type]. Use lineage_search_objects for ids.',
  },
] as const satisfies readonly ToolContract[];

/** Closed union of the canonical catalog names used for exhaustive dispatch typing. */
export type ToolName = (typeof TOOL_DEFS)[number]['name'];
