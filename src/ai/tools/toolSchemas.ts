/**
 * Zod input schemas and lightweight runtime validation for the AI tools.
 *
 * Extracted from `tools.ts` so the schema/contract surface lives apart from the retrieval
 * operations. Zero VS Code imports — pure schema definitions. Consumers (`tools.ts`,
 * `toolProvider.ts`, schema unit tests) import directly from this module.
 */
import { z } from 'zod';
import type { ColumnFlowRole } from '../sm/smTypes';

type FieldType = 'string' | 'array' | 'number' | 'object' | 'boolean';

/**
 * Zod schema for `start_exploration` tool input. Parsed at the boundary so malformed
 * payloads (e.g. missing `origin`) produce a structured `missing_field` error instead
 * of crashing `NavigationEngine.init` on `.toLowerCase()` of undefined.
 *
 * @remarks
 * Either `origin` (fresh exploration) or `supplement.nodeIds` (post-synthesis add) must
 * be present. Supplement mode reuses the existing `NavigationEngine` / archive: the
 * supplied node ids are appended to the agenda, run through the SM hop loop, and new
 * `DetailSlot` entries merge into the existing archive. Used by the follow-up phase
 * (see `buildFollowUpPrompt`) for deferred-question continuation.
 */
export const StartExplorationInputSchema = z.object({
  origin: z.string().min(1).optional(),
  question: z.string().optional(),
  targetColumns: z.array(z.string()).optional(),
  direction: z.enum(['upstream', 'downstream', 'bidirectional']).optional(),
  depth: z.coerce.number().int().positive().optional(),
  /** Asymmetric override for upstream traversal depth — only honored when `direction='bidirectional'`. */
  upstream_depth: z.preprocess((val) => {
    if (val === null || val === undefined) return val;
    if (val === 'all') return val;
    const n = Number(val);
    return isNaN(n) ? val : n;
  }, z.union([z.number().int().min(0), z.literal('all')])).nullish(),
  /** Asymmetric override for downstream traversal depth — only honored when `direction='bidirectional'`. */
  downstream_depth: z.preprocess((val) => {
    if (val === null || val === undefined) return val;
    if (val === 'all') return val;
    const n = Number(val);
    return isNaN(n) ? val : n;
  }, z.union([z.number().int().min(0), z.literal('all')])).nullish(),
  depth_enforcement: z.enum(['strict', 'soft', 'silent']).optional(),
  excludeTypes: z.array(z.string()).optional(),
  /**
   * Schemas to drop from the BFS scope (case-insensitive). Honored at scope-build time —
   * any candidate node whose schema matches is excluded. REPLACE semantics: each call
   * wipes prior filter state on the engine; accumulate across refine rounds by re-sending
   * every prior exclusion plus the new one.
   */
  excludeSchemas: z.array(z.string()).optional(),
  /**
   * Specific node ids to drop from the BFS scope (case-insensitive). Cuts the node and
   * its subtree reachable only through it. Use only when the user explicitly says
   * remove / drop / prune / cut. REPLACE semantics — see {@link excludeSchemas}.
   * Every id must already be resolved via `lineage_search_objects` — unknown ids cause
   * the call to reject with `unknown_node_ids`.
   */
  excludeNodeIds: z.array(z.string()).optional(),
  /**
   * Specific node ids the engine keeps in scope but auto-passes (no analysis written,
   * topology preserved so descendants stay reachable). Default interpretation when the
   * user says ignore / skip / don't analyze. REPLACE semantics — see {@link excludeSchemas}.
   * Every id must already be resolved via `lineage_search_objects` — unknown ids cause
   * the call to reject with `unknown_node_ids`.
   */
  passNodeIds: z.array(z.string()).optional(),
  mission_brief: z.string().optional(),
  classification: z.enum(['business', 'technical', 'both']),
  /**
   * Post-synthesis supplement: extend the existing archive with analysis for these
   * additional node ids. Runs through the SM hop loop; slots merge into the existing
   * `AiMemoryManager`. No `origin` needed — the existing exploration is the origin.
   * Fails if no completed engine is attached to the session.
   */
  supplement: z.object({
    nodeIds: z.array(z.string().min(1)).min(1),
  }).optional(),
}).refine(
  (data) => !!data.origin || !!data.supplement,
  { message: "Either 'origin' (fresh exploration) or 'supplement.nodeIds' (post-synthesis add) must be provided." },
);

export type StartExplorationInput = z.infer<typeof StartExplorationInputSchema>;

/**
 * Zod schema for discovery-scoped BFS bundle retrieval.
 *
 * @remarks
 * Used for graph-scope discovery asks where the AI needs one bounded scope in a
 * single call (instead of many per-node detail calls). Optional asymmetric depth
 * is honored only for bidirectional traversals.
 */
export const GetScopeBundleInputSchema = z.object({
  origin: z.string().min(1),
  direction: z.enum(['upstream', 'downstream', 'bidirectional']).optional(),
  depth: z.coerce.number().int().min(0).optional(),
  upstream_depth: z.preprocess((val) => {
    if (val === null || val === undefined) return val;
    if (val === 'all') return val;
    const n = Number(val);
    return isNaN(n) ? val : n;
  }, z.union([z.number().int().min(0), z.literal('all')])).nullish(),
  downstream_depth: z.preprocess((val) => {
    if (val === null || val === undefined) return val;
    if (val === 'all') return val;
    const n = Number(val);
    return isNaN(n) ? val : n;
  }, z.union([z.number().int().min(0), z.literal('all')])).nullish(),
  include_ddl: z.boolean().optional(),
});

export type GetScopeBundleInput = z.infer<typeof GetScopeBundleInputSchema>;

/**
 * Zod schema for one captured section within `submit_findings.sections[]`.
 *
 * @remarks
 * Each fired `*_capture` YAML template produces ONE entry. Angle-vs-classification
 * conformance is enforced at the tool handler boundary
 * (`toolProvider.validateSectionsAgainstClassification`) — the schema accepts any
 * combination here; the handler rejects mismatches against the locked `sess.classification`.
 */
const CapturedSectionSchema = z.object({
  /** Which YAML capture template produced this section. */
  angle: z.enum(['business', 'technical']),
  /** Pre-formatted section body. */
  text: z.string().min(1),
});

const RouteRequestSchema = z.object({
  nodeId: z.string(),
  question: z.string(),
}).strict();

/**
 * CT route request — adds the optional per-target `columns` to track.
 *
 * @remarks
 * `columns` is meaningful only under Column Trace, so it lives here rather than on the
 * shared {@link RouteRequestSchema}. A BB session's `submit_findings` schema therefore
 * never advertises a field the engine would silently ignore.
 */
const CtRouteRequestSchema = RouteRequestSchema.extend({
  columns: z.array(z.string()).optional(),
}).strict();

const ColumnFlowContributorSchema = z.object({
  from_node: z.string(),
  from_col: z.string(),
  role: z.enum(['formula', 'rename', 'case', 'coalesce', 'join_value', 'aggregate', 'filter_only', 'source'] satisfies [ColumnFlowRole, ...ColumnFlowRole[]]),
}).strict();

const ColumnFlowEntrySchema = z.object({
  out_col: z.string(),
  writes_to: z.object({ node: z.string(), col: z.string() }).strict().optional(),
  contributors: z.array(ColumnFlowContributorSchema),
}).strict();

/**
 * Shared `submit_findings` fields across BB and CT modes.
 */
const HopFindingBaseSchema = z.object({
  focus_node_id: z.string(),
  /**
   * One section per fired `*_capture` template. Length 1 (`business` / `technical`
   * classification) or 2 (`both`). BB prune findings may submit length 0.
   */
  sections: z.array(CapturedSectionSchema).max(2),
  // No length cap: summary is prose, and length must never be a hard prose-rejection axis.
  summary: z.string(),
  /**
   * Optional list of neighbors to queue for the next hops. Each entry's
   * `nodeId` must already be a real id you have seen.
   */
  route_requests: z.array(RouteRequestSchema).optional(),
  /** Reserved. Engine owns completion in SM mode. */
  complete: z.boolean().optional(),
  badge_label: z.string().max(50).optional(),
  note_caption: z.string().max(200).optional(),
}).strict();

/**
 * BB-mode submit_findings input.
 *
 * @remarks
 * BB allows prune semantics (`verdict='prune'`, `prune_neighbors`) and does not
 * carry CT-only `column_flow`.
 */
export const SubmitFindingsBbInputSchema = HopFindingBaseSchema.extend({
  verdict: z.enum(['analyze', 'pass', 'prune']),
  prune_neighbors: z.array(z.string()).optional(),
}).strict();

/**
 * CT-mode submit_findings input.
 *
 * @remarks
 * CT is route-or-pass only (`verdict='analyze' | 'pass'`) and requires
 * explicit `column_flow` presence every hop (`[]` = no interaction).
 */
export const SubmitFindingsCtInputSchema = HopFindingBaseSchema.extend({
  verdict: z.enum(['analyze', 'pass']),
  column_flow: z.array(ColumnFlowEntrySchema),
  // CT overrides the shared route_requests with the column-bearing variant.
  route_requests: z.array(CtRouteRequestSchema).optional(),
}).strict();

/**
 * Legacy union export kept for non-dispatched callers/tests.
 */
export const SubmitFindingsInputSchema = z.union([
  SubmitFindingsBbInputSchema,
  SubmitFindingsCtInputSchema,
]);

export type SubmitFindingsBbInput = z.infer<typeof SubmitFindingsBbInputSchema>;
export type SubmitFindingsCtInput = z.infer<typeof SubmitFindingsCtInputSchema>;
export type SubmitFindingsInput = z.infer<typeof SubmitFindingsInputSchema>;

/** Patch-only retry for a held BB finding. Omitted fields retain their held values. */
export const SubmitFindingsBbRepairPatchSchema = z.object({
  repair: z.literal(true),
  route_requests: z.array(RouteRequestSchema).optional(),
  prune_neighbors: z.array(z.string()).optional(),
}).strict().refine(
  value => value.route_requests !== undefined || value.prune_neighbors !== undefined,
  { message: 'A repair patch must include route_requests or prune_neighbors.' },
);

/** Patch-only retry for a held CT finding. Omitted fields retain their held values. */
export const SubmitFindingsCtRepairPatchSchema = z.object({
  repair: z.literal(true),
  route_requests: z.array(CtRouteRequestSchema).optional(),
  column_flow: z.array(ColumnFlowEntrySchema).optional(),
}).strict().refine(
  value => value.route_requests !== undefined || value.column_flow !== undefined,
  { message: 'A repair patch must include route_requests or column_flow.' },
);

export type SubmitFindingsRepairPatch =
  | z.infer<typeof SubmitFindingsBbRepairPatchSchema>
  | z.infer<typeof SubmitFindingsCtRepairPatchSchema>;

/**
 * Zod schema for `get_neighbor_columns` tool input.
 *
 * @remarks
 * Parsed at the boundary so malformed payloads (e.g. missing `ids`, empty array)
 * produce a structured validation error instead of crashing the handler.
 */
export const GetNeighborColumnsInputSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});

export type GetNeighborColumnsInput = z.infer<typeof GetNeighborColumnsInputSchema>;

/**
 * Lightweight runtime validation for LLM tool inputs.
 *
 * @remarks
 * This function ensures that tool inputs provided by the language model match the
 * expected schema. It returns a structured error if any required field is missing
 * or has the wrong type, allowing the AI to self-correct.
 *
 * @param input - The raw input object provided by the language model.
 * @param required - A map of required field names to their expected TypeScript types.
 * @returns An error object if validation fails, otherwise `null`.
 */
export function validateToolInput(
  input: unknown,
  required: Record<string, FieldType>,
): { error: string; hint: string } | null {
  if (input === null || input === undefined || typeof input !== 'object') {
    return { error: 'invalid_input', hint: 'Tool input must be an object.' };
  }
  const obj = input as Record<string, unknown>;
  for (const [field, expectedType] of Object.entries(required)) {
    const val = obj[field];
    if (val === undefined || val === null) {
      return { error: 'missing_field', hint: `Required field "${field}" is missing.` };
    }
    if (expectedType === 'array') {
      if (!Array.isArray(val)) {
        return { error: 'wrong_type', hint: `Field "${field}" must be an array, got ${typeof val}.` };
      }
    } else if (typeof val !== expectedType) {
      return { error: 'wrong_type', hint: `Field "${field}" must be ${expectedType}, got ${typeof val}.` };
    }
  }
  return null;
}
