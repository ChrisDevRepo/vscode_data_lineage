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
  ExplorationDepthLimitSchema,
  ExplorationDepthSelectionSchema,
} from '../../engine/shared/explorationDepthContract';
import { coercedBoolean, coercedStringArray, coercedStringObject, declaredKeysOnly, hoistSectionNotes, hoistSectionTopLevelFields, nullAsAbsent, rejoinSectionTextBoundaryArtifacts, repairArrayBoundaryArtifacts, splitFlattenedAngleSections } from '../support/inputNormalization';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { CLASSIFICATION_KEPT_ANGLES, type ClassificationValue } from '../session/classification';
import type { CapturedSection } from '../session/memoryManager';
import type { HopFinding, HopFindingKept } from '../sm/smTypes';
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
    'Constraints the user stated that no filter field expresses (e.g. "ignore filter criteria"), one short note '
    + "each in the user's terms; echoed at the approval gate and carried to every hop.",
  );

const ClassificationValueSchema = z.enum(['business', 'technical', 'both'])
  .describe(
    'Answer angle the user asked for: "business" only when the user asks for the business view (meaning, '
    + 'impact, business rules); "technical" only when the user asks for a technical lens (performance, indexes, '
    + 'execution plan, query shape, load pattern); otherwise "both" — a question in neither terms, or in both.',
  );

const SupplementNodeIdsSchema = z.array(z.string().min(1)).min(1).max(AI_MAX_SCOPE_NODE_IDS).describe(
  'Resolved object IDs that require new per-node analysis in the completed exploration; use present_result add_node_ids for presentation-only additions.',
);
/**
 * Chain extension of a supplement: the named objects plus everything reachable from them.
 *
 * @remarks
 * The approve gate covers the first run up to its presented result; a later request is the user's
 * own and is not bounded by that contract. A chain is walked from each named id in the one stated
 * direction; only the user's own exclusions stay a wall.
 */
const SupplementChainSchema = z.object({
  direction: z.enum(['upstream', 'downstream']).describe('"upstream" walks toward the sources, "downstream" toward the consumers.'),
  depth: ExplorationDepthLimitSchema.describe('Steps to walk from each named object; "all" follows the chain to its end.'),
}).strict();

const SupplementSchema = z.object({
  nodeIds: SupplementNodeIdsSchema,
  chain: SupplementChainSchema.optional().describe(
    'Set when the user asks to follow the named objects further, e.g. "all the way to the source": every object '
    + 'reachable in that direction is analysed and joins the same graph. Omit to add the named objects only.',
  ),
}).strict().describe('Completed-session analysis extension; valid only after the prior exploration has completed.');

/**
 * Single source for the `depth` describe text on both {@link StartExplorationInputSchema} and
 * every provider branch spread through `StartPatchFields` — one canonical home instead of a
 * second literal duplicating it. The per-side `0` clause matches
 * {@link ExplorationDepthSideSchema}'s own contract (`explorationDepthContract.ts`) and
 * `isReachableInApprovedDirection` (`smBase.ts`): 0 is a permanent border for the rest of the
 * session, not merely a one-time skip of the initial seed.
 *
 * @remarks
 * A finite number or per-side object is a hard border only when paired with
 * {@link StartDepthStatedSchema} `true` — see that schema's remarks for why the pairing exists.
 */
const StartDepthSchema = coercedStringObject(ExplorationDepthSelectionSchema).nullable().optional().describe(
  'Starting scope in levels: a positive integer copied from a level count the user literally stated (e.g. "two levels", "one hop upstream"); "all" for an explicit unbounded ask ("every source", "the complete chain"); or per-side {upstream, downstream} with direction "bidirectional", where 0 closes that side for the session. Omit both depth and depthStated whenever the user gave no level count and no unbounded ask — including "back to the source", "where does X come from", or any wording with no number — the engine seeds a reviewed default that keeps growing. A finite number here also requires depthStated: true or it is treated as unstated; never invent a number to fill this field.',
);

/**
 * Marks a finite {@link StartDepthSchema} value (a positive integer, or an asymmetric object with
 * at least one finite side) as copied verbatim from a level count the user stated, rather than a
 * starting estimate the model chose. `"all"` never needs this flag — it can only ever grow the
 * scope, never truncate it, so an un-stated `"all"` is already safe.
 *
 * @remarks
 * The host never reads the user's sentence (`AGENTS.md` §Runtime Contract), so it cannot verify a
 * finite depth is truly the user's own count; this field is the one place that intent is declared
 * instead of inferred from the shape of `depth` alone. Reaching the engine, a finite depth sent
 * without this flag is treated as unstated and seeds the same soft, growing default as an omitted
 * `depth` — never a hard stop the model invented on its own; the demotion is logged, per side, as
 * a `[Normalize]` line (`resolveDepthIntentForBoundary`/`gateDepthSide` in `smTypes.ts`,
 * `startExploration.ts`), never silent.
 */
const StartDepthStatedSchema = coercedBoolean().optional().describe(
  'true only when depth is a level count the user literally stated. Omit (or send false) whenever depth is your own estimate of where to start — a finite depth sent without depthStated:true is treated as unstated and seeded as a soft, growing default, never a hard stop.',
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

const ANALYSIS_MODE_DESCRIPTION =
  'Required for fresh exploration: "bb" traces whole objects; "ct" traces named columns. Default to "bb" when unclear.';

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
    ANALYSIS_MODE_DESCRIPTION,
  ),
  targetColumns: coercedStringArray(ColumnIdentifierSchema).optional().describe(
    'CT only: user-named columns to trace. BB forbids this property; a raw provider empty BB array may normalize to absence.',
  ),
  direction: z.enum(['upstream', 'downstream', 'bidirectional']).optional().describe('Lineage direction requested by the user: upstream for sources/inputs, downstream for usage/impact, bidirectional for both. "upstream"/"downstream" is a hard border excluding the other side entirely; use "bidirectional" with per-side depths for a lopsided start.'),
  depth: StartDepthSchema,
  depthStated: StartDepthStatedSchema,
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
const StartDirectionSchema = z.enum(['upstream', 'downstream', 'bidirectional']).optional().describe('Lineage direction requested by the user: upstream for sources/inputs, downstream for usage/impact, bidirectional for both. "upstream"/"downstream" is a hard border excluding the other side entirely; use "bidirectional" with per-side depths for a lopsided start.');
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
  depthStated: StartDepthStatedSchema,
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
    ANALYSIS_MODE_DESCRIPTION,
  ),
  classification: ClassificationValueSchema,
  targetColumns: EmptyBbTargetColumnsSchema,
}).strict().superRefine(refineAsymmetricDepthDirection);

/** Fresh CT proposal branch. It cannot encode refine or supplement fields. */
const StartFreshCtProviderSchema = z.object({
  ...StartPatchFields,
  origin: StartOriginSchema,
  analysisMode: z.literal('ct').describe(
    ANALYSIS_MODE_DESCRIPTION,
  ),
  classification: ClassificationValueSchema,
  targetColumns: NamedCtTargetColumnsSchema,
}).strict().superRefine(refineAsymmetricDepthDirection);

/** Pending-proposal patch branch. Omitted fields are merged mechanically by the dispatcher. */
const StartRefineProviderSchema = z.object({
  ...StartPatchFields,
  proposalRevision: z.number().int().positive().describe('Revision shown by the pending approval gate.'),
  analysisMode: z.enum(['bb', 'ct']).optional().describe(
    ANALYSIS_MODE_DESCRIPTION,
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
    ANALYSIS_MODE_DESCRIPTION,
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
    'Upstream levels: a positive integer, "all" for the whole chain, or 0 to exclude upstream.',
  ),
  downstream_depth: ScopeDepthSchema.describe(
    'Downstream levels: a positive integer, "all" for the whole chain, or 0 to exclude downstream.',
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
  angle: z.enum(['business', 'technical']),
  /** Pre-formatted section body. */
  text: z.string().min(1),
}).strict();

/**
 * Single source for the `prune_neighbors` field describe text, shared by the strict per-mode
 * schemas and the permissive registered union so the two cannot drift.
 */
export const PRUNE_NEIGHBORS_DESCRIPTION =
  'Removes a neighbor you have not visited, and whatever only it leads to, based on this node\'s SQL alone; '
  + 'use it for writes this node makes that nothing reads.';

/** One `prune_neighbors[]` entry: the neighbour and why this node's SQL shows it is off the answer. */
const PruneNeighborSchema = z.object({
  id: z.string().min(1).describe('A neighbor id from `<hop_context>`.'),
  reason: z.string().min(1).describe('What in this node\'s SQL shows the neighbor is off the answer.'),
}).strict();

/**
 * Single source for the `questions` field describe text, shared by the strict per-mode schemas and
 * the permissive registered union.
 */
const QUESTIONS_DESCRIPTION =
  'Optional: a specific check for one neighbor (a rule, filter or calculation to establish there). '
  + 'Every open neighbor you do not prune is visited next. '
  + 'A question on a neighbor you prune is not checked in this run; it is offered to the user as a follow-up.';

/** One `questions[]` entry, attached to that neighbour's queued hop. */
const NeighborQuestionSchema = z.object({
  nodeId: z.string().min(1).describe('A neighbor id from `<hop_context>`.'),
  question: z.string().min(1).describe('The check, self-contained: name the neighbor and what to establish there.'),
}).strict();

/**
 * Single source for the end_branch row-decision condition — reused by both the `reason` describe
 * text and {@link HopVerdictSchema}'s `end_branch` clause, so the "row decision" definition is
 * stated once, not restated per site.
 */
const END_BRANCH_ROW_DECISION_CONDITION =
  'no tracked column and no row decision reaches the start object through this node; '
  + 'a statement that filters, inserts, updates or deletes rows of a table on the path is a row decision.';

/** Single source for the `reason` describe text of an `end_branch` submit. */
const END_BRANCH_REASON_DESCRIPTION =
  'Required with end_branch, and then the only field besides focus_node_id and verdict: why '
  + END_BRANCH_ROW_DECISION_CONDITION;

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
export const BADGE_LABEL_DESCRIPTION = '2-4 word label for this node.';

/**
 * Hard cap on `column_flow[].upstream_columns[].note`.
 *
 * @remarks
 * Advertised on the model-facing `submit_findings` schemas through {@link advertisedMax} and
 * enforced by `NavigationEngine.submitFindings`, before any mutation.
 */
export const COLUMN_FLOW_NOTE_MAX = 200;

const ColumnRefSchema = z.object({
  node: z.string(),
  col: z.string(),
  transforms: z.array(ColumnTransformClassSchema).optional().describe(
    'How THIS upstream column\'s value reaches out_col, judged end to end: ignore intermediate copies into ' +
    'temp tables or variables, and list every class this column\'s own role proves — usually one. Omit the ' +
    'field entirely when the DDL does not determine it; never guess. pass_through: out_col is this column\'s ' +
    'value unchanged (rename, SELECT *, synonym, straight copy). compute: out_col is an expression over this ' +
    'column (formula, CASE, COALESCE, cast, concat, string/date function). aggregate: this column is ' +
    'summarised into out_col (SUM/COUNT/MIN/MAX, GROUP BY, window function, PIVOT). combine: this column is ' +
    'itself a join key, or is merged by UNION/EXCEPT/INTERSECT, APPLY, UNPIVOT. filter: this column itself ' +
    'appears in a WHERE, HAVING, join ON predicate, TOP or DISTINCT.',
  ),
  note: advertisedMax(z.string(), { maxLength: COLUMN_FLOW_NOTE_MAX }).optional().describe(
    'The deciding expression, at most ~12 words.',
  ),
}).strict();

const ColumnFlowWritesToObject = z.object({
  node: z.string(),
  col: z.string(),
}).strict();

const ColumnFlowEntryObject = z.object({
  out_col: z.string().describe('The tracked column as named on this node; for a procedure, the column it writes.'),
  writes_to: nullAsAbsent(declaredKeysOnly(ColumnFlowWritesToObject).optional()).describe('Procedure focus: the table column the value is written to.'),
  upstream_columns: z.array(ColumnRefSchema).describe(
    'Two states by focus: at a bodied focus, the real upstream columns the node READS that contribute to out_col ' +
    '(never columns it computes or writes out); at a focus with no body of its own, continuation — name the neighbours ' +
    'on this focus\'s carrier side (the nodes that write it on an upstream trace, the nodes that read it on a downstream ' +
    'trace), carrying the tracked column unchanged; use [] only when out_col terminates here.',
  ),
}).strict();

const ColumnFlowEntrySchema = declaredKeysOnly(ColumnFlowEntryObject);


/**
 * `verdict` field for `submit_findings`: one definition set for BB, CT and the registered union.
 *
 * @remarks
 * CT is BB plus columns, so the verdict words mean the same in both modes. `end_branch` is the one
 * home of the cut's contract; its payload shape (reason only) is enforced by
 * {@link refineSubmitFindingsShape}.
 */
const HopVerdictSchema = z.enum(['analyze', 'passthrough', 'end_branch']).describe(
  'analyze: transforms data on the answer path (a calculation, condition, filter, join or status change). '
  + 'passthrough: on the path, handing values on unchanged (a stored table, SELECT *, a synonym). '
  + 'end_branch: Removes this node and every node reachable only through it from the result, for the rest of this run; '
  + 'use only when ' + END_BRANCH_ROW_DECISION_CONDITION + ' Never the start object.',
);

const ColumnFlowSchema = z.array(ColumnFlowEntrySchema).max(AI_MAX_SCOPE_NODE_IDS).describe(
  'Required with verdict analyze or passthrough, omitted with end_branch: one entry per tracked column this node carries; [] when it carries none. `upstream_columns` names what each neighbor carries.',
);

/**
 * `submit_findings.sections[]` length cap: one angle per classification, two under `both`. Single
 * governor for the cap so the base, registered-union, and classification-narrowed schemas cannot
 * drift apart on it.
 */
const SUBMIT_FINDINGS_SECTIONS_MAX = 2;

/** Single source for the `summary` describe text, shared by the per-mode schemas and the registered union. */
const SUMMARY_DESCRIPTION =
  'One sentence, readable without this hop: what this node does to the data and what it hands to which node.';

/**
 * Shared `submit_findings` fields across BB and CT modes, one flat object.
 *
 * @remarks
 * Flat by design: a top-level `anyOf` defeats constrained decoding, so the verdict-dependent shape
 * (a kept verdict carries sections and summary, `end_branch` carries only `reason`) is stated in
 * the describes and enforced by {@link refineSubmitFindingsShape} at parse.
 */
const HopFindingBaseSchema = z.object({
  focus_node_id: z.string().describe('`focus_node.id` from `<hop_context>`.'),
  verdict: HopVerdictSchema,
  /**
   * One section per fired `*_capture` template. Length 1 (`business` / `technical`
   * classification) or 2 (`both`) — required with a kept verdict (a kept node always commits its analysis).
   */
  sections: coercedStringArray(CapturedSectionSchema, { max: SUBMIT_FINDINGS_SECTIONS_MAX }).optional().describe('One entry per capture recipe in this hop\'s message.'),
  summary: z.string().optional().describe(SUMMARY_DESCRIPTION),
  badge_label: advertisedMax(z.string(), { maxLength: SUBMIT_FINDINGS_BADGE_LABEL_MAX }).min(1)
    .refine(value => value.trim().length > 0, 'badge_label must contain non-whitespace text')
    .optional()
    .describe(BADGE_LABEL_DESCRIPTION),
  prune_neighbors: coercedStringArray(PruneNeighborSchema, { max: AI_MAX_SCOPE_NODE_IDS }).optional().describe(PRUNE_NEIGHBORS_DESCRIPTION),
  questions: coercedStringArray(NeighborQuestionSchema, { max: AI_MAX_SCOPE_NODE_IDS }).optional().describe(QUESTIONS_DESCRIPTION),
  reason: nullAsAbsent(z.string().optional()).describe(END_BRANCH_REASON_DESCRIPTION),
}).strict();

const { badge_label, prune_neighbors, questions, reason } = HopFindingBaseSchema.shape;

/**
 * CT form: the BB form plus `column_flow` (required with a kept verdict), declared right after
 * `summary` so it is authored with the analysis rather than after the routing tail.
 */
const HopFindingCtBaseSchema = HopFindingBaseSchema
  .omit({ badge_label: true, prune_neighbors: true, questions: true, reason: true })
  .extend({ column_flow: ColumnFlowSchema.optional(), badge_label, prune_neighbors, questions, reason })
  .strict();

/** Every top-level `submit_findings` key other than `sections`, in BB and CT form alike. */
const FINDING_TOP_LEVEL_FIELDS = Object.keys(HopFindingCtBaseSchema.shape).filter(key => key !== 'sections');

/** The flat parsed payload, before {@link toHopFinding} narrows it by verdict. */
type FlatSubmitFindings = z.output<typeof HopFindingBaseSchema> & { column_flow?: z.output<typeof ColumnFlowSchema> };

/** Fields a kept verdict may carry and an `end_branch` must not. */
const END_BRANCH_EXCLUDED_FIELDS = ['sections', 'summary', 'badge_label', 'column_flow', 'prune_neighbors', 'questions'] as const;

/**
 * Enforces the verdict-dependent shape of one flat `submit_findings` payload.
 *
 * @remarks
 * `end_branch` carries only `focus_node_id`, `verdict` and a required `reason`; a kept verdict
 * carries `sections` and `summary` (and, in CT, `column_flow`) and never `reason`. Each fault is one
 * issue on its own path, so the rejection names the exact field to drop or add.
 */
function refineSubmitFindingsShape(value: FlatSubmitFindings, ctx: z.RefinementCtx, mode: 'bb' | 'ct'): void {
  if (value.verdict === 'end_branch') {
    for (const field of END_BRANCH_EXCLUDED_FIELDS) {
      if (value[field] === undefined) continue;
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: `not accepted with verdict end_branch — an end_branch submit carries only focus_node_id, verdict and reason; remove ${field}, or submit analyze or passthrough to keep the node.`,
      });
    }
    const reasonMessage = 'required with verdict end_branch: why nothing on the answer path runs through this node.';
    if (value.reason === undefined) {
      ctx.addIssue({ code: 'invalid_type', expected: 'string', input: undefined, path: ['reason'], message: reasonMessage });
    } else if (!value.reason.trim()) {
      ctx.addIssue({ code: 'custom', path: ['reason'], message: reasonMessage });
    }
    return;
  }
  if (value.reason !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['reason'], message: `accepted only with verdict end_branch; with ${value.verdict}, state the findings in sections and summary and remove reason.` });
  }
  if (value.sections === undefined) {
    ctx.addIssue({ code: 'invalid_type', expected: 'array', input: undefined, path: ['sections'], message: `required with verdict ${value.verdict}.` });
  }
  if (value.summary === undefined) {
    ctx.addIssue({ code: 'invalid_type', expected: 'string', input: undefined, path: ['summary'], message: `required with verdict ${value.verdict}.` });
  }
  if (mode === 'ct' && value.column_flow === undefined) {
    ctx.addIssue({ code: 'invalid_type', expected: 'array', input: undefined, path: ['column_flow'], message: `required with verdict ${value.verdict}: one entry per tracked column this node carries, [] when it carries none.` });
  }
}

/**
 * Narrows a shape-checked flat payload to the {@link HopFinding} union the engine consumes.
 *
 * @param value - A payload {@link refineSubmitFindingsShape} accepted.
 * @returns The `end_branch` or kept variant, carrying exactly that variant's fields.
 */
function toHopFinding(value: FlatSubmitFindings): HopFinding {
  if (value.verdict === 'end_branch') {
    return { focus_node_id: value.focus_node_id, verdict: 'end_branch', reason: value.reason ?? '' };
  }
  const kept: HopFindingKept = {
    focus_node_id: value.focus_node_id,
    verdict: value.verdict,
    sections: value.sections ?? [],
    summary: value.summary ?? '',
  };
  if (value.badge_label !== undefined) kept.badge_label = value.badge_label;
  if (value.prune_neighbors !== undefined) kept.prune_neighbors = value.prune_neighbors;
  if (value.questions !== undefined) kept.questions = value.questions;
  if (value.column_flow !== undefined) kept.column_flow = value.column_flow;
  return kept;
}

/**
 * Boundary recoveries for `submit_findings`: element and string boundaries first, then a flattened
 * second angle split out of its carrying section, then the top-level-field hoist.
 */
function recoverSubmitFindingsPayload(value: unknown): unknown {
  return hoistSectionTopLevelFields(
    splitFlattenedAngleSections(recoverSectionBoundaries(value), CapturedSectionSchema.shape.angle.options),
    FINDING_TOP_LEVEL_FIELDS,
  );
}

/** Applies the verdict-shape check and the union narrowing to one flat per-mode object. */
function finalizeSubmitFindingsSchema(
  schema: typeof HopFindingBaseSchema | typeof HopFindingCtBaseSchema,
  mode: 'bb' | 'ct',
): z.ZodType<HopFinding> {
  return z.preprocess(recoverSubmitFindingsPayload, schema
    .superRefine((value, ctx) => refineSubmitFindingsShape(value as FlatSubmitFindings, ctx, mode))
    .transform(value => toHopFinding(value as FlatSubmitFindings)));
}

/**
 * BB-mode submit_findings input.
 *
 * @remarks
 * The node's self-status is `analyze` (carries lineage), `passthrough` (kept, not a key transform),
 * or `end_branch` (cut: the node and every open node reachable only through it leave the result).
 * A kept verdict enqueues every open neighbour not named in `prune_neighbors`; `questions` attach a
 * check to one of them. BB does not carry CT-only `column_flow`.
 */
export const SubmitFindingsBbInputSchema = finalizeSubmitFindingsSchema(HopFindingBaseSchema, 'bb');

/**
 * CT-mode submit_findings input.
 *
 * @remarks
 * CT is BB plus column tracking, so every BB field is present on the CT form; `column_flow`'s own
 * contract is documented on {@link ColumnFlowSchema}, and its `upstream_columns` are the carry each
 * enqueued neighbour receives.
 */
export const SubmitFindingsCtInputSchema = finalizeSubmitFindingsSchema(HopFindingCtBaseSchema, 'ct');

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
    angle: z.literal(onlyAngle, { message: foldMessage }),
  }).strict();
}

/**
 * Selects the strict, mode-and-classification-locked `submit_findings` schema advertised to the
 * model during an active SM hop.
 *
 * @remarks
 * BB returns {@link SubmitFindingsBbInputSchema} (no `column_flow`); CT returns
 * {@link SubmitFindingsCtInputSchema} (`column_flow` required with a kept verdict). When
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
 * @returns The strict provider schema for that mode and classification, parsing to the
 * {@link HopFinding} union so the handler keeps a concrete `.data` type without a cast.
 */
export function submitFindingsSchemaForMode(mode: 'bb' | 'ct', classification?: ClassificationValue): z.ZodType<HopFinding> {
  if (!classification || CLASSIFICATION_KEPT_ANGLES[classification].length === 2) {
    return mode === 'ct' ? SubmitFindingsCtInputSchema : SubmitFindingsBbInputSchema;
  }
  const cacheKey = `${mode}:${classification}`;
  const cached = submitFindingsSchemaCache.get(cacheKey);
  if (cached) return cached;
  const narrowedSections = coercedStringArray(capturedSectionSchemaForClassification(classification), { max: SUBMIT_FINDINGS_SECTIONS_MAX })
    .optional()
    .describe('One entry per capture recipe in this hop\'s message.');
  const base = mode === 'ct' ? HopFindingCtBaseSchema : HopFindingBaseSchema;
  const schema = finalizeSubmitFindingsSchema(base.extend({ sections: narrowedSections }).strict() as typeof HopFindingCtBaseSchema, mode);
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
  ids: z.array(z.string().min(1)).min(1).describe('Neighbor ids, not the focus.'),
}).strict();

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
/** Hard cap on `name` (graph node label); its soft target is the field's own description. */
export const PRESENT_RESULT_NAME_MAX = 90;
/** Hard cap on `title` (report heading); its soft target is the `title` output template. */
export const PRESENT_RESULT_TITLE_MAX = 120;
/**
 * Hard cap on a `sections[].label`. The label's shape is owned by the field's own `.describe()`,
 * which states its role and deliberately no character target.
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
  color: HighlightSchemeSchema.describe('Flow role or status. `source`: the deepest origins whose data feeds the answer. `target`: where the data lands — the queried object in an upstream trace. `transform`: nodes that create or change the answer\'s values. `good` / `warn` / `fail`: diagnostic status. One scheme per result.'),
  node_ids: z.array(NodeIdSchema).describe('Node IDs that share this graph role or status; each is also linked in a section\'s node_ids or named in notes[].'),
}).strict();

/**
 * One final report section: a label that becomes both the section heading and the graph badge, the
 * nodes it explains, and its detail body.
 */
const PresentResultSectionSchema = z.object({
  label: advertisedMax(z.string(), { maxLength: PRESENT_RESULT_SECTION_LABEL_MAX }).describe('Short heading naming the section\'s role, unique in the report; also the badge on every linked node.'),
  node_ids: z.array(NodeIdSchema).optional().describe('Nodes this section documents; put a node in one section — naming it in more than one keeps its text in each but only the first keeps the badge and object link.'),
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
  closing: z.string().optional().describe('Closing synthesis. Length is never a rejection axis.'),
  prune_node_ids: z.array(NodeIdSchema).optional().describe('ONLY permitted during Completed Phase follow-ups. Strictly forbidden during the initial Synthesis Phase.'),
  add_node_ids: z.array(NodeIdSchema).optional().describe('ONLY permitted during Completed Phase follow-ups. Strictly forbidden during the initial Synthesis Phase.'),
  layout_direction: z.enum(['LR', 'TB']).optional().describe('Graph layout: left-to-right or top-to-bottom.'),
  highlight_groups: advertisedMax(z.array(HighlightGroupSchema).min(1), { maxItems: PRESENT_RESULT_HIGHLIGHT_GROUPS_MAX }).describe(
    'REQUIRED for new renders, 1-5 groups. For zero-trace or single-node results, use color "target" on the origin/result node.'
  ),
  sections: coercedStringArray(PresentResultSectionSchema, { min: 1 }).describe(
    'Required final report sections, at least one. Every node analysed and captured this turn '
    + '(anything with a detail slot) is linked into a section\'s node_ids, as that field describes — '
    + 'an analysed node absent from every section fails validation.',
  ),
  notes: z.array(z.object({
    node_id: NodeIdSchema.describe('Node ID receiving this below-node caption.'),
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
  return hoistSectionNotes(recoverSectionBoundaries(value));
}

/**
 * {@link repairArrayBoundaryArtifacts} then {@link rejoinSectionTextBoundaryArtifacts}, so a section
 * recovered from a swept tail is also checked for an early-closed `text`.
 */
function recoverSectionBoundaries(value: unknown): unknown {
  return rejoinSectionTextBoundaryArtifacts(repairArrayBoundaryArtifacts(value));
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
 * that the patch itself carried no correction. This is a prevalidation reject (`vscodeModelPort.ts`
 * / the harness port both `safeParse` against this exact schema object before dispatch), never a
 * check added after the handler runs.
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
  const preprocess = keys.includes('sections') && keys.includes('notes')
    ? recoverPresentResultPayload
    : recoverSectionBoundaries;
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
 * the union of the BB and CT contracts (verdict `analyze | passthrough | end_branch`, `prune_neighbors`,
 * `questions` and `column_flow`). Instruction-plan compilation advertises the strict mode-and-classification-locked
 * schema (`submitFindingsSchemaForMode`) immediately before model dispatch, and the handler validates
 * the payload against that same contract, verdict shape included. This is the model-facing source the drift guard pins
 * against `package.json`; it is not a second hand-authored JSON Schema.
 */
export const SubmitFindingsModelSchema = z.object({
  focus_node_id: z.string().describe('`focus_node.id` from `<hop_context>`.'),
  verdict: HopVerdictSchema,
  sections: coercedStringArray(z.object({
    angle: z.enum(['business', 'technical']),
    text: z.string(),
  }).strict(), { max: SUBMIT_FINDINGS_SECTIONS_MAX }).optional().describe('One entry per capture recipe in this hop\'s message.'),
  summary: z.string().optional().describe(SUMMARY_DESCRIPTION),
  prune_neighbors: coercedStringArray(PruneNeighborSchema, { max: AI_MAX_SCOPE_NODE_IDS }).optional().describe(PRUNE_NEIGHBORS_DESCRIPTION),
  questions: coercedStringArray(NeighborQuestionSchema, { max: AI_MAX_SCOPE_NODE_IDS }).optional().describe(QUESTIONS_DESCRIPTION),
  column_flow: ColumnFlowSchema.optional(),
  badge_label: advertisedMax(z.string(), { maxLength: SUBMIT_FINDINGS_BADGE_LABEL_MAX }).min(1)
    .refine(value => value.trim().length > 0, 'badge_label must contain non-whitespace text')
    .optional()
    .describe(BADGE_LABEL_DESCRIPTION),
  reason: nullAsAbsent(z.string().optional()).describe(END_BRANCH_REASON_DESCRIPTION),
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
