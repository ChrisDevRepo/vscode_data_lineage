/**
 * Zod input schemas and lightweight runtime validation for the AI tools.
 *
 * Extracted from `tools.ts` so the schema/contract surface lives apart from the retrieval
 * operations. Zero VS Code imports — pure schema definitions. Consumers (`tools.ts`,
 * `toolProvider.ts`, schema unit tests) import directly from this module.
 */
import { z } from 'zod';
import { AI_MAX_SCOPE_NODE_IDS, SCREEN_STATE_MAX_IDS, ColumnTransformClassSchema } from '../../engine/shared/bridgeContract';
import {
  ASYMMETRIC_DEPTH_REQUIRES_BIDIRECTIONAL,
  ExplorationDepthSelectionSchema,
} from '../../engine/shared/explorationDepthContract';
import { coercedBoolean, coercedStringArray, coercedStringObject, declaredKeysOnly, hoistSectionNotes, nullAsAbsent, repairArrayBoundaryArtifacts } from '../support/inputNormalization';
import { PRUNE_VERDICT_LEAD } from '../prompting/smPrompts';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { CLASSIFICATION_KEPT_ANGLES, type ClassificationValue } from '../session/classification';
import type { CapturedSection } from '../session/memoryManager';
import type { HopFinding } from '../sm/smTypes';
import type { PresentResultStage } from './presentResult';

/**
 * A column identifier the user actually named. Wildcards are rejected at the boundary: a
 * wildcard target column locks an unwinnable CT session because no real column can match it.
 */
export const ColumnIdentifierSchema = z.string().trim().min(1).regex(/^[^*%?]+$/, 'wildcards are not column identifiers').describe(
  'A column the user named verbatim. When the user named no specific column, omit targetColumns; wildcards are rejected at the boundary.',
);

const MissionBriefValueSchema = z.string()
  .min(1, 'Mission brief must not be empty.')
  .regex(/\S/, 'Mission brief must contain non-whitespace content.')
  .describe('Compact investigation goal and relevance criteria preserved verbatim across exploration hops. Keep it compact (a few sentences); length is never a rejection axis.');

const ScopeNotesValueSchema = z.array(z.string().min(1).regex(/\S/, 'A scope note must contain non-whitespace content.'))
  .max(8)
  .describe(
    'Analysis constraints the user stated that no filter field can express — e.g. "ignore filter criteria", '
    + '"explain the waiver logic on a named object in detail". One short note per instruction, in the '
    + "user's own terms. These are echoed back at the approval gate for the user to confirm, and are carried to "
    + 'every hop, so record an instruction here rather than dropping it when it maps to no filter.',
  );

const ClassificationValueSchema = z.enum(['business', 'technical', 'both'])
  .describe(
    'Required answer angle, following what the user asked for: use "business" unless the user named a '
    + 'technical lens (performance, indexes, execution plan, query shape, load pattern); use "technical" when '
    + 'that lens is the whole request; use "both" when the request spans both.',
  );

const SupplementNodeIdsSchema = z.array(z.string().min(1)).min(1).max(AI_MAX_SCOPE_NODE_IDS).describe(
  'Resolved object IDs that require new per-node analysis in the completed exploration; use present_result add_node_ids for presentation-only additions.',
);
const SupplementSchema = z.object({
  nodeIds: SupplementNodeIdsSchema,
}).strict().describe('Completed-session analysis extension; valid only after the prior exploration has completed.');

/**
 * Single source for the `depth` describe text on both {@link StartExplorationInputSchema} and
 * every provider branch spread through `StartPatchFields` — one canonical home instead of a
 * second literal duplicating it. The per-side `0` clause matches
 * {@link ExplorationDepthSideSchema}'s own contract (`explorationDepthContract.ts`) and
 * `isReachableInApprovedDirection` (`smBase.ts`): 0 is a permanent border for the rest of the
 * session, not merely a one-time skip of the initial seed.
 */
const StartDepthSchema = coercedStringObject(ExplorationDepthSelectionSchema).nullable().optional().describe(
  'AI-selected hop-by-hop starting scope: a symmetric positive integer, or per-side {upstream,downstream} (requires direction "bidirectional"). When the request explicitly asks for every upstream/downstream source or the complete chain (for example, "all the way up/down"), set "all"; do not omit depth. In a per-side value, 0 permanently disables that direction for the rest of the session, not just the initial seed. If the user stated no depth, omit the field; omitted/null intent proposes the reviewed default of 3.',
);

/**
 * Rejects an asymmetric `{upstream,downstream}` depth paired with an explicitly
 * non-bidirectional direction. An omitted direction defaults to bidirectional later in
 * engine init, so it must NOT trip this check — only an explicit `'upstream'`/`'downstream'`
 * conflicts with independently-seeded per-side depth. Shared across every start-exploration
 * branch that carries both `depth` and `direction` so the runtime and provider-visible
 * contracts enforce the identical rule.
 */
function refineAsymmetricDepthDirection(
  data: { depth?: unknown; direction?: 'upstream' | 'downstream' | 'bidirectional' },
  ctx: z.RefinementCtx,
): void {
  if (data.depth && typeof data.depth === 'object' && (data.direction ?? 'bidirectional') !== 'bidirectional') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['depth'],
      message: 'Asymmetric upstream/downstream depth requires direction "bidirectional". For one direction only, use direction "upstream"/"downstream" with a symmetric depth (a hard border); or keep "bidirectional" and set the other side to 0 to permanently exclude it.',
      params: { startIssue: ASYMMETRIC_DEPTH_REQUIRES_BIDIRECTIONAL },
    });
  }
}

/**
 * Strict domain boundary for fresh, refine, and completed-session exploration requests.
 *
 * @remarks
 * Parsed at the boundary so malformed payloads (e.g. missing `origin`) produce a structured
 * `missing_field` error instead of crashing `NavigationEngine.init` on `.toLowerCase()` of
 * undefined. Either `origin` (fresh exploration) or a `supplement` carrying explicit node ids
 * must be present. Supplement mode reuses the existing `NavigationEngine` / archive: the
 * supplied node ids are appended to the agenda, run through the SM hop loop, and new
 * `DetailSlot` entries merge into the existing archive for follow-up continuation.
 */
export const StartExplorationInputSchema = z.object({
  origin: z.string().min(1).optional().describe('Canonical object ID that anchors a fresh exploration.'),
  question: z.string().optional().describe('The user question this exploration must answer.'),
  proposalRevision: z.number().int().positive().optional().describe('Required when refining a pending approval proposal; copy the revision shown by the gate.'),
  analysisMode: z.enum(['bb', 'ct']).optional().describe(
    'Required for fresh exploration: "bb" traces whole objects; "ct" traces named columns. Default to "bb" when unclear.',
  ),
  targetColumns: coercedStringArray(ColumnIdentifierSchema).optional().describe(
    'CT only: user-named columns to trace. BB forbids this property; a raw provider empty BB array may normalize to absence.',
  ),
  direction: z.enum(['upstream', 'downstream', 'bidirectional']).optional().describe('Lineage direction requested by the user. "upstream"/"downstream" is a hard border excluding the other side entirely; use "bidirectional" with per-side depths for a lopsided start.'),
  depth: StartDepthSchema,
  excludeTypes: z.array(z.string()).optional().describe('Object types the user explicitly excluded from the approved scope.'),
  /**
   * Schemas to drop from the BFS scope (case-insensitive). Honored at scope-build time —
   * any candidate node whose schema matches is excluded. REPLACE semantics: each call
   * wipes prior filter state on the engine; accumulate across refine rounds by re-sending
   * every prior exclusion plus the new one.
   */
  excludeSchemas: z.array(z.string()).optional().describe('Complete replacement list of schema names excluded from the approved scope.'),
  /**
   * Specific node ids to drop from the BFS scope (case-insensitive). Cuts the node and
   * its subtree reachable only through it. Use only when the user explicitly says
   * remove / drop / prune / cut. REPLACE semantics — see {@link excludeSchemas}.
   * Every id must already be resolved via `lineage_search_objects` — unknown ids cause
   * the call to reject with `unknown_node_ids`.
   */
  excludeNodeIds: z.array(z.string()).optional().describe('Resolved object IDs to remove, including dependent branches reachable only through them.'),
  /**
   * Specific node ids the engine keeps in scope but auto-passes (no analysis written,
   * topology preserved so descendants stay reachable). Default interpretation when the
   * user says ignore / skip / don't analyze. REPLACE semantics — see {@link excludeSchemas}.
   * Every id must already be resolved via `lineage_search_objects` — unknown ids cause
   * the call to reject with `unknown_node_ids`.
   */
  passNodeIds: z.array(z.string()).optional().describe('Resolved object IDs to keep as topology-only passthrough nodes without analyzing them.'),
  scopeNotes: ScopeNotesValueSchema.optional(),
  mission_brief: MissionBriefValueSchema.optional(),
  // Keep decision guidance on the field schema so every adapter advertising this Zod contract
  // gives the model the same classification semantics.
  classification: ClassificationValueSchema.optional(),
  /**
   * Post-synthesis supplement: extend the existing archive with explicit nodes. Runs through the SM hop loop; slots merge into the existing
   * `AiMemoryManager`. No `origin` needed — the existing exploration is the origin.
   * Fails if no completed engine is attached to the session.
   */
  supplement: SupplementSchema.optional(),
}).strict().superRefine((data, ctx) => {
  const isProposalRefine = data.proposalRevision !== undefined;
  if (!data.origin && !data.supplement && !isProposalRefine) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Either 'origin' (fresh exploration) or 'supplement' with nodeIds (post-synthesis add) must be provided.",
      params: { startIssue: 'start_shape_required' },
    });
  }
  if (isProposalRefine && data.supplement) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['supplement'], message: 'A proposal refinement cannot be a completed-session supplement.' });
  }
  if (data.origin && data.supplement) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['supplement'],
      message: 'Fresh origin and completed-session supplement are mutually exclusive.',
      params: { startIssue: 'start_shape_conflict' },
    });
  }
  if (data.origin && !data.analysisMode) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['analysisMode'],
      message: 'analysisMode is required for fresh exploration. Use "bb" when unclear; use "ct" only for explicit column tracing.',
      params: { startIssue: 'analysis_mode_required' },
    });
  }
  if (data.origin && !isProposalRefine && !data.classification) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['classification'],
      message: 'classification is required for a fresh exploration proposal.',
      params: { startIssue: 'classification_required' },
    });
  }
  if (data.origin && data.analysisMode === 'ct' && (!data.targetColumns || data.targetColumns.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetColumns'],
      message: 'analysisMode "ct" requires targetColumns. Provide valid origin columns, ask the user to clarify, or switch analysisMode to "bb".',
      params: { startIssue: 'ct_target_columns_required' },
    });
  }
  if (data.analysisMode === 'bb' && data.targetColumns !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetColumns'],
      message: 'analysisMode "bb" is whole-object lineage and does not accept targetColumns.',
      params: { startIssue: 'bb_target_columns_forbidden' },
    });
  }
  refineAsymmetricDepthDirection(data, ctx);
});

const StartOriginSchema = z.string().min(1).describe('Canonical object ID that anchors a fresh exploration.');
const StartQuestionSchema = z.string().optional().describe('The user question this exploration must answer.');
const StartDirectionSchema = z.enum(['upstream', 'downstream', 'bidirectional']).optional().describe('Lineage direction requested by the user. "upstream"/"downstream" is a hard border excluding the other side entirely; use "bidirectional" with per-side depths for a lopsided start.');
const StartExcludeTypesSchema = z.array(z.string()).optional().describe('Object types the user explicitly excluded from the approved scope.');
const StartExcludeSchemasSchema = z.array(z.string()).optional().describe('Complete replacement list of schema names excluded from the approved scope.');
const StartExcludeNodeIdsSchema = z.array(z.string()).optional().describe('Resolved object IDs to remove, including dependent branches reachable only through them.');
const StartPassNodeIdsSchema = z.array(z.string()).optional().describe('Resolved object IDs to keep as topology-only passthrough nodes without analyzing them.');
const StartScopeNotesSchema = ScopeNotesValueSchema.optional();
const StartMissionBriefSchema = MissionBriefValueSchema.optional();
const EmptyBbTargetColumnsSchema = coercedStringArray(ColumnIdentifierSchema, { max: 0 }).optional().describe(
  'BB provider compatibility artifact only: omit targetColumns; an emitted empty array is normalized with a debug reason before strict domain validation.',
);
const NamedCtTargetColumnsSchema = coercedStringArray(ColumnIdentifierSchema, { min: 1 }).describe('CT requires one or more user-named columns.');
const StartPatchFields = {
  origin: StartOriginSchema.optional(),
  question: StartQuestionSchema,
  direction: StartDirectionSchema,
  depth: StartDepthSchema,
  excludeTypes: StartExcludeTypesSchema,
  excludeSchemas: StartExcludeSchemasSchema,
  excludeNodeIds: StartExcludeNodeIdsSchema,
  passNodeIds: StartPassNodeIdsSchema,
  scopeNotes: StartScopeNotesSchema,
  mission_brief: StartMissionBriefSchema,
  classification: ClassificationValueSchema.optional(),
};

/** Fresh BB proposal branch. It cannot encode refine or supplement fields. */
const StartFreshBbProviderSchema = z.object({
  ...StartPatchFields,
  origin: StartOriginSchema,
  analysisMode: z.literal('bb').describe(
    'Required for fresh exploration: "bb" traces whole objects; "ct" traces named columns. Default to "bb" when unclear.',
  ),
  classification: ClassificationValueSchema,
  targetColumns: EmptyBbTargetColumnsSchema,
}).strict().superRefine(refineAsymmetricDepthDirection);

/** Fresh CT proposal branch. It cannot encode refine or supplement fields. */
const StartFreshCtProviderSchema = z.object({
  ...StartPatchFields,
  origin: StartOriginSchema,
  analysisMode: z.literal('ct').describe(
    'Required for fresh exploration: "bb" traces whole objects; "ct" traces named columns. Default to "bb" when unclear.',
  ),
  classification: ClassificationValueSchema,
  targetColumns: NamedCtTargetColumnsSchema,
}).strict().superRefine(refineAsymmetricDepthDirection);

/** Pending-proposal patch branch. Omitted fields are merged mechanically by the dispatcher. */
const StartRefineProviderSchema = z.object({
  ...StartPatchFields,
  proposalRevision: z.number().int().positive().describe('Revision shown by the pending approval gate.'),
  analysisMode: z.enum(['bb', 'ct']).optional().describe(
    'Required for fresh exploration: "bb" traces whole objects; "ct" traces named columns. Default to "bb" when unclear.',
  ),
  targetColumns: coercedStringArray(ColumnIdentifierSchema).optional().describe(
    'CT only: user-named columns to trace. BB forbids this property; a raw provider empty BB array may normalize to absence.',
  ),
}).strict().superRefine((data, ctx) => {
  if (data.analysisMode === 'bb' && data.targetColumns && data.targetColumns.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targetColumns'], message: 'BB refinement cannot name target columns.' });
  }
  if (data.analysisMode === 'ct' && (!data.targetColumns || data.targetColumns.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targetColumns'], message: 'A BB-to-CT refinement requires named target columns.' });
  }
}).superRefine(refineAsymmetricDepthDirection);

/** Completed-session supplement branch. `nodeIds` is always required and non-empty. */
const StartSupplementProviderSchema = z.object({
  supplement: SupplementSchema,
}).strict();

/**
 * Fresh-entry model contract selected for `sm_entry` before the first approval gate.
 *
 * @remarks
 * One flat object, not a BB/CT union — a top-level `anyOf`/`oneOf` tool schema defeats
 * some models' constrained tool-arg emission (observed in practice as empty `{}` args
 * returned for this tool). Mode discrimination (BB forbids `targetColumns`; CT
 * requires it) stays exclusively at the {@link StartExplorationInputSchema} dispatcher
 * boundary (`bb_target_columns_forbidden` / `ct_target_columns_required`) — this projection
 * carries no min/max constraint on `targetColumns`.
 */
export const StartExplorationFreshProviderInputSchema = z.object({
  ...StartPatchFields,
  origin: StartOriginSchema,
  analysisMode: z.enum(['bb', 'ct']).describe(
    'Required for fresh exploration: "bb" traces whole objects; "ct" traces named columns. Default to "bb" when unclear.',
  ),
  classification: ClassificationValueSchema,
  targetColumns: coercedStringArray(ColumnIdentifierSchema).optional().describe(
    'CT only: user-named columns to trace. BB forbids this property.',
  ),
}).strict().superRefine(refineAsymmetricDepthDirection);

/** Gate-refinement model contract selected only while revising a pending proposal. */
export const StartExplorationRefineProviderInputSchema = StartRefineProviderSchema;

/** Completed-session model contract selected only for explicit supplements. */
export const StartExplorationSupplementProviderInputSchema = StartSupplementProviderSchema;

/**
 * Canonical all-phase contract used by persistent VS Code/Copilot registration and manifest parity.
 * API InstructionPlans replace it with exactly one phase-specific schema before each model call.
 */
export const StartExplorationProviderInputSchema = z.union([
  StartFreshBbProviderSchema,
  StartFreshCtProviderSchema,
  StartRefineProviderSchema,
  StartSupplementProviderSchema,
]);
/**
 * Zod schema for discovery-scoped BFS bundle retrieval.
 *
 * @remarks
 * Used for graph-scope discovery asks where the AI needs one bounded scope in a
 * single call (instead of many per-node detail calls). Optional asymmetric depth
 * is honored only for bidirectional traversals.
 */
const ScopeDepthSchema = z.union([z.coerce.number().int().min(0), z.literal('all')]);
const ScopeOriginSchema = z.string().min(1).describe('Canonical object ID at the center of the requested lineage scope.');
const ScopeIncludeDdlSchema = coercedBoolean().optional().describe('Whether to include SQL bodies for nodes in the returned scope.');

/**
 * Zod schema validating the parameters for the `get_scope_bundle` discovery tool.
 *
 * @remarks
 * Model-facing AND dispatcher schema — one flat object, not a symmetric/asymmetric
 * union. A top-level `anyOf`/`oneOf` tool schema defeats some models' constrained
 * tool-arg emission (observed in practice as empty `{}` args returned for every
 * union-shaped tool call); symmetric-vs-asymmetric discrimination stays owned
 * entirely by the `superRefine` below, at the one Zod boundary.
 */
export const GetScopeBundleInputSchema = z.object({
  origin: ScopeOriginSchema,
  direction: z.enum(['upstream', 'downstream', 'bidirectional']).optional().describe('Direction of dependencies to include; defaults to bidirectional.'),
  depth: ScopeDepthSchema.optional().describe('Optional symmetric hop depth, or "all" for the whole reachable chain. Omit to use the backend default of 3.'),
  upstream_depth: ScopeDepthSchema.optional().describe('Optional upstream hop depth for an asymmetric bidirectional scope.'),
  downstream_depth: ScopeDepthSchema.optional().describe('Optional downstream hop depth for an asymmetric bidirectional scope.'),
  include_ddl: ScopeIncludeDdlSchema,
}).strict().superRefine((input, ctx) => {
  const direction = input.direction ?? 'bidirectional';
  if (direction === 'bidirectional') {
    const symmetric = input.depth !== undefined;
    const asymmetric = input.upstream_depth !== undefined && input.downstream_depth !== undefined;
    if (symmetric && (input.upstream_depth !== undefined || input.downstream_depth !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['depth'], message: 'Use either depth or the asymmetric depth fields, not both.' });
    }
    if (!symmetric && !asymmetric && (input.upstream_depth !== undefined || input.downstream_depth !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['upstream_depth'], message: 'Provide both upstream_depth and downstream_depth.' });
    }
  } else if (input.upstream_depth !== undefined || input.downstream_depth !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['direction'], message: 'Asymmetric depths are valid only for bidirectional scope retrieval.' });
  }
});

/** Inferred type of {@link GetScopeBundleInputSchema}. */
export type GetScopeBundleInput = z.infer<typeof GetScopeBundleInputSchema>;

/**
 * Model-facing projection of `lineage_get_scope_bundle` sent on every model call.
 *
 * @remarks
 * Narrower than {@link GetScopeBundleInputSchema}: no symmetric `depth` and no `direction` field —
 * only `upstream_depth`/`downstream_depth`, both required. The full schema's five optional,
 * mutually-conflicting depth/direction fields let a model co-emit an invalid combination in one
 * call (observed in practice as `depth` alongside `upstream_depth`/`downstream_depth`, tripping
 * the dispatcher's `superRefine`); collapsing to one required per-side shape removes that surface
 * entirely. Every projected call always resolves at the dispatcher boundary to a bidirectional
 * scope with independently-set upstream/downstream depths — the dispatcher
 * ({@link GetScopeBundleInputSchema}) is unchanged and still owns the full symmetric/asymmetric/
 * direction contract for non-model callers.
 */
export const GetScopeBundleModelSchema = z.object({
  origin: ScopeOriginSchema,
  upstream_depth: ScopeDepthSchema.describe(
    'Hops of upstream (source) dependencies: a positive integer, "all" for the entire upstream chain, or 0 to exclude upstream. Use the same value as downstream_depth for a symmetric scope (3 each is typical).',
  ),
  downstream_depth: ScopeDepthSchema.describe(
    'Hops of downstream (dependent) objects: a positive integer, "all", or 0 to exclude downstream.',
  ),
  include_ddl: ScopeIncludeDdlSchema,
}).strict();

/**
 * Zod schema for one captured section within `submit_findings.sections[]`.
 *
 * @remarks
 * Each fired `*_capture` YAML template produces ONE entry. This base shape backs the
 * permissive registered union ({@link SubmitFindingsModelSchema}) and stays angle-open;
 * the strict per-dispatch schema (`submitFindingsSchemaForMode`) narrows `angle` to the
 * locked classification's kept angle(s) before every active-hop dispatch, so an off-lock
 * angle fails there and the model re-submits with its content folded into a kept section.
 * `interaction/rules/submitFindingsRules.validateSectionsAgainstClassification` still checks,
 * after that, that every kept angle the lock requires is actually present.
 */
const CapturedSectionSchema = z.object({
  /** Which YAML capture template produced this section. */
  angle: z.enum(['business', 'technical']).describe('The locked output angle represented by this section.'),
  /** Pre-formatted section body. */
  text: z.string().min(1).describe('Grounded analysis for this node under the selected angle.'),
}).strict();

/**
 * Single source for the `route_requests[].columns` describe text.
 *
 * @remarks
 * The per-neighbor fork at a branch: one neighbor carries traced columns, its sibling only decides
 * which rows the answer returns. `column_flow[].upstream_columns` cannot state this — it is keyed
 * by an output column of the focus, so it asserts provenance, and the carry decision would ride on
 * that assertion. Kept as one exported constant because the field's contract must read the same on
 * the strict per-mode schemas and on the permissive registered union.
 */
export const ROUTE_COLUMNS_DESCRIPTION =
  'Column-trace sessions only. Which traced columns travel to this neighbor: list them to carry exactly '
  + 'those, or send the word "none" when the neighbor supplies no traced value and only decides which rows '
  + 'the answer returns (a filter, a join key) — it is then explored as a whole object, with no column '
  + 'question attached. State one or the other for every routed neighbor — an undecided neighbor is '
  + 'rejected, not defaulted, and so is a contradicted one: "none" is refused when column_flow in this '
  + 'same submission names the neighbor as a real contributor; list at least those columns instead.';

/**
 * Per-route column decision. A word rather than an empty array for the row-role case, so an
 * omitted field and a stated "no columns" can never be read as the same payload.
 */
const RouteColumnsSchema = z.union([
  z.array(z.string().min(1)).min(1),
  z.literal('none'),
]);

const RouteRequestSchema = z.object({
  nodeId: z.string().describe('Exact current-hop neighbor ID to queue.'),
  question: z.string().describe(
    'Verification sub-question for the routed node, self-contained so a later hop can act on it after ' +
    'older turns are wiped. Name the node being routed to, the specific column or value to resolve there, ' +
    'and the mission decision it answers — e.g. "Does spNormalizeLoansA derive DaysA from RawDaysA or pass it ' +
    'through? Resolves whether the days chain continues upstream." Frame it around the routed node, not the ' +
    'current focus; "analyze this node" carries no decision and is not a usable sub-question.',
  ),
  columns: RouteColumnsSchema.optional().describe(ROUTE_COLUMNS_DESCRIPTION),
}).strict();

/**
 * CT-mode `route_requests[]` shape: {@link RouteRequestSchema} with `columns` required.
 *
 * @remarks
 * A CT hop states a column decision for every routed neighbor — a non-empty list, or the literal
 * `"none"` — never an omitted field; an omission has no engine-side "carry whatever the trace
 * already carries" fallback to resolve to.
 */
const CtRouteRequestSchema = RouteRequestSchema.extend({
  columns: RouteColumnsSchema.describe(ROUTE_COLUMNS_DESCRIPTION),
}).strict();

/**
 * BB-mode `route_requests[]` shape: {@link RouteRequestSchema} without `columns`.
 *
 * @remarks
 * `columns` is a column-trace decision (which traced columns carry to a neighbor); a BB session
 * traces no columns, so BB never advertises the field — mirroring the per-mode narrowing
 * {@link capturedSectionSchemaForClassification} already performs for `sections[].angle`. A BB
 * payload naming `columns` anyway fails `.strict()` here and rejects through the same generic
 * invalid-input path every other unrecognized BB field takes, instead of being silently dropped at
 * the handler.
 */
const BbRouteRequestSchema = RouteRequestSchema.omit({ columns: true });

/**
 * Single source for the `route_requests` field describe text, shared by the strict per-mode
 * schemas and the permissive registered union so the contract cannot drift between them.
 */
export const ROUTE_REQUESTS_DESCRIPTION =
  'Current-hop neighbor nodes worth exploring next, each with a self-contained verification question.';

/**
 * Single source for the `prune_neighbors` field describe text: a prune is valid
 * for a neighbor off the answer path — outside the approved exploration scope, or inside it with
 * nothing the answer needs. Shared by the strict per-mode schemas and the permissive registered
 * union so the registered surface cannot narrow this decision space out of sync with
 * `NEIGHBOR_DECISION_CORE` (`src/ai/prompting/smPrompts.ts`).
 */
export const PRUNE_NEIGHBORS_DESCRIPTION =
  'Current-hop neighbor IDs to drop from the session because current evidence proves they are off the answer path — out of the approved scope, or in scope with nothing the answer needs.';

/**
 * States a content cap in the JSON schema the model reads (`maxLength` / `maxItems`) without
 * enforcing it at parse.
 *
 * @remarks
 * Enforcement is the validator's (`validatePresentResult`) or the engine's
 * (`NavigationEngine.submitFindings`), which rejects the offending field alone as repairable,
 * states the measured size against the limit, and holds the draft. A parse-time cap would reject at
 * the model port instead — with no held draft, no measured size, and no repairable classification —
 * forcing a full resend of an answer that was otherwise correct. Structural constraints
 * (`min`, non-whitespace refinements, type and enum) stay real parse-time checks: they describe the
 * shape a reader needs, not the size a surface can render.
 *
 * The projection carries the same keyword and the same value the equivalent `.max()` produced — key
 * order differs, which JSON Schema does not distinguish — so the model is offered the same contract
 * either way.
 *
 * @param schema - The field schema the cap describes.
 * @param bound - The advertised ceiling, keyed for the projected type: `maxLength` for a string,
 *   `maxItems` for an array. Always a named constant.
 * @returns The same schema, carrying the cap as projected metadata only.
 */
function advertisedMax<T extends z.ZodType>(
  schema: T,
  bound: { readonly maxLength: number } | { readonly maxItems: number },
): T {
  return schema.meta({ ...bound });
}

/**
 * Hard cap on `badge_label`.
 *
 * @remarks
 * Advertised on the model-facing `submit_findings` schemas through {@link advertisedMax} and
 * enforced by `NavigationEngine.submitFindings`, before any mutation.
 */
export const SUBMIT_FINDINGS_BADGE_LABEL_MAX = 50;

/**
 * Single source for the `badge_label` describe text, shared by the strict per-mode
 * `submit_findings` schemas and the permissive registered union so the two never restate the
 * same fact with different wording. The soft target (a 2-4 word label) lives here and nowhere
 * else: `badge_label` is a per-hop tool field, not template-governed content.
 */
export const BADGE_LABEL_DESCRIPTION =
  `Short advisory label for this hop; final graph labels are authored by present_result sections. Maximum ${SUBMIT_FINDINGS_BADGE_LABEL_MAX} characters — a 2-4 word label.`;

/**
 * Hard cap on `column_flow[].upstream_columns[].note`.
 *
 * @remarks
 * Advertised on the model-facing `submit_findings` schemas through {@link advertisedMax} and
 * enforced by `NavigationEngine.submitFindings`, before any mutation.
 */
export const COLUMN_FLOW_NOTE_MAX = 200;

const ColumnRefSchema = z.object({
  node: z.string().describe('Canonical upstream node ID.'),
  col: z.string().describe('Real upstream column name.'),
  transforms: z.array(ColumnTransformClassSchema).optional().describe(
    'How this upstream column reaches out_col. Multi-select — list every class that applies, since one ' +
    'edge is often several. Omit the field entirely when the DDL does not determine it; never guess. ' +
    'pass_through: rename, SELECT *, synonym, straight copy. compute: formula, CASE, COALESCE, cast, ' +
    'concat, string/date function. aggregate: SUM/COUNT/MIN/MAX, GROUP BY, window function, PIVOT. ' +
    'combine: JOIN, UNION/EXCEPT/INTERSECT, APPLY, UNPIVOT. filter: WHERE, HAVING, join ON predicate, ' +
    'TOP, DISTINCT.',
  ),
  note: advertisedMax(z.string(), { maxLength: COLUMN_FLOW_NOTE_MAX }).optional().describe(
    'One short grounded clause naming the rule or expression behind the transforms — e.g. ' +
    '"SUM of LoanLines Days * Rate" — at most ~12 words. Omit when transforms is omitted or the ' +
    'DDL gives nothing concrete to quote; never speculate.',
  ),
}).strict();

const ColumnFlowWritesToObject = z.object({
  node: z.string().describe('Canonical downstream node ID.'),
  col: z.string().describe('Downstream column receiving this value.'),
}).strict();

const ColumnFlowEntryObject = z.object({
  out_col: z.string().describe('Tracked output column on the current focus node.'),
  writes_to: nullAsAbsent(declaredKeysOnly(ColumnFlowWritesToObject).optional()).describe('Optional downstream write destination observed in the current node.'),
  upstream_columns: z.array(ColumnRefSchema).describe('Real upstream columns that contribute to out_col; use [] only when none exists.'),
}).strict();

const ColumnFlowEntrySchema = declaredKeysOnly(ColumnFlowEntryObject);


/**
 * Mode-locked `verdict` field description for `submit_findings`.
 *
 * @remarks
 * One set of definitions, both modes: this description is the last text the model reads before it
 * answers, and a CT restatement here rewrote "analyze" and "passthrough" in column vocabulary — a
 * row-shaping node carrying no traced column then matched neither, leaving `prune` as the only
 * word available and removing a node BB keeps. CT renders the same sentence and adds its column
 * clause, matching the composed Verdict Protocol block in the system prompt.
 */
const VERDICT_DEFINITIONS =
  `"analyze" applies logic on the data path, "passthrough" is on the path with no logic, "prune": ${PRUNE_VERDICT_LEAD}`;

const hopVerdictSchema = (mode: 'bb' | 'ct') =>
  z.enum(['analyze', 'passthrough', 'prune']).describe(
    `Your assessment of the focus node, per the Verdict Protocol in the system prompt. ${VERDICT_DEFINITIONS}`
    + (mode === 'ct' ? ' In CT, "analyze" also covers a traced column\'s terminal source, and every verdict carries column_flow.' : ''),
  );

const ColumnFlowSchema = z.array(ColumnFlowEntrySchema).max(AI_MAX_SCOPE_NODE_IDS).describe(
  'CT mode only: structural provenance for active tracked columns. Use column_flow: [] only when the focus has no active tracked-column interaction. ' +
  'When a tracked output exists but has no upstream real column, emit its entry with upstream_columns: [].',
);

/**
 * `submit_findings.sections[]` length cap: one angle per classification, two under `both`. Single
 * governor for the cap so the base, registered-union, and classification-narrowed schemas cannot
 * drift apart on it.
 */
const SUBMIT_FINDINGS_SECTIONS_MAX = 2;

/**
 * Shared `submit_findings` fields across BB and CT modes.
 */
const HopFindingBaseSchema = z.object({
  focus_node_id: z.string().describe('Exact current focus-node ID supplied by the runtime frame.'),
  /**
   * One section per fired `*_capture` template. Length 1 (`business` / `technical`
   * classification) or 2 (`both`) — required on every hop (a node always commits its analysis).
   */
  sections: coercedStringArray(CapturedSectionSchema, { max: SUBMIT_FINDINGS_SECTIONS_MAX }).describe('One grounded section for each output angle required by the locked classification.'),
  summary: z.string().describe(
    'One-line digest a later hop reads in isolation after older turns are wiped. Name what this node does ' +
    'to the data — the transform, filter, or pass-through — and what it hands to which downstream node. ' +
    'Example: "vwRateA carries StdRateA through unchanged and feeds spBuildCircA with UnitRateA." ' +
    'Aim for one line; length is never a rejection axis.',
  ),
  badge_label: advertisedMax(z.string(), { maxLength: SUBMIT_FINDINGS_BADGE_LABEL_MAX }).min(1)
    .refine(value => value.trim().length > 0, 'badge_label must contain non-whitespace text')
    .optional()
    .describe(BADGE_LABEL_DESCRIPTION),
}).strict();

/**
 * BB-mode submit_findings input.
 *
 * @remarks
 * The node's self-status is `analyze` (carries lineage), `passthrough` (kept, not a key transform), or `prune` (entirely irrelevant focus node — orphan-guarded removal).
 * `prune_neighbors` removes topology-safe neighbors the evidence proves are off the answer path — out of scope, or in scope with nothing the answer needs; queued, visited, and removed targets are protected no-ops and every executed prune is don't-orphan-guarded.
 * BB does not carry CT-only `column_flow`, and its `route_requests[]` entries do not carry the
 * CT-only `columns` decision ({@link BbRouteRequestSchema}) — a BB session traces no columns, so
 * the field is never advertised here.
 */
export const SubmitFindingsBbInputSchema = HopFindingBaseSchema.extend({
  verdict: hopVerdictSchema('bb'),
  route_requests: coercedStringArray(BbRouteRequestSchema, { max: AI_MAX_SCOPE_NODE_IDS }).optional().describe(ROUTE_REQUESTS_DESCRIPTION),
  prune_neighbors: coercedStringArray(z.string(), { max: AI_MAX_SCOPE_NODE_IDS }).optional().describe(PRUNE_NEIGHBORS_DESCRIPTION),
}).strict();

/**
 * CT-mode submit_findings input.
 *
 * @remarks
 * CT is BB plus column tracking, so every BB field — including `prune_neighbors` — is present on
 * the CT form; `column_flow`'s own contract is documented on {@link ColumnFlowSchema}. Its
 * `route_requests[]` entries additionally require the per-neighbor `columns` decision
 * ({@link CtRouteRequestSchema}) — a non-empty list or `"none"`, never omitted — which BB's form
 * omits entirely.
 */
export const SubmitFindingsCtInputSchema = HopFindingBaseSchema.extend({
  verdict: hopVerdictSchema('ct'),
  column_flow: ColumnFlowSchema,
  route_requests: coercedStringArray(CtRouteRequestSchema, { max: AI_MAX_SCOPE_NODE_IDS }).optional().describe(ROUTE_REQUESTS_DESCRIPTION),
  prune_neighbors: coercedStringArray(z.string(), { max: AI_MAX_SCOPE_NODE_IDS }).optional().describe(PRUNE_NEIGHBORS_DESCRIPTION),
}).strict();

/** Memoized per (mode, classification) narrowed `submit_findings` schemas built by {@link submitFindingsSchemaForMode}. */
const submitFindingsSchemaCache = new Map<string, z.ZodType<HopFinding>>();

/**
 * Narrows {@link CapturedSectionSchema}'s `angle` enum to the angle(s) a locked classification
 * keeps ({@link CLASSIFICATION_KEPT_ANGLES}), with a rejection message naming the kept angle(s)
 * and telling the model to fold an off-lock angle's content into that kept section.
 *
 * @param classification - The locked classification this dispatch's schema narrows to.
 * @returns A `.strict()` section schema whose `angle` only accepts the kept angle(s).
 */
function capturedSectionSchemaForClassification(classification: ClassificationValue): z.ZodType<CapturedSection> {
  const kept = CLASSIFICATION_KEPT_ANGLES[classification];
  if (kept.length === 2) return CapturedSectionSchema; // `both` keeps every angle — no narrowing.
  const [onlyAngle] = kept;
  const foldMessage =
    `classification=${classification} keeps only angle="${onlyAngle}". Fold this content into the `
    + `existing "${onlyAngle}" section instead of submitting a separate section for another angle.`;
  return CapturedSectionSchema.extend({
    angle: z.literal(onlyAngle, { message: foldMessage }).describe(
      `The locked output angle represented by this section (classification=${classification} keeps only "${onlyAngle}").`,
    ),
  }).strict();
}

/**
 * Selects the strict, mode-and-classification-locked `submit_findings` schema advertised to the
 * model during an active SM hop.
 *
 * @remarks
 * BB returns {@link SubmitFindingsBbInputSchema} (no `column_flow`); CT returns
 * {@link SubmitFindingsCtInputSchema} (`column_flow` required; `prune_neighbors` shared with BB). When
 * `classification` is supplied, `sections[].angle` is further narrowed to the angle(s) that
 * classification keeps ({@link capturedSectionSchemaForClassification}) — a `business` or `technical`
 * lock structurally cannot author the other angle's section, so a surplus angle fails Zod at this
 * boundary instead of being silently dropped at commit. The host path uses this at the last seam
 * before the model sees the tool set so the model cannot fill a field or angle invalid for the
 * locked mode/classification — the contract is the form's shape, not prompt prose. The static
 * catalog and `package.json` manifest keep the permissive union (drift guard + single-tool Copilot
 * lane unaffected).
 *
 * @param mode - Locked active analysis mode used for provider projection.
 * @param classification - Locked output classification; omitted callers get the mode-only schema.
 * @returns The strict provider schema for that mode and classification. Typed against
 * {@link HopFinding} (rather than a bare `z.ZodType`) so the handler that parses the model's actual
 * submission with this same selector — not just the tool-registration caller — keeps a concrete
 * `.data` type without a cast.
 */
export function submitFindingsSchemaForMode(mode: 'bb' | 'ct', classification?: ClassificationValue): z.ZodType<HopFinding> {
  const base = mode === 'ct' ? SubmitFindingsCtInputSchema : SubmitFindingsBbInputSchema;
  if (!classification || CLASSIFICATION_KEPT_ANGLES[classification].length === 2) return base;
  const cacheKey = `${mode}:${classification}`;
  const cached = submitFindingsSchemaCache.get(cacheKey);
  if (cached) return cached;
  const narrowedSections = coercedStringArray(capturedSectionSchemaForClassification(classification), { max: SUBMIT_FINDINGS_SECTIONS_MAX })
    .describe(`One grounded section for the output angle required by classification=${classification}.`);
  const schema = base.extend({ sections: narrowedSections }).strict();
  submitFindingsSchemaCache.set(cacheKey, schema);
  return schema;
}

/**
 * Zod schema for `get_neighbor_columns` tool input.
 *
 * @remarks
 * Parsed at the boundary so malformed payloads (e.g. missing `ids`, empty array)
 * produce a structured validation error instead of crashing the handler.
 */
export const GetNeighborColumnsInputSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).describe('Canonical direct-neighbor IDs whose structural columns are hidden by opaque focus DDL.'),
}).strict();
// ──────────────────────────────────────────────────────────────────────────────
// Model-facing input schemas
//
// Each registered `languageModelTool` advertises ONE input schema to the model.
// These schemas are the single Zod source for that model-facing contract. Runtime
// handlers still validate mode-specific payloads at the boundary before mutating
// session or graph state.
// ──────────────────────────────────────────────────────────────────────────────

/** `lineage_get_context` takes no input. */
export const GetContextInputSchema = z.object({}).strict();

/** `lineage_get_screen_state` input: no field returns the screen card; `ids` or `filter` recalls the stored run. */
export const GetScreenStateInputSchema = z.object({
  ids: z.array(z.string()).min(1).max(SCREEN_STATE_MAX_IDS).optional()
    .describe('Canonical object ids to recall from the stored run, taken from the screen card\'s node_ids. Use without filter.'),
  filter: z.enum(['pruned', 'open_leads', 'stale']).optional()
    .describe('One class of the stored run to list: pruned, open_leads, or stale. Use without ids.'),
}).strict().superRefine((value, ctx) => {
  if (value.ids && value.filter) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filter'], message: 'Send either ids or filter, never both. Drop one of the two and call lineage_get_screen_state again.' });
  }
});

/** `lineage_search_objects` input. */
export const SearchObjectsInputSchema = z.object({
  query: z.string().describe('In substring mode: any part of an object or column name, without a schema prefix like \'[dbo].\'. In regex mode: the pattern, used verbatim. May be empty ONLY together with schemas[] to list everything in those schemas.'),
  types: z.array(z.enum(['table', 'view', 'procedure', 'function', 'external'])).optional().describe('Optional object-type filter.'),
  schemas: z.array(z.string()).optional().describe('Optional schema-name filter; combine with a zero-length query to list objects in those schemas.'),
  mode: z.enum(['substring', 'regex']).optional().describe('Name matching strategy: "substring" (default) or "regex" (case-insensitive, matched against name and schema.name).'),
}).strict();

/** `lineage_get_object_detail` input. */
export const GetObjectDetailInputSchema = z.object({
  id: z.string().describe('Canonical object ID returned by a lineage search or scope tool.'),
}).strict();

/** `lineage_detect_graph_patterns` input. */
export const DetectGraphPatternsInputSchema = z.object({
  type: z.enum(['hubs', 'islands', 'orphans', 'longest-path', 'cycles', 'external-refs']).describe('Structural graph pattern to detect.'),
  min_degree: z.number().optional().describe('Minimum node degree for hub detection.'),
  max_size: z.number().optional().describe('Maximum number of pattern results to return.'),
}).strict();

/** `lineage_search_ddl` input. */
export const SearchDdlInputSchema = z.object({
  query: z.string().describe('Regular expression against SQL body text; case-insensitive; `^` and `$` match per line.'),
  types: z.array(z.enum(['view', 'procedure', 'function'])).optional().describe('Optional body-type filter; omit to search all three.'),
}).strict();

/**
 * Model-facing `lineage_present_result` input schema.
 *
 * @remarks
 * Mirrors the AI-authored `PresentResultInput` contract (`src/ai/tools/handlers/presentResult.ts`)
 * for the single registered tool. The runtime handler (`toolProvider.presentResult`)
 * still consumes the structural `PresentResultInput` TS type; this Zod object exists so
 * the model-facing JSON Schema has one generated source under the drift guard. `angle`
 * on a section is advisory capture metadata carried in the manifest.
 */
// GUI-rendered labels carry a SOFT target — advertised exactly once, in the field's own
// description or in the output-template entry that governs the field — and a HARD cap at ~1.5x for
// tolerance: a value within tolerance is accepted verbatim (no silent truncation) and only a
// genuinely layout-breaking overrun rejects. Every cap below reaches the model through
// `advertisedMax` and is enforced by `validatePresentResult` alone; no parse enforces one.
/** Hard cap on `name` (graph node label); its soft target is the field's own description. */
export const PRESENT_RESULT_NAME_MAX = 90;
/** Hard cap on `title` (report heading); its soft target is the `title` output template. */
export const PRESENT_RESULT_TITLE_MAX = 120;
/**
 * Hard cap on a `sections[].label`. The label's shape is owned by `buildPresentationDetailContract`
 * (`prompts.ts`), which states a semantic-pointer shape and deliberately no character target.
 */
export const PRESENT_RESULT_SECTION_LABEL_MAX = 90;
/** Hard cap on a `highlight_groups[].label`; its soft target is the `highlights` output template. */
export const PRESENT_RESULT_HIGHLIGHT_LABEL_MAX = 60;
/**
 * Max color groups on one rendered result — a small cap keeps the graph legend scannable.
 * Advertised through {@link advertisedMax} and enforced by `validatePresentResult`
 * (`presentResult.ts`), which rejects an over-long list as a repairable `highlight_groups` patch.
 */
export const PRESENT_RESULT_HIGHLIGHT_GROUPS_MAX = 5;
/**
 * The Lineage color-scheme enum shared by every colored surface. Declared once so
 * render paths cannot drift: flow-role schemes (`source` / `transform` / `target`) plus status
 * schemes (`good` / `warn` / `fail`).
 */
const HighlightSchemeSchema = z.enum(['source', 'transform', 'target', 'good', 'warn', 'fail']);
// `summary` is prose CONTENT (the one-line graph purpose), not a fixed-width GUI label: it is uncapped —
// Output lifetime is provider-native and graph-budgeted, never schema-truncated, so length is not a rejection axis.

/**
 * One model-supplied node id: Unicode format characters stripped, trimmed, required non-empty.
 *
 * @remarks
 * A blank, whitespace-only, or zero-width-only entry would otherwise pass this boundary, resolve
 * to nothing, and surface as an "unknown IDs" rejection whose offender list renders empty —
 * telling the model an id was wrong while showing it none. Rejecting it here names the exact
 * array index instead, which is a field path a repair can act on. The `\p{Cf}` strip mirrors
 * `resolveModelNodeId` (`src/engine/shared/nodeIdResolution.ts`), so an id that would resolve to
 * nothing invisible never enters the pipeline; `overwrite` keeps the JSON Schema projection a
 * plain `{type: "string", minLength: 1}`.
 */
const NodeIdSchema = z.string()
  .overwrite(value => value.replace(/\p{Cf}/gu, ''))
  .trim()
  .min(1, 'Node ID must not be blank.');

/**
 * Schema for a visual highlight group, grouping nodes by a shared role or status.
 */
const HighlightGroupSchema = z.object({
  label: advertisedMax(z.string(), { maxLength: PRESENT_RESULT_HIGHLIGHT_LABEL_MAX }).describe('Short legend label describing the shared graph role or status; length target: see the `highlights` output template.'),
  color: HighlightSchemeSchema.describe('Semantic graph color role or status.'),
  node_ids: z.array(NodeIdSchema).describe('Node IDs that share this graph role or status.'),
}).strict();

/**
 * One final report section: a label that becomes both the section heading and the graph badge, the
 * nodes it explains, and its detail body.
 */
const PresentResultSectionSchema = z.object({
  // Role only, no character target: a tool-parameter description outranks the system prompt, so a
  // soft character target here became the operative ceiling and licensed a full question as a
  // badge. Shape guidance belongs in `buildPresentationDetailContract`; the cap below is the one
  // this schema advertises and `validatePresentResult` enforces.
  label: advertisedMax(z.string(), { maxLength: PRESENT_RESULT_SECTION_LABEL_MAX }).describe('Section heading and graph badge for every linked node.'),
  node_ids: z.array(NodeIdSchema).optional().describe('A node ID can only appear in ONE section. Do not link a node to multiple sections.'),
  text: z.string().describe('Required detail body for this section label.'),
}).strict();

/**
 * Schema defining the shape of the final generated presentation result.
 */
export const PresentResultModelSchema = z.object({
  name: advertisedMax(z.string(), { maxLength: PRESENT_RESULT_NAME_MAX }).describe('Short name for the generated lineage view — aim for ~60 chars.'),
  summary: z.string().describe('One-line summary shown with the generated view.'),
  title: advertisedMax(z.string(), { maxLength: PRESENT_RESULT_TITLE_MAX }).optional().describe('Optional report heading.'),
  intro: z.string().optional().describe('Optional grounded introduction to the final report.'),
  // Prose, never a rejection axis (a 400 cap once made the model self-truncate mid-sentence);
  // bounded at the wire only.
  closing: z.string().optional().describe('Optional closing synthesis and grounded risks or recommendations. Length is never a rejection axis.'),
  prune_node_ids: z.array(NodeIdSchema).optional().describe('ONLY permitted during Completed Phase follow-ups. Strictly forbidden during the initial Synthesis Phase.'),
  add_node_ids: z.array(NodeIdSchema).optional().describe('ONLY permitted during Completed Phase follow-ups. Strictly forbidden during the initial Synthesis Phase.'),
  layout_direction: z.enum(['LR', 'TB']).optional().describe('Graph layout: left-to-right or top-to-bottom.'),
  highlight_groups: advertisedMax(z.array(HighlightGroupSchema).min(1), { maxItems: PRESENT_RESULT_HIGHLIGHT_GROUPS_MAX }).describe(
    'REQUIRED for new renders, 1-5 groups. For zero-trace or single-node results, use color "target" on the origin/result node.'
  ),
  sections: coercedStringArray(PresentResultSectionSchema, { min: 1 }).describe('Required final report sections; each label maps to exactly one text body.'),
  notes: z.array(z.object({
    node_id: NodeIdSchema.describe('Node ID receiving this below-node caption.'),
    // Stage-neutral on purpose: synthesis grounds a caption in the archive, preview must copy one
    // contiguous span of the supplied answer. One schema serving both stages can only state what
    // they share; each stage's own rule belongs in its prompt, next to the validator that enforces it.
    text: z.string().describe('One-sentence caption, grounded in the evidence supplied for this stage.'),
  }).strict()).optional().describe('One-sentence captions below nodes.'),
  is_update: coercedBoolean().optional().describe('True only when updating an existing presentation.'),
}).strict();

/**
 * One section of a report that is already committed: `text` may be omitted to keep the committed
 * body under that label.
 */
const PresentResultRetainedSectionSchema = PresentResultSectionSchema.extend({
  text: z.string().optional().describe('Detail body. Omit to keep the committed text for this label; supply it only to rewrite that section.'),
});

/**
 * Projects a `present_result` schema onto a render that amends a committed report.
 *
 * @remarks
 * DERIVED by `.extend()` from whichever stage schema the caller passes, so a stage projection and
 * its retaining counterpart cannot drift. Retention is resolved by the dispatcher against the
 * committed sections before validation, which therefore still sees a complete section array — this
 * relaxes what the model must resend, never what a render must contain.
 *
 * @param schema - The stage schema to relax.
 * @returns The same schema with `sections` optional and each section's `text` optional.
 */
function withRetainableSections<T extends z.ZodObject<z.ZodRawShape>>(schema: T) {
  return schema.extend({
    sections: coercedStringArray(PresentResultRetainedSectionSchema, { min: 1 }).optional()
      .describe('Final report sections. Omit entirely to keep the committed report; list a label with no text to keep that section unchanged.'),
  });
}

/** Preview reuses discovery prose; the model supplies only structure and graph decoration. */
const PresentResultVisualPreviewModelSchema = PresentResultModelSchema.omit({
  name: true,
  summary: true,
  title: true,
  intro: true,
  closing: true,
  prune_node_ids: true,
  add_node_ids: true,
  is_update: true,
}).strict();

/**
 * Runs every parse-time boundary recovery `present_result` payloads share, in the order each needs
 * the last one to have already run.
 *
 * @remarks
 * {@link repairArrayBoundaryArtifacts} rejoins a broken array-element boundary first (so a
 * `sections` entry recovered from a corrupted tail is a real section before anything inspects it),
 * then {@link hoistSectionNotes} relocates any section-nested `notes` — including on a
 * just-recovered section — onto the top-level `notes[]` array. Both are no-ops (return the input
 * unchanged) on a payload that carries neither defect shape.
 */
function recoverPresentResultPayload(value: unknown): unknown {
  return hoistSectionNotes(repairArrayBoundaryArtifacts(value));
}

/**
 * Selects the model-facing `present_result` schema from the phase and held-draft authorization.
 * Preview omits AI-authored wrapper prose; synthesis uses the full new-render contract; either
 * phase projects the existing strict patch schema while a repairable draft is held.
 *
 * @remarks
 * Every branch here declares both `sections` and top-level `notes` (optional), so
 * {@link recoverPresentResultPayload} is unconditionally safe to run ahead of the chosen schema's
 * own parse — see {@link hoistSectionNotes} and {@link repairArrayBoundaryArtifacts} for the
 * measured defects this closes.
 *
 * `retainable` is a live session fact, not a stage property: a render amends a committed report
 * only while the run that authored it is still the one rendering. Preview never amends.
 *
 * @param phase - Stage the call will be dispatched in.
 * @param repairFields - Fields a held draft authorizes for repair, when one is held.
 * @param retainable - Whether a committed report from this run exists to amend.
 * @returns The schema this stage offers the model.
 */
export function presentResultSchemaForPhase(
  phase?: string,
  repairFields: readonly PresentResultRepairField[] | null = null,
  retainable = false,
): z.ZodType {
  if (repairFields) return presentResultRepairPatchSchemaForFields(repairFields);
  if (phase === 'visual_preview') return z.preprocess(recoverPresentResultPayload, PresentResultVisualPreviewModelSchema);
  const synthesis = phase === 'synthesis';
  const schema = retainable
    ? (synthesis ? PresentResultRetainingSynthesisModelSchema : PresentResultRetainingModelSchema)
    : (synthesis ? PresentResultSynthesisModelSchema : PresentResultModelSchema);
  return z.preprocess(recoverPresentResultPayload, schema);
}

/**
 * Runtime boundary schema for `presentResult` — structural shape only.
 *
 * @remarks
 * Identical to {@link PresentResultModelSchema} but for one requirement: `highlight_groups` drops
 * `min(1)`, which is conditional (exempt when the render amends an existing one) and therefore not
 * expressible on a schema. `validatePresentResult` owns that condition.
 *
 * It drops no cap, because no cap is enforced at any parse: every content cap is advertised through
 * {@link advertisedMax} and enforced by `validatePresentResult`, the one rejection point that can
 * state the measured size, hold the draft, and authorize the single field to resend. Everything
 * type/enum/shape-shaped still rejects here with Zod issue paths fed back to the model.
 */
export const PresentResultBoundarySchema = PresentResultModelSchema.extend({
  highlight_groups: z.array(HighlightGroupSchema).optional(),
});

/**
 * Boundary projection for the stages whose offered schema carries no graph-edit controls.
 *
 * @remarks
 * DERIVED from {@link PresentResultBoundarySchema} via the same `.omit()` list
 * {@link PresentResultSynthesisModelSchema} applies to the model-facing schema, so the offered
 * contract and the validated contract cannot drift.
 *
 * `is_update` stays accepted here while the model-facing projection omits it: a session-authorized
 * held draft is merged back into the payload with the held draft's own `is_update` before this
 * parse runs, so omitting the key would reject the repair path. Its stage rules are owned by the
 * dispatcher's held-draft branch and by `isAmendment`.
 */
const PresentResultLockedGraphBoundarySchema = PresentResultBoundarySchema.omit({
  prune_node_ids: true,
  add_node_ids: true,
});

/**
 * Selects the runtime boundary schema matching the contract the model was offered at this stage.
 *
 * @remarks
 * The mirror of {@link presentResultSchemaForPhase} on the dispatch side: a field the offered
 * schema omits is rejected by the schema, not by a hand-written check after a permissive parse.
 * Preview shares the synthesis projection — the prose fields the preview model schema omits are
 * filled by the dispatcher from the cached discovery answer before the parse, so only the
 * graph-edit controls are out of contract there.
 *
 * The graph-edit controls are opt-in: `completed` is the only stage whose consumers read
 * `add_node_ids`/`prune_node_ids`, so it alone selects the full schema and every other stage —
 * including one added to {@link PresentResultStage} and not wired here — gets the locked
 * projection.
 *
 * @param phase - Stage the call was dispatched in.
 * @param retainable - Whether a committed report from this run exists to amend; mirrors the same
 * argument to {@link presentResultSchemaForPhase} so the offered and validated contracts match.
 * @returns The full boundary schema on the completed stage, else the locked-graph projection.
 */
export function presentResultBoundarySchemaForPhase(phase?: PresentResultStage, retainable = false): z.ZodType {
  if (phase === 'completed') {
    return retainable ? PresentResultRetainingBoundarySchema : PresentResultBoundarySchema;
  }
  return retainable ? PresentResultRetainingLockedGraphBoundarySchema : PresentResultLockedGraphBoundarySchema;
}

/**
 * Strict patch schema for repairing a held `present_result` draft.
 *
 * @remarks
 * A repair payload is accepted whenever the session holds a previously held full draft from a narrow
 * repairable failure; because that held-draft context IS the authorization, `is_update` is an
 * engine-declared default (backfilled to true) rather than a value the model must echo — it does not
 * drive `isAmendment` during synthesis (that needs the completed phase). It may replace presentation
 * text/link/color fields (all
 * optional — an omitted key keeps the held draft's value) but cannot edit graph structure. Unknown
 * fields reject at the Zod boundary. DERIVED from {@link PresentResultModelSchema} via `.pick().partial()`
 * — not hand-listed — so a presentation field added there can never silently drift out of the repair
 * contract. `prune_node_ids`/`add_node_ids` are deliberately NOT picked: a repair patch cannot edit
 * graph structure. The inferred type lives in `presentResult.ts` (its sole consumer) as the single
 * source of truth.
 */
export const PresentResultRepairPatchSchema = PresentResultModelSchema.pick({
  name: true,
  summary: true,
  title: true,
  intro: true,
  closing: true,
  layout_direction: true,
  highlight_groups: true,
  sections: true,
  notes: true,
}).partial().extend({
  is_update: coercedBoolean().optional().describe('Optional — while a held draft is being repaired the engine authorizes the repair from the held-draft context and defaults this to true; you need not set it.'),
}).strict();

/** Presentation fields that a held-draft rejection may explicitly authorize for repair. */
export const PRESENT_RESULT_REPAIR_FIELDS = [
  'name',
  'summary',
  'title',
  'intro',
  'closing',
  'layout_direction',
  'highlight_groups',
  'sections',
  'notes',
] as const;

/** Presentation field that may be authorized in a held-draft repair patch. */
export type PresentResultRepairField = typeof PRESENT_RESULT_REPAIR_FIELDS[number];

/**
 * Per-field-set memo for {@link presentResultRepairPatchSchemaForFields}.
 *
 * @remarks
 * A fresh `.pick().strict()` schema is a new object identity even for a field set requested
 * before, which defeats `toModelJsonSchema`'s WeakMap cache (keyed on schema identity — see
 * `jsonSchema.ts`) on every repair-turn call. Keying on the sorted, de-duplicated field list
 * lets the same authorized field set reuse the same schema object, and therefore the same
 * memoized JSON Schema, across repair turns.
 */
const repairPatchSchemaCache = new Map<string, z.ZodType>();

/**
 * Builds the strict provider/runtime patch schema for exactly the authorized held-draft fields.
 *
 * @remarks
 * `superRefine`s in one required-shape rule: a patch naming none of the authorized fields (only
 * `is_update`, or nothing at all) rejects here, at the same Zod boundary as every other structural
 * violation, with one issue per authorized field so `issuePaths` names the whole authorized set.
 * Without this, an empty patch parsed successfully, merged nothing into the held draft, and
 * re-ran the full held-draft validation — reproducing the identical prior rejection with no signal
 * that the patch itself carried no correction (`toolAttempt.ts` issue log, m10 2026-09-15). This is
 * a prevalidation reject (`vscodeModelPort.ts` / the harness port both `safeParse` against this
 * exact schema object before dispatch), never a check added after the handler runs.
 */
export function presentResultRepairPatchSchemaForFields(
  fields: readonly PresentResultRepairField[],
): z.ZodType<z.infer<typeof PresentResultRepairPatchSchema>> {
  const keys = [...new Set<PresentResultRepairField>(fields)].sort();
  const cacheKey = keys.join(',');
  const cached = repairPatchSchemaCache.get(cacheKey);
  if (cached) return cached as z.ZodType<z.infer<typeof PresentResultRepairPatchSchema>>;
  const mask = Object.fromEntries([...keys, 'is_update'].map(key => [key, true]));
  const picked = PresentResultRepairPatchSchema.pick(
    mask as Partial<Record<keyof typeof PresentResultRepairPatchSchema.shape, true>>,
  ).strict().superRefine((data, ctx) => {
    if (keys.length === 0) return;
    const touchesAuthorizedField = keys.some(
      key => (data as Record<string, unknown>)[key] !== undefined,
    );
    if (touchesAuthorizedField) return;
    const message = `Repair patch named no authorized field; send is_update:true plus at least one of: ${keys.join(', ')}.`;
    for (const key of keys) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message });
    }
  });
  // repairArrayBoundaryArtifacts never introduces a key the picked shape doesn't already declare —
  // it only rejoins or drops content inside an array the payload already carries — so it runs
  // unconditionally. hoistSectionNotes DOES add a top-level `notes` key, which only the picked shape
  // declaring both `sections` and `notes` together can accept; authorized without `notes` (or
  // without `sections`), the hoist would inject a key this narrower patch never declares and reject
  // it as unrecognized, so it is skipped rather than applied unconditionally — see
  // {@link hoistSectionNotes}.
  const preprocess = keys.includes('sections') && keys.includes('notes')
    ? recoverPresentResultPayload
    : repairArrayBoundaryArtifacts;
  const schema = z.preprocess(preprocess, picked) as z.ZodType<z.infer<typeof PresentResultRepairPatchSchema>>;
  repairPatchSchemaCache.set(cacheKey, schema);
  return schema;
}

/**
 * Model-facing schema for a new synthesis render.
 *
 * @remarks
 * Initial synthesis is a complete commit attempt, so the provider must require the same authored
 * fields as {@link PresentResultModelSchema}: `name`, `summary`, and a non-empty
 * `highlight_groups`. Graph-edit controls and `is_update` are omitted because they are not legal on a
 * new render. A narrow repair patch remains a session-authorized recovery contract: it is projected
 * to the provider and accepted by the dispatcher only while the session holds a full draft from an
 * explicitly repairable runtime validation failure.
 *
 * DERIVED from {@link PresentResultModelSchema} via `.omit()` — not hand-listed — so presentation
 * fields cannot drift while the new-render requiredness stays intact.
 */
export const PresentResultSynthesisModelSchema = PresentResultModelSchema.omit({
  prune_node_ids: true,
  add_node_ids: true,
  is_update: true,
}).strict();

/**
 * The four stage projections a render that amends a committed report is offered and parsed against.
 *
 * @remarks
 * Declared here rather than beside each source because {@link PresentResultSynthesisModelSchema} is
 * the last source to exist; the two selectors read them, so each is built once per process.
 * A supplement round exits through synthesis, not the completed stage, so both stages have a
 * retaining projection.
 */
const PresentResultRetainingModelSchema = withRetainableSections(PresentResultModelSchema);
const PresentResultRetainingSynthesisModelSchema = withRetainableSections(PresentResultSynthesisModelSchema);
const PresentResultRetainingBoundarySchema = withRetainableSections(PresentResultBoundarySchema);
const PresentResultRetainingLockedGraphBoundarySchema = withRetainableSections(PresentResultLockedGraphBoundarySchema);

/**
 * Model-facing `lineage_submit_findings` input schema (the permissive BB∪CT superset).
 *
 * @remarks
 * VS Code registers ONE `lineage_submit_findings` tool, so the model sees ONE schema —
 * the union of the BB and CT contracts (verdict `analyze | passthrough | prune`, both `prune_neighbors`
 * and `column_flow`). Instruction-plan compilation advertises the strict mode-and-classification-locked
 * schema (`submitFindingsSchemaForMode`) immediately before model dispatch, and the handler validates
 * the payload against that same contract. This is the model-facing source the drift guard pins
 * against `package.json`; it is not a second hand-authored JSON Schema.
 */
export const SubmitFindingsModelSchema = z.object({
  focus_node_id: z.string().describe('Exact current focus-node ID supplied by the runtime frame.'),
  sections: coercedStringArray(z.object({
    angle: z.enum(['business', 'technical']).describe('The locked output angle represented by this section.'),
    text: z.string().describe('Grounded analysis for this node under the selected angle.'),
  }).strict(), { max: SUBMIT_FINDINGS_SECTIONS_MAX }).describe('One grounded section for each output angle required by the locked classification.'),
  summary: z.string().describe('One-line digest retained for later hops after older turns are wiped. Aim for one line; length is never a rejection axis.'),
  // The permissive BB∪CT superset registered with VS Code (see remarks above) uses the BB wording:
  // it is the broader, VS Code-registered surface, and the strict per-mode schema (bb/ct) is what
  // actually gates the model immediately before dispatch — see submitFindingsSchemaForMode.
  verdict: hopVerdictSchema('bb'),
  route_requests: coercedStringArray(RouteRequestSchema, { max: AI_MAX_SCOPE_NODE_IDS }).optional().describe(ROUTE_REQUESTS_DESCRIPTION),
  prune_neighbors: coercedStringArray(z.string(), { max: AI_MAX_SCOPE_NODE_IDS }).optional().describe(PRUNE_NEIGHBORS_DESCRIPTION),
  column_flow: ColumnFlowSchema.optional(),
  badge_label: advertisedMax(z.string(), { maxLength: SUBMIT_FINDINGS_BADGE_LABEL_MAX }).min(1)
    .refine(value => value.trim().length > 0, 'badge_label must contain non-whitespace text')
    .optional()
    .describe(BADGE_LABEL_DESCRIPTION),
}).strict();

/**
 * Validates a discovery-tool input against its Zod schema.
 *
 * @remarks
 * The single runtime validation surface for the discovery tools: the Zod schema in this file is
 * the SSOT — no second hand-written field map. The first Zod issue drives the hint so the model
 * gets a concrete, self-correcting message.
 *
 * @param schema - The tool's input schema (e.g. {@link SearchObjectsInputSchema}).
 * @param input - The raw input object provided by the language model.
 * @returns Parsed data on success, or a structured rejection preserving the first Zod issue.
 */
export function parseToolInput<T extends z.ZodType>(
  schema: T,
  input: unknown,
):
  | { readonly ok: true; readonly data: z.output<T> }
  | { readonly ok: false; readonly error: { readonly error: typeof REJECTION_CODES.invalidInput; readonly field: string; readonly hint: string } } {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issue = parsed.error.issues[0];
  const field = issue.path.length ? issue.path.join('.') : '(input)';
  return {
    ok: false,
    error: { error: REJECTION_CODES.invalidInput, field, hint: `Field "${field}": ${issue.message}` },
  };
}
