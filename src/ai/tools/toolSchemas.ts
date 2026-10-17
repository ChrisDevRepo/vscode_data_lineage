/**
 * Zod input schemas and lightweight runtime validation for the AI tools.
 * Zero VS Code imports — pure schema definitions.
 */
import { z } from 'zod';
import { resolveModelNodeId } from '../support/modelReferences';
import { normalizeColName } from '../../utils/sql';
import { MAX_ID_LIST_LENGTH, SCREEN_STATE_MAX_IDS, ColumnTransformClassSchema } from '../../engine/shared/bridgeContract';
import {
  ExplorationDepthLimitSchema,
  ExplorationDepthSelectionSchema,
} from '../../engine/shared/explorationDepthContract';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { rejectionFromZodError, type ToolRejection } from '../support/toolErrorEnvelope';
import { CLASSIFICATION_KEPT_ANGLES, type ClassificationValue } from '../session/classification';
import { extractRawSectionAngles } from '../interaction/rules/submitFindingsRules';
import type { IndexedRepairFields } from '../support/repairDraftStore';
import type { HeldSubmissionParts, HopFinding, HopFindingKept, HopSubmission } from '../sm/smTypes';

/**
 * A column identifier named by the user. Wildcards are rejected at the boundary: a
 * wildcard target column locks an unwinnable CT session because no real column can match it.
 */
export const ColumnIdentifierSchema = z.string().regex(/\S/, 'Must contain non-whitespace text.').min(1).regex(/^[^*%?]+$/, 'wildcards are not column identifiers').describe(
  'A field of a table or view that the user named verbatim; a column trace starts only when at least one such column is named. Wildcards are rejected at the boundary.',
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

/** Canonical answer-lens values and primary-intent instruction shared by entry and tool schemas. */
export const ClassificationValueSchema = z.enum(['business', 'technical', 'both'])
  .describe(
    'Choose the answer lens from the primary user intent: "business" for meaning, purpose, impact or business rules, '
    + 'and for unspecified or ambiguous intent. Incidental SQL, table or schema mentions, or a small technical subquestion, '
    + 'do not change a primary business lens; answer those details with supported evidence. "technical" only for clear overall technical intent '
    + '(performance, indexes, execution plan, query shape, load pattern); "both" only when the user explicitly asks for both perspectives. Required for a fresh proposal.',
  );

const SupplementNodeIdsSchema = z.array(z.string().min(1)).min(1).max(MAX_ID_LIST_LENGTH).describe(
  'Resolved object IDs that require new per-node analysis in the completed exploration; use present_result add_node_ids for presentation-only additions.',
);
/**
 * Chain extension of a supplement: the named objects plus everything reachable from them.
 *
 * @remarks
 * The approve gate covers the first run up to its presented result; a later request is the user's
 * own and is not bounded by that contract. A chain is walked from each named id in the one stated
 * direction; the user's exclusions and the approved GUI schema selection stay a wall.
 */
const SupplementChainSchema = z.object({
  direction: z.enum(['upstream', 'downstream']).describe('"upstream" walks toward the sources, "downstream" toward the consumers.'),
  depth: ExplorationDepthLimitSchema.describe('Steps to walk from each named object; "all" follows the chain to its end.'),
}).strict();

const SupplementSchema = z.object({
  nodeIds: SupplementNodeIdsSchema,
  chain: SupplementChainSchema.optional().describe(
    'Set when the user asks to follow the named objects further, e.g. "all the way to the source": every object '
    + 'reachable in that direction inside the approved schema selection is analysed and joins the same graph. Omit to add the named objects only; a named table also brings in its next objects in the approved direction.',
  ),
}).strict().describe(
  'Completed-session analysis extension, sent alone: a supplement call carries no other field — it runs in the '
  + "approved trace's scope. nodeIds lie inside the approved schema selection; an object outside it "
  + 'needs a fresh proposal (origin, no supplement).',
);

/**
 * Single source for the `depth` describe text on both {@link StartExplorationInputSchema} and
 * every provider branch spread through `StartPatchFields` — one canonical home instead of a
 * second literal duplicating it. Required for a fresh proposal, like {@link ClassificationValueSchema};
 * a refine may omit it to keep the reviewed proposal's depth. The per-side `0` clause matches
 * {@link ExplorationDepthSelectionSchema}'s own contract (`explorationDepthContract.ts`) and
 * `isReachableInApprovedDirection` (`smBase.ts`): 0 is a permanent border for the rest of the
 * session, not merely a one-time skip of the initial seed.
 */
const DEPTH_DESCRIPTION =
  'Starting scope: {upstream, downstream}, each {levels, exactness}; upstream levels reach the sources, downstream levels reach the consumers that read the origin. levels is a non-negative integer or "all"; 0 permanently closes that side for the session. "Original sources" or "all upstream sources" means upstream levels: "all"; "all downstream consumers" means downstream levels: "all"; "full chain" means levels: "all" in the requested direction. exactness is "exact" for a user-specified bound, including direct or immediate sources/consumers as {levels: 1, exactness: "exact"}; use "approximate" when the count is your own estimate — an approximate count above 0 does not bound the scope, which runs until the filters or the border stop it. Required for a fresh proposal; omit on a refine to keep the reviewed depth.';

const StartDepthSchema = ExplorationDepthSelectionSchema.nullish().describe(DEPTH_DESCRIPTION);

const ANALYSIS_MODE_DESCRIPTION =
  'Required for fresh exploration: "bb" traces whole objects; "ct" traces named columns. Default to "bb" when unclear.';

/** Issue text when a start_exploration call carries neither an origin nor a supplement. */
const START_SHAPE_REQUIRED_MESSAGE = "Either 'origin' (fresh proposal) or 'supplement' with nodeIds must be provided.";

/**
 * Recovery when column trace is requested without named columns.
 * The schema issue and the rejection hint are this one string.
 */
export const CT_TARGET_COLUMNS_RECOVERY =
  'Name the columns to trace; for all columns, read them with lineage_get_object_detail and send each one. Then resubmit CT.';

/** `targetColumns` on every exploration phase: column trace names the columns; blackboard forbids the property. */
const TARGET_COLUMNS_PHASE_DESCRIPTION =
  'CT only: name each column to trace. When the user asked for every column, read them with lineage_get_object_detail and send each one. BB forbids this property.';

const StartExcludeTypesSchema = z.array(z.string()).optional().describe('Object types excluded from the approved scope. Omit to keep the current list (on a fresh proposal, the types the GUI filter hides); a sent list replaces it.');
const StartExcludeSchemasSchema = z.array(z.string()).optional().describe('Schema names excluded from the approved scope. Omit to keep the current list (on a fresh proposal, the schemas the GUI filter hides); a sent list replaces it, so repeat those you keep.');
const StartExcludeNodeIdsSchema = z.array(z.string()).optional().describe('Resolved object IDs to remove, including dependent branches reachable only through them. Omit to keep the current list (on a fresh proposal, the objects the GUI filter excludes); a sent list replaces it.');
const StartPassNodeIdsSchema = z.array(z.string()).optional().describe('Resolved object IDs to keep as topology-only passthrough nodes without analyzing them; the mapping for objects the user said to ignore or skip. Omit to keep the current list; a sent list replaces it.');

/**
 * Strict domain boundary for fresh, refine, and completed-session exploration requests.
 *
 * @remarks
 * Parsed at the boundary so malformed payloads (e.g. missing `origin`) produce a structured
 * `missing_field` error. Either `origin` (fresh exploration) or a `supplement` carrying explicit node ids
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
  targetColumns: z.array(ColumnIdentifierSchema).optional().describe(
    TARGET_COLUMNS_PHASE_DESCRIPTION,
  ),
  depth: StartDepthSchema,
  excludeTypes: StartExcludeTypesSchema,
  /**
   * Schemas to drop from the BFS scope under the source comparison policy. Honored at scope-build time —
   * any candidate node whose schema matches is excluded. REPLACE semantics: each call
   * wipes prior filter state on the engine; accumulate across refine rounds by re-sending
   * every prior exclusion plus the new one.
   */
  excludeSchemas: StartExcludeSchemasSchema,
  /**
   * Specific node ids to drop from the BFS scope under the source comparison policy. Cuts the node and
   * its subtree reachable only through it. Use only when the user explicitly says
   * remove / drop / prune / cut. REPLACE semantics — see {@link excludeSchemas}.
   * Every id must already be resolved via `lineage_search_objects` — unknown ids cause
   * the call to reject with `unknown_node_ids`.
   */
  excludeNodeIds: StartExcludeNodeIdsSchema,
  /**
   * Specific node ids the engine keeps in scope but auto-passes (no analysis written,
   * topology preserved so descendants stay reachable). Default interpretation when the
   * user says ignore / skip / don't analyze. REPLACE semantics — see {@link excludeSchemas}.
   * Every id must already be resolved via `lineage_search_objects` — unknown ids cause
   * the call to reject with `unknown_node_ids`.
   */
  passNodeIds: StartPassNodeIdsSchema,
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
      message: START_SHAPE_REQUIRED_MESSAGE,
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
      message: 'origin and supplement cannot be sent together: send supplement alone to add objects to the completed analysis, or origin without supplement to start a new exploration.',
      params: { startIssue: 'start_shape_conflict' },
    });
  }
  if (data.origin && !isProposalRefine && !data.analysisMode) {
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
  if (data.analysisMode === 'ct' && (data.origin || data.targetColumns !== undefined) && (!data.targetColumns || data.targetColumns.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetColumns'],
      message: CT_TARGET_COLUMNS_RECOVERY,
      params: { startIssue: 'ct_target_columns_required' },
    });
  }
  if (data.analysisMode === 'bb' && data.targetColumns && data.targetColumns.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetColumns'],
      message: 'analysisMode "bb" is whole-object lineage and does not accept targetColumns.',
      params: { startIssue: 'bb_target_columns_forbidden' },
    });
  }
  if (data.origin && !isProposalRefine && !data.depth) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['depth'],
      message: 'depth is required for a fresh exploration proposal: send levels and exactness for both upstream and downstream.',
      params: { startIssue: 'depth_required' },
    });
  }
});

const StartOriginSchema = z.string().min(1).describe('Canonical object ID that anchors a fresh exploration.');
const StartQuestionSchema = z.string().optional().describe('The user question this exploration must answer.');
const StartScopeNotesSchema = ScopeNotesValueSchema.optional();
const StartMissionBriefSchema = MissionBriefValueSchema.optional();
const NamedCtTargetColumnsSchema = z.array(ColumnIdentifierSchema).min(1).describe('CT requires one or more user-named columns.');
const StartPatchFields = {
  origin: StartOriginSchema.optional(),
  question: StartQuestionSchema,
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
    ANALYSIS_MODE_DESCRIPTION,
  ),
  classification: ClassificationValueSchema,
  depth: ExplorationDepthSelectionSchema.describe(DEPTH_DESCRIPTION),
}).strict();

/** Fresh CT proposal branch. It cannot encode refine or supplement fields. */
const StartFreshCtProviderSchema = z.object({
  ...StartPatchFields,
  origin: StartOriginSchema,
  analysisMode: z.literal('ct').describe(
    ANALYSIS_MODE_DESCRIPTION,
  ),
  classification: ClassificationValueSchema,
  depth: ExplorationDepthSelectionSchema.describe(DEPTH_DESCRIPTION),
  targetColumns: NamedCtTargetColumnsSchema,
}).strict();

/**
 * Pending-proposal patch branch. Omitted fields are merged mechanically by the dispatcher, except
 * an omitted `mission_brief`, which is kept only while origin, analysis mode, target columns and
 * depth are unchanged; a scope change clears it.
 */
const StartRefineProviderSchema = z.object({
  ...StartPatchFields,
  proposalRevision: z.number().int().positive().describe('Revision shown by the pending approval gate.'),
  analysisMode: z.enum(['bb', 'ct']).optional().describe(
    ANALYSIS_MODE_DESCRIPTION,
  ),
  targetColumns: z.array(ColumnIdentifierSchema).optional().describe(
    TARGET_COLUMNS_PHASE_DESCRIPTION,
  ),
}).strict().superRefine((data, ctx) => {
  if (data.analysisMode === 'bb' && data.targetColumns && data.targetColumns.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targetColumns'], message: 'BB refinement cannot name target columns.' });
  }
  if (data.analysisMode === 'ct' && (!data.targetColumns || data.targetColumns.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targetColumns'], message: 'A BB-to-CT refinement requires named target columns.' });
  }
});

/** Completed-session supplement branch. `nodeIds` is always required and non-empty. */
const StartSupplementProviderSchema = z.object({
  supplement: SupplementSchema,
}).strict();

/**
 * Fresh-entry model contract selected for `sm_entry` before the first approval gate.
 *
 * @remarks
 * One flat object, not a BB/CT union. Mode discrimination (BB forbids `targetColumns`; CT
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
  depth: ExplorationDepthSelectionSchema.describe(DEPTH_DESCRIPTION),
  targetColumns: z.array(ColumnIdentifierSchema).optional().describe(
    TARGET_COLUMNS_PHASE_DESCRIPTION,
  ),
}).strict();

/** Gate-refinement model contract selected only while revising a pending proposal. */
export const StartExplorationRefineProviderInputSchema = StartRefineProviderSchema;

/**
 * Completed-session (follow-up) model contract: one flat object admitting either an explicit
 * supplement or a fresh re-proposal, never a top-level `anyOf`/`oneOf`.
 *
 * @remarks
 * A follow-up that names objects the border refused (e.g. a GUI-hidden schema) cannot be
 * expressed as a supplement — the border stays closed. The repair is a fresh origin-anchored
 * proposal, so this projection carries both shapes; a supplement still admits no other key.
 * The dispatcher ({@link StartExplorationInputSchema}) resolves the shape and a fresh proposal
 * reopens the `confirm_sm_start` gate.
 */
export const StartExplorationCompletedProviderInputSchema = z.object({
  ...StartPatchFields,
  origin: StartOriginSchema.optional(),
  analysisMode: z.enum(['bb', 'ct']).optional().describe(
    ANALYSIS_MODE_DESCRIPTION,
  ),
  classification: ClassificationValueSchema.optional(),
  targetColumns: z.array(ColumnIdentifierSchema).optional().describe(
    TARGET_COLUMNS_PHASE_DESCRIPTION,
  ),
  supplement: SupplementSchema.optional(),
}).strict().superRefine((data, ctx) => {
  const proposalKeys = Object.keys(data).filter(key => key !== 'supplement' && data[key as keyof typeof data] !== undefined);
  if (data.supplement && proposalKeys.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['supplement'],
      message: 'A supplement carries only `supplement`.',
      params: { hint: `Remove ${proposalKeys.map(key => `\`${key}\``).join(', ')}.` },
    });
  }
  if (!data.supplement && !data.origin) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['origin'], message: START_SHAPE_REQUIRED_MESSAGE });
  }
});

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
/** A `get_scope_bundle` depth: a non-negative integer or `"all"`. */
const ScopeDepthSchema = z.union([z.number().int().min(0), z.literal('all')]);
const ScopeOriginSchema = z.string().min(1).describe('Canonical object ID at the center of the requested lineage scope.');
const ScopeIncludeDdlSchema = z.boolean().optional().describe('Whether to include SQL bodies for nodes in the returned scope.');

/**
 * Zod schema validating the parameters for the `get_scope_bundle` discovery tool.
 *
 * @remarks
 * Model-facing AND dispatcher schema — one flat object, not a symmetric/asymmetric
 * union. Symmetric-vs-asymmetric discrimination stays owned entirely by the
 * `superRefine` below, at the one Zod boundary.
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
 * only `upstream_depth`/`downstream_depth`, both required. Every projected call always resolves
 * at the dispatcher boundary to a bidirectional
 * scope with independently-set upstream/downstream depths — the dispatcher
 * ({@link GetScopeBundleInputSchema}) is unchanged and still owns the full symmetric/asymmetric/
 * direction contract for non-model callers.
 */
export const GetScopeBundleModelSchema = z.object({
  origin: ScopeOriginSchema,
  upstream_depth: ScopeDepthSchema.describe(
    'Upstream levels: a positive integer, "all" for the whole chain, or 0 to exclude upstream. Use the smallest depth that answers the question: 1 for direct neighbours; "all" only for a whole-chain or path question.',
  ),
  downstream_depth: ScopeDepthSchema.describe(
    'Downstream levels: a positive integer, "all" for the whole chain, or 0 to exclude downstream. Use the smallest depth that answers the question: 1 for direct neighbours; "all" only for a whole-chain or path question.',
  ),
  include_ddl: ScopeIncludeDdlSchema,
}).strict();

/**
 * Zod schema for `submit_findings.sections`, keyed by angle so the same angle cannot be sent
 * twice.
 *
 * @remarks
 * Each fired `*_capture` YAML template produces ONE keyed entry (`business` and/or
 * `technical`). This base shape backs the permissive participant union
 * ({@link SubmitFindingsModelSchema}) and stays angle-open; the strict per-dispatch schema
 * (`submitFindingsSchemaForMode`) narrows the object to the locked classification's kept
 * angle key(s) before every active-hop dispatch, so an off-lock angle fails there as an
 * unrecognized key and the model re-submits with its content folded into a kept key.
 * `interaction/rules/submitFindingsRules.validateSectionsAgainstClassification` still checks,
 * after that, that every kept angle the lock requires is actually present.
 */
const CapturedSectionsSchema = z.object({
  /** Pre-formatted section body written per `business_capture`. */
  business: z.string().optional(),
  /** Pre-formatted section body written per `technical_capture`. */
  technical: z.string().optional(),
}).strict();

/** Model-facing output of {@link CapturedSectionsSchema}: at most one string per angle. */
type CapturedSectionsWire = z.infer<typeof CapturedSectionsSchema>;

/**
 * Single source for the `prune_neighbors` field describe text, shared by the strict per-mode
 * schemas and the permissive participant union so the two cannot drift.
 */
const PRUNE_NEIGHBORS_DESCRIPTION =
  'Name each `can_prune: true` neighbor this node\'s SQL shows is off the path; that neighbor and whatever only it leads to are removed. '
  + 'The focus stays on the graph, including when every neighbor is named (a dead end). A neighbor named here gets no questions entry. '
  + 'A commit result lists removed neighbors in `pruned` and the nodes cut with them in `cut_ids`; a prune that would disconnect committed analysis is rejected.';

/** One `prune_neighbors[]` entry: the neighbour and why this node's SQL shows it is off the answer. */
const PruneNeighborSchema = z.object({
  id: z.string().min(1).describe('A neighbor id from `<hop_context>`.'),
  reason: z.string().min(1).describe('What in this node\'s SQL shows the neighbor is off the answer.'),
}).strict();

/**
 * Single source for the `questions` field describe text, shared by the strict per-mode schemas and
 * the permissive participant union.
 */
const QUESTIONS_DESCRIPTION =
  'Provide a self-contained purpose question for each eligible unvisited neighbor you keep, including column continuations, tied to the user question. '
  + 'For an eligible out-of-scope neighbor, optionally propose a relevant follow-up; it is deferred until scope approval. '
  + 'No questions to visited or pruned neighbors.';

/** One `questions[]` entry, attached to that neighbour's queued hop. */
const NeighborQuestionSchema = z.object({
  nodeId: z.string().min(1).describe('A neighbor id from `<hop_context>`.'),
  question: z.string().min(1).describe('The check, self-contained: name the neighbor and what to establish there.'),
}).strict();

const CtNeighborQuestionSchema = NeighborQuestionSchema.extend({
  caller_context: z.object({ node: z.string().min(1), col: z.string().min(1) }).strict().optional().describe('For a column-trace function investigation, declare the real current caller output whose contribution its supplied SQL must establish. The caller SQL is supplied at the function hop to bind actual arguments; this declaration creates no column edge or function column.'),
}).strict();

/**
 * States a content cap in the JSON schema the model reads (`maxLength` / `maxItems`) without
 * enforcing it at parse.
 *
 * @remarks
 * Enforcement is the engine's (`NavigationEngine.submitFindings`), which rejects the offending
 * field alone as repairable, states the measured size against the limit, and holds the draft. A
 * parse-time cap would reject at the model port instead — with no held draft, no measured size, and
 * no repairable classification — forcing a full resend of an answer that was otherwise correct.
 * Structural constraints (`min`, non-whitespace refinements, type and enum) stay real parse-time
 * checks: they describe the shape a reader needs, not the size a surface can render.
 *
 * The projection carries the same keyword and the same value the equivalent `.max()` produced — key
 * order differs, which JSON Schema does not distinguish — so the model is offered the same contract
 * either way.
 *
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
 * `submit_findings` schemas and the permissive participant union so the two never restate the
 * same fact with different wording. The soft target (a 2-4 word label) lives here and nowhere
 * else: `badge_label` is a per-hop tool field, not template-governed content.
 */
const BADGE_LABEL_DESCRIPTION = '2-4 word label for this node.';

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
    'Classify this source column’s own role end to end; omit when SQL does not determine it. ' +
    'pass_through: unchanged value. compute: expression input, including a CASE condition operand. aggregate: value summarised by an aggregate. ' +
    'combine: a SQL-supported join, grouping, partition or ordering key that affects the output. filter: the column selects contributing rows. ' +
    'Contextual combine or filter roles may stand alone; do not infer arithmetic or aggregate roles from them. Grouping, partition and ordering keys are not aggregate value inputs; ' +
    'display-only sorting contributes no role.',
  ),
  note: advertisedMax(z.string(), { maxLength: COLUMN_FLOW_NOTE_MAX }).optional().describe(
    'The deciding expression, at most ~12 words.',
  ),
}).strict();

const ColumnFlowWritesToObject = z.object({
  node: z.string(),
  col: z.string(),
}).strict();

/**
 * One closed `column_flow` entry; provider projection and runtime parsing reject surplus keys.
 */
const OUT_COL_DESCRIPTION = "Output identified by this hop's qualified column task and SQL; for a procedure, the produced expression identified by its written column. Do not invent output names.";

const ColumnFlowEntrySchema = z.object({
  out_col: z.string().describe(OUT_COL_DESCRIPTION),
  writes_to: ColumnFlowWritesToObject.nullish().describe('SQL table and column receiving this output within the requested trace. Omit for a known destination outside the requested trace and retain the write in sections. Use null only when this output has no SQL table write.'),
  returns_to: ColumnFlowWritesToObject.optional().describe('Real caller output supplied in caller_output_targets for this scalar-return task; never a table write.'),
  upstream_columns: z.array(ColumnRefSchema).describe(
    'At a bodied focus, use real SQL-supported dependencies of out_col: operands of its expression, ' +
    'an aggregate’s argument, each set-operation (UNION) branch’s column at that position, caller-bound value inputs. ' +
    'Contextual columns may also be listed when their join, filter, grouping, partition or ordering role affects the value or contributing rows; explain these dataset operations in sections. ' +
    'Exclude the entry’s own writes_to column and unused expressions. Resolve parameters and computed aliases to their source columns. ' +
    'List all supported in-scope dependencies. upstream_columns: [] records no in-scope suppliers for this output. Keep known dependencies beyond the requested trace limit and unresolved source evidence in sections.',
  ),
}).strict();


/** Reason-only removal of an irrelevant SQL node reached through a storage carrier. */
export const PruneCurrentInputSchema = z.object({
  focus_node_id: z.string().min(1).regex(/\S/).describe('The current focus_node.id from hop_context.'),
  reason: z.string().min(1).regex(/\S/).describe('Why the whole current node is irrelevant to this investigation.'),
}).strict();

const COLUMN_FLOW_DESCRIPTION = 'In lineage_submit_findings, map the SQL-supported relations between this hop\'s qualified columns and eligible neighboring columns. Keep each requested or assigned output mapping when a dependency or destination is outside the requested trace; record only in-scope references and retain the SQL facts in sections. Omit external candidates with no confirmed mapped output; use column_flow: [] when no mappings remain. Preserve mappings for other tasks. Use terminated_inputs only for supplied inputs that SQL shows end without an output while others continue.';

const TerminatedInputsSchema = z.array(ColumnFlowWritesToObject).describe(
  'Qualified incoming columns whose value contribution ends here without a local output, as established from this hop’s SQL. Use when other incoming columns continue in column_flow; name only the supplied incoming endpoints, never invent an output column.',
);

const ColumnFlowSchema = z.array(ColumnFlowEntrySchema).describe(COLUMN_FLOW_DESCRIPTION);

/** Single source for the `sections` describe text, shared by the per-mode schemas and the participant union. */
const SECTIONS_DESCRIPTION = 'Required. Pre-formatted section body per fired capture recipe, keyed by angle: `{business, technical}`; a locked classification keeps only its angle key(s).';

/** Single source for the `summary` describe text, shared by the per-mode schemas and the participant union. */
const SUMMARY_DESCRIPTION =
  'Required. One sentence, readable without this hop: what this node does to the data and what it hands to which node.';

/**
 * Shared `submit_findings` fields across BB and CT modes, one flat object.
 *
 * @remarks
 * Fresh findings require sections and summary; held repairs may omit retained content.
 * {@link refineSubmitFindingsShape} validates those requirements at parse.
 */
const HopFindingBaseSchema = z.object({
  focus_node_id: z.string().describe('`focus_node.id` from `<hop_context>`.'),
  summary: z.string().optional().describe(SUMMARY_DESCRIPTION),
  badge_label: advertisedMax(z.string(), { maxLength: SUBMIT_FINDINGS_BADGE_LABEL_MAX }).min(1)
    .refine(value => value.trim().length > 0, 'badge_label must contain non-whitespace text')
    .optional()
    .describe(BADGE_LABEL_DESCRIPTION),
  prune_neighbors: z.array(PruneNeighborSchema).max(MAX_ID_LIST_LENGTH).optional().describe(PRUNE_NEIGHBORS_DESCRIPTION),
  questions: z.array(NeighborQuestionSchema).max(MAX_ID_LIST_LENGTH).optional().describe(QUESTIONS_DESCRIPTION),
  /**
   * One string per fired `*_capture` template, keyed by angle. One key (`business` /
   * `technical` classification) or two (`both`) — required for a fresh finding. Declared last:
   * a model emits arguments in schema order, so the long prose closes the object after every
   * short field.
   */
  sections: CapturedSectionsSchema.optional().describe(SECTIONS_DESCRIPTION),
}).strict();

const { sections, summary, badge_label, prune_neighbors } = HopFindingBaseSchema.shape;

/**
 * CT form: the BB form plus `column_flow` (served-required — always in the served `required` list,
 * `[]` allowed when no columns continue), declared right after `focus_node_id`, ahead of
 * `sections`/`summary`, so the short required structured field is emitted before the long capture
 * prose: a model emits arguments in schema order, and a required field placed after several
 * thousand characters of section text tends to drop on the longest generations.
 */
const HopFindingCtBaseSchema = HopFindingBaseSchema
  .omit({ sections: true, summary: true, badge_label: true, prune_neighbors: true, questions: true })
  .extend({
    column_flow: ColumnFlowSchema,
    terminated_inputs: TerminatedInputsSchema.optional(),
    summary,
    badge_label,
    prune_neighbors,
    questions: z.array(CtNeighborQuestionSchema).max(MAX_ID_LIST_LENGTH).optional().describe(QUESTIONS_DESCRIPTION),
    sections,
  })
  .strict();

/**
 * The flat, wire-shaped `submit_findings` payload once shape- and classification-validated —
 * `sections` still keyed by angle, before {@link toHopFinding} converts it to the engine's
 * internal union. This is what {@link submitFindingsSchemaForMode} itself parses to: the schema is
 * a validator only, so parsing an already-valid `FlatSubmitFindings` a second time is a no-op.
 */
export type FlatSubmitFindings = z.output<typeof HopFindingBaseSchema> & { column_flow?: z.output<typeof ColumnFlowSchema>; terminated_inputs?: z.output<typeof TerminatedInputsSchema> };

/**
 * Enforces the fresh kept shape of one flat `submit_findings` payload.
 *
 * @remarks
 * Fresh findings carry `sections` and `summary` (and, in CT, `column_flow`). A held repair
 * may omit these retained parts. A fresh finding under a `both` lock names each missing
 * angle. Each fault is one issue on its own path, so the rejection names the exact field.
 */
function refineSubmitFindingsShape(value: FlatSubmitFindings, ctx: z.RefinementCtx, fresh: boolean, classification?: ClassificationValue): void {
  if (typeof value !== 'object' || value === null) return;
  const keptAngles = classification ? CLASSIFICATION_KEPT_ANGLES[classification] : undefined;
  const bothAnglesRequired = fresh && keptAngles?.length === CLASSIFICATION_KEPT_ANGLES.both.length;
  if (keptAngles?.length === 1 && typeof value.sections === 'object' && value.sections !== null) {
    const [onlyAngle] = keptAngles;
    const offAngle = onlyAngle === 'business' ? 'technical' : 'business';
    const surplus = Object.keys(value.sections).filter((key) => key !== onlyAngle);
    if (surplus.includes(offAngle)) {
      ctx.addIssue({
        code: 'custom',
        path: ['sections'],
        message: `"${offAngle}" is not kept under classification=${classification}`,
        params: { hint: `Fold the ${offAngle} content into "${onlyAngle}" and drop the "${offAngle}" key.` },
      });
    }
    const unknown = surplus.filter((key) => key !== offAngle);
    if (unknown.length > 0) ctx.addIssue({ code: 'unrecognized_keys', path: ['sections'], keys: unknown, message: 'Unrecognized keys' });
  }
  const filled = new Set(Object.entries(value.sections ?? {})
    .filter(([, body]) => typeof body === 'string' && body.trim() !== '').map(([angle]) => angle));
  if (fresh && filled.size === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['sections'],
      message: 'Required for a fresh finding.',
      params: { hint: 'Send sections: the section body keyed by angle.' },
    });
  }
  if (bothAnglesRequired && filled.size > 0) {
    for (const angle of CLASSIFICATION_KEPT_ANGLES.both) {
      if (filled.has(angle)) continue;
      ctx.addIssue({ code: 'custom', path: ['sections', angle], message: 'required with a both classification when sections is not empty.', params: { hint: `Send sections.${angle}.` } });
    }
  }
  if (fresh && (value.summary === undefined || (typeof value.summary === 'string' && value.summary.trim() === ''))) {
    ctx.addIssue({
      code: 'custom',
      path: ['summary'],
      message: 'Required for a fresh finding.',
      params: { hint: 'Send summary: one sentence on what this node does to the data and hands on.' },
    });
  }
}

/**
 * Converts a validated flat `submit_findings` payload to the {@link HopFinding} union the engine
 * consumes.
 *
 * @remarks
 * Called exactly once, by `executeSubmitFindings`, on the payload the handler has admitted
 * against the served {@link submitFindingsSchemaForMode} schema — never inside the schema
 * itself, so the schema's output type stays equal to its input type. The boundary decides
 * `valid`/`invalid`; only the handler converts.
 *
 * @param value - A payload {@link refineSubmitFindingsShape} accepted.
 * @returns The kept finding, carrying exactly the kept fields.
 */
export function toHopFinding(value: FlatSubmitFindings): HopFindingKept {
  const kept: HopFindingKept = {
    focus_node_id: value.focus_node_id,
    sections: extractRawSectionAngles(value.sections ?? {}),
    summary: value.summary ?? '',
  };
  if (value.badge_label !== undefined) kept.badge_label = value.badge_label;
  if (value.prune_neighbors !== undefined) kept.prune_neighbors = value.prune_neighbors;
  if (value.questions !== undefined) kept.questions = value.questions;
  if (value.column_flow !== undefined) kept.column_flow = value.column_flow;
  if (value.terminated_inputs !== undefined) kept.terminated_inputs = value.terminated_inputs;
  return kept;
}

/**
 * Applies the fresh-content check to one flat per-mode object.
 *
 * @remarks
 * A pure validator: it accepts or rejects the flat wire shape and returns that same shape
 * unconverted (`z.output` equals `z.input`, `sections` still angle-keyed), so parsing an
 * already-validated `FlatSubmitFindings` again is a no-op rather than a second, incompatible
 * shape check. {@link toHopFinding} is the separate, single conversion step.
 */
function finalizeSubmitFindingsSchema(
  schema: typeof HopFindingBaseSchema | typeof HopFindingCtBaseSchema,
  fresh: boolean,
  classification?: ClassificationValue,
): z.ZodType<FlatSubmitFindings> {
  const keptAngles = classification ? CLASSIFICATION_KEPT_ANGLES[classification] : undefined;
  const source = fresh
    ? schema.extend({
      sections: schema.shape.sections.unwrap().meta(keptAngles
        ? { required: [...keptAngles] }
        : { anyOf: CLASSIFICATION_KEPT_ANGLES.both.map(angle => ({ required: [angle] })) })
        .optional().describe(schema.shape.sections.description ?? ''),
    }).strict()
    : schema.extend({
      summary: schema.shape.summary.unwrap().regex(/\S/, 'A supplied summary must contain non-whitespace text.').optional(),
    }).strict();
  const validated = source
    .check(superRefineAll((value, ctx) => refineSubmitFindingsShape(value as FlatSubmitFindings, ctx, fresh, classification))) as z.ZodType<FlatSubmitFindings>;
  if (!fresh) return validated;
  const required = Object.entries(schema.shape)
    .filter(([, field]) => !field.isOptional())
    .map(([key]) => key);
  return validated.meta({ required: [...required, 'summary', 'sections'] });
}

/**
 * BB-mode submit_findings input.
 *
 * @remarks
 * A question or prune decision accounts for each open neighbour. Pruning every neighbor
 * leaves the current focus visible as a dead end. BB does not carry CT-only `column_flow`.
 */
export const SubmitFindingsBbInputSchema = finalizeSubmitFindingsSchema(HopFindingBaseSchema, true);

/**
 * CT-mode submit_findings input.
 *
 * @remarks
 * CT is BB plus column tracking, so every BB field is present on the CT form; `column_flow`'s own
 * contract is documented on {@link ColumnFlowSchema}, and its `upstream_columns` are the carry each
 * enqueued neighbour receives.
 */
export const SubmitFindingsCtInputSchema = finalizeSubmitFindingsSchema(HopFindingCtBaseSchema, true);

/** Memoized per (mode, classification) narrowed `submit_findings` schemas built by {@link submitFindingsSchemaForMode}. */
const submitFindingsSchemaCache = new Map<string, z.ZodType<FlatSubmitFindings>>();

/**
 * Narrows {@link CapturedSectionsSchema} to the angle key(s) a locked classification keeps
 * ({@link CLASSIFICATION_KEPT_ANGLES}).
 *
 * @remarks
 * One kept angle drops the other key. Sending it raises a custom issue from
 * {@link refineSubmitFindingsShape} whose hint says to fold that key's content into the kept angle.
 * The fold guidance also lives on the kept key's description, where the model reads it before
 * authoring. `both` keeps both angles, each key optional; a fresh kept submission serves both keys
 * through {@link finalizeSubmitFindingsSchema}'s conditional requiredness, so a retry with a held
 * draft names only the angle it changes. {@link refineSubmitFindingsShape} refuses `{}` on a
 * fresh submission and names a missing angle of a fresh `both` submission in the same
 * parse as a shape fault; `validateSectionsAgainstClassification` then requires every kept angle in
 * `NavigationEngine.submitFindings`, after held and archived angles are counted. The parent field
 * is served optional and non-nullable.
 *
 * @param classification - The locked classification this dispatch's schema narrows to.
 * @returns The sections object for that classification. A one-angle lock carries only that key;
 * `both` carries both keys, optional.
 */
function capturedSectionSchemaForClassification(
  classification: ClassificationValue,
): z.ZodType<CapturedSectionsWire> {
  const kept = CLASSIFICATION_KEPT_ANGLES[classification];
  if (kept.length === CLASSIFICATION_KEPT_ANGLES.both.length) {
    const plainBody = z.string().optional();
    return z.strictObject({ business: plainBody, technical: plainBody });
  }
  const [onlyAngle] = kept;
  const offAngle = onlyAngle === 'business' ? 'technical' : 'business';
  const body = z.string().optional().describe(
    `The only angle classification=${classification} keeps; fold any ${offAngle} content into this key — a separate "${offAngle}" key is rejected.`,
  );
  return z.strictObject({ [onlyAngle]: body }) as unknown as z.ZodType<CapturedSectionsWire>;
}

/**
 * Backend-owned neighbor and column choices that narrow the served hop schema.
 *
 * @remarks
 * `outCols` is every declared column on the focus when metadata exists, so UNION, computed
 * outputs and extra siblings can be mapped many-to-many; `null` when the focus has no column
 * metadata and any name is checked only for neighbor identity. `[]` refuses `column_flow`.
 * `writesTo` is true only for a procedure focus, the one node that writes a column elsewhere.
 */
export interface SubmitFindingsHopColumns {
  /** Backend-owned current-hop neighbors, including closed evidence-only neighbors. */
  readonly neighbors?: readonly { readonly id: string; readonly can_question: boolean; readonly can_prune: boolean }[];
  readonly outCols: readonly string[] | null;
  readonly writesTo: boolean;
  readonly returnTargets?: readonly { readonly node: string; readonly col: string }[];
  /** Exact arriving endpoints available for an explicit no-contribution declaration. */
  readonly incomingRefs?: readonly { readonly node: string; readonly col: string }[];
  readonly identifierCaseSensitive?: boolean;
  /** Neighboring functions eligible for an explicit current-caller output investigation. */
  readonly callerContextNodeIds?: readonly string[];
  /**
   * Sorted ids the loaded store metadata admits as `upstream_columns` sources: focus neighbors
   * (and read suppliers of its declared scalar callers) that carry stored columns or hold the
   * procedure/external missing-metadata fallback. Columnless scalar functions are absent; they
   * stay eligible in `questions` via {@link SubmitFindingsHopColumns.callerContextNodeIds}.
   */
  readonly columnSourceNodeIds?: readonly string[];
  /** Sorted ids the focus has a recorded dependency into; the only admissible `writes_to.node` values. */
  readonly writeTargetNodeIds?: readonly string[];
}

/**
 * One choice schema for supplied identifiers, with an optional comparison key for column names.
 * The provider enum and rejection choices share the same values; parsing preserves input.
 */
function suppliedValueSchema(values: readonly string[], key: (value: string) => string = value => value, node?: string) {
  if (values.length === 0) return z.never();
  const keys = new Set(values.map(key));
  return z.string().refine(value => keys.has(key(value)),
    { message: 'Name a supplied value.',
      params: { allowed_values: [...values], ...(node ? { when: { node } } : {}) } }).meta({ enum: [...values] });
}

/** Offers canonical IDs while admitting only equivalent, unambiguous metadata spellings. */
function objectIdSchema(ids: readonly string[], identifierCaseSensitive = false) {
  if (ids.length === 0) return z.never();
  const known = new Map(ids.map(id => [id, true]));
  return z.string().refine(value => resolveModelNodeId(value, known, identifierCaseSensitive) !== null,
    { message: 'Name a supplied object identity.', params: { allowed_values: [...ids] } }).meta({ enum: [...ids] });
}

/** Advertises canonical column names while accepting their shared SQL comparison form without rewriting input. */
function columnNameSchema(names: readonly string[], identifierCaseSensitive = false, node?: string) {
  return suppliedValueSchema(names, name => normalizeColName(name, identifierCaseSensitive), node);
}

/** Restricts explicit input termination to the hop's qualified arrivals, without inventing local outputs. */
function terminatedInputsSchemaForHop(hop?: SubmitFindingsHopColumns) {
  if (!hop?.incomingRefs) return TerminatedInputsSchema;
  const endpoints = hop.incomingRefs.map(ref => ColumnFlowWritesToObject.extend({
    node: objectIdSchema([ref.node], hop.identifierCaseSensitive),
    col: columnNameSchema([ref.col], hop.identifierCaseSensitive, ref.node),
  }));
  if (endpoints.length === 0) return TerminatedInputsSchema.max(0);
  const endpoint = endpoints.length === 1 ? endpoints[0]! : z.union(endpoints as [typeof endpoints[number], typeof endpoints[number], ...Array<typeof endpoints[number]>]);
  return z.array(endpoint).describe(TerminatedInputsSchema.description ?? '');
}

/** Projects {@link ColumnFlowSchema} onto one hop: `out_col` as the hop's tracked-column enum, `writes_to` only for a procedure focus. */
function columnFlowSchemaForHop(hop: SubmitFindingsHopColumns) {
  const outCol = !hop.outCols?.length
    ? ColumnFlowEntrySchema.shape.out_col
    : columnNameSchema(hop.outCols, hop.identifierCaseSensitive).describe(OUT_COL_DESCRIPTION);
  const upstreamColumns = hop.columnSourceNodeIds
    ? z.array(ColumnRefSchema.extend({ node: objectIdSchema(hop.columnSourceNodeIds, hop.identifierCaseSensitive) }).strict()).describe(ColumnFlowEntrySchema.shape.upstream_columns.description ?? '')
    : ColumnFlowEntrySchema.shape.upstream_columns;
  const shape = {
    out_col: outCol,
    upstream_columns: upstreamColumns,
    writes_to: hop.writeTargetNodeIds
      ? ColumnFlowWritesToObject.extend({ node: objectIdSchema(hop.writeTargetNodeIds, hop.identifierCaseSensitive) }).nullish().describe(ColumnFlowEntrySchema.shape.writes_to.description ?? '')
      : ColumnFlowEntrySchema.shape.writes_to,
  };
  if (hop.returnTargets?.length) {
    const destinations = hop.returnTargets.map(target => z.object({
      out_col: columnNameSchema([target.col], hop.identifierCaseSensitive, target.node),
      returns_to: z.object({ node: objectIdSchema([target.node], hop.identifierCaseSensitive), col: columnNameSchema([target.col], hop.identifierCaseSensitive, target.node) }).strict(),
      upstream_columns: shape.upstream_columns,
    }).strict());
    const entry = destinations.length === 1 ? destinations[0]! : z.union(destinations as [typeof destinations[number], typeof destinations[number], ...Array<typeof destinations[number]>]);
    return z.array(entry).describe('One mapping per qualified caller_output_target, with matching returns_to. Identify dependencies from the supplied caller SQL and function body. List supported in-scope suppliers, or upstream_columns: [] when none can be recorded; retain known outside dependencies and unresolved evidence in sections.');
  }
  const entry = (hop.writesTo
    ? z.object(shape)
    : z.object({ out_col: shape.out_col, upstream_columns: shape.upstream_columns })
  ).strict();
  const flow = z.array(entry).describe(COLUMN_FLOW_DESCRIPTION);
  return hop.outCols?.length === 0 ? flow.max(0) : flow;
}

/**
 * Selects the strict, mode-and-classification-locked `submit_findings` schema advertised to the
 * model during an active SM hop.
 *
 * @remarks
 * BB returns {@link SubmitFindingsBbInputSchema} (no `column_flow`); CT returns
 * {@link SubmitFindingsCtInputSchema} (`column_flow` served-required — always in the served
 * `required` list, `[]` allowed when no columns continue). When
 * `classification` is supplied, `sections` is further narrowed to the angle key(s) that
 * classification keeps ({@link capturedSectionSchemaForClassification}). A `business` or
 * `technical` lock structurally cannot author the other angle's key, so a surplus angle fails
 * Zod at this boundary instead of being silently dropped at commit. A `both` lock advertises both
 * keys and the classification validator requires both on a fresh submission, while a retry
 * with a held draft names only the angle it changes (`sections: {}` keeps the held angles).
 * The host path uses this at the last seam
 * before the model sees the tool set so the model cannot fill a field or angle invalid for the
 * locked mode/classification — the contract is the form's shape, not prompt prose. The static
 * catalog and `package.json` manifest keep the permissive union (drift guard + single-tool Copilot
 * lane unaffected).
 *
 * @param mode - Locked active analysis mode used for provider projection.
 * @param classification - Locked output classification; omitted callers get the mode-only schema.
 * @param freshSubmission - Refuse `{}` sections and an empty `summary` on a fresh finding; unset
 * so a held draft or an archived angle still validates.
 * @param hop - The active hop's neighbor choices for both modes and CT column facts; narrows `column_flow[].out_col`, offers
 * `writes_to` for a procedure focus alone, and — when column-source metadata is supplied —
 * restricts `upstream_columns[].node` to the hop's column-carrying sources.
 * @returns The strict provider schema for that mode and classification. A pure validator — its
 * output is the same flat, angle-keyed shape it accepts; {@link toHopFinding} is the caller's own
 * separate step onto the {@link HopFinding} union.
 */
export function submitFindingsSchemaForMode(
  mode: 'bb' | 'ct',
  classification?: ClassificationValue,
  freshSubmission = false,
  hop?: SubmitFindingsHopColumns,
  /** Whether a held draft of this focus carries a valid `column_flow`; the served schema then lets a retry omit it to keep the held list. */
  heldColumnFlow = false,
): z.ZodType<FlatSubmitFindings> {
  const hopKey = hop ? JSON.stringify(hop) : '';
  if (!classification && !hopKey && freshSubmission) {
    return mode === 'ct' ? SubmitFindingsCtInputSchema : SubmitFindingsBbInputSchema;
  }
  const cacheKey = `${mode}:${classification ?? ''}:${freshSubmission}:${hopKey}:${mode === 'ct' && heldColumnFlow}`;
  const cached = submitFindingsSchemaCache.get(cacheKey);
  if (cached) return cached;
  let narrowed = (mode === 'ct' ? HopFindingCtBaseSchema : HopFindingBaseSchema) as typeof HopFindingCtBaseSchema;
  const baseQuestion = hop?.neighbors
    ? NeighborQuestionSchema.extend({ nodeId: objectIdSchema(hop.neighbors.filter(n => n.can_question).map(n => n.id), hop.identifierCaseSensitive) })
    : NeighborQuestionSchema;
  if (mode === 'ct' && hop) narrowed = narrowed.extend({ column_flow: columnFlowSchemaForHop(hop), terminated_inputs: terminatedInputsSchemaForHop(hop).optional() }).strict() as typeof HopFindingCtBaseSchema;
  if (hop?.neighbors) narrowed = narrowed.extend({
    prune_neighbors: z.array(PruneNeighborSchema.extend({ id: objectIdSchema(hop.neighbors.filter(n => n.can_prune).map(n => n.id), hop.identifierCaseSensitive) })).max(MAX_ID_LIST_LENGTH).optional().describe(PRUNE_NEIGHBORS_DESCRIPTION),
    questions: z.array(baseQuestion).max(MAX_ID_LIST_LENGTH).optional().describe(QUESTIONS_DESCRIPTION),
  }).strict() as typeof HopFindingCtBaseSchema;
  if (mode === 'ct' && hop?.callerContextNodeIds) {
    const [first, ...rest] = hop.callerContextNodeIds;
    const question = first === undefined ? baseQuestion : z.union([
      baseQuestion,
      CtNeighborQuestionSchema.extend({ nodeId: objectIdSchema([first, ...rest], hop.identifierCaseSensitive).describe(NeighborQuestionSchema.shape.nodeId.description ?? '') }),
    ]);
    narrowed = narrowed.extend({ questions: z.array(question).max(MAX_ID_LIST_LENGTH).optional().describe(QUESTIONS_DESCRIPTION) }).strict() as typeof HopFindingCtBaseSchema;
  }
  if (mode === 'ct' && heldColumnFlow) {
    // A held retry keeps a valid flow by omission, like every other held field; the engine rejects
    // a CT finding that ends up with no flow at all.
    narrowed = narrowed.extend({
      column_flow: (narrowed.shape.column_flow as z.ZodType).optional().describe(`${COLUMN_FLOW_DESCRIPTION} Omit to keep the held list; a sent column_flow replaces it whole.`),
    }).strict() as unknown as typeof HopFindingCtBaseSchema;
  }
  if (classification) {
    const kept = CLASSIFICATION_KEPT_ANGLES[classification];
    const sectionsDescribe = kept.length === CLASSIFICATION_KEPT_ANGLES.both.length
      ? 'Required. Pre-formatted section body for the `business` and `technical` recipes, under keys `business` and `technical`.'
      : `Required. Pre-formatted section body for the \`${kept[0]}\` recipe, under key \`${kept[0]}\`.`;
    const narrowedSections = capturedSectionSchemaForClassification(classification)
      .optional()
      .describe(sectionsDescribe);
    narrowed = narrowed.extend({ sections: narrowedSections }).strict() as typeof HopFindingCtBaseSchema;
  }
  const schema = finalizeSubmitFindingsSchema(narrowed, freshSubmission, classification);
  submitFindingsSchemaCache.set(cacheKey, schema);
  return schema;
}

/**
 * Validates the engine's internal finding representation against the current hop contract.
 * Shares field schemas and content requirements with wire admission while retaining section arrays.
 * No normalization, held-content merge or engine mutation occurs here.
 */
function internalKeptFindingSchema(
  mode: 'bb' | 'ct',
  classification?: ClassificationValue,
  freshSubmission = false,
  hop?: SubmitFindingsHopColumns,
  requireColumnFlow = true,
) {
  const base = mode === 'ct' ? HopFindingCtBaseSchema : HopFindingBaseSchema;
  const angles = classification ? CLASSIFICATION_KEPT_ANGLES[classification] : CLASSIFICATION_KEPT_ANGLES.both;
  const section = z.object({ angle: z.enum(angles), text: z.string() }).strict();
  const flow = hop ? columnFlowSchemaForHop(hop) : ColumnFlowSchema;
  return base.extend({
    summary: HopFindingBaseSchema.shape.summary.unwrap(),
    sections: z.array(section),
    ...(mode === 'ct' ? { column_flow: requireColumnFlow ? flow : flow.optional(), terminated_inputs: terminatedInputsSchemaForHop(hop).optional() } : {}),
  }).strict().superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.sections.forEach((entry, index) => {
      if (seen.has(entry.angle)) ctx.addIssue({ code: 'custom', path: ['sections', index, 'angle'], message: 'Each capture angle occurs once.' });
      seen.add(entry.angle);
    });
    refineSubmitFindingsShape({ ...value, sections: Object.fromEntries(value.sections.map(entry => [entry.angle, entry.text])) } as FlatSubmitFindings, ctx, freshSubmission, classification);
  });
}

/** Validates restorable held findings using the same fields as commit, without requiring resent CT flow. */
export function heldHopFindingSchemaForMode(mode: 'bb' | 'ct'): z.ZodType<HopFindingKept> {
  return internalKeptFindingSchema(mode, undefined, false, undefined, false) as z.ZodType<HopFindingKept>;
}

/** Validates a typed finding before held merge or mutation, sharing wire fields and content checks. */
export function validateHopSubmissionShape(
  input: unknown,
  mode: 'bb' | 'ct',
  classification?: ClassificationValue,
  freshSubmission = false,
  hop?: SubmitFindingsHopColumns,
): { readonly ok: true; readonly data: HopSubmission } | { readonly ok: false; readonly error: ToolRejection } {
  const schema = internalKeptFindingSchema(mode, classification, freshSubmission, hop);
  const parsed = schema.safeParse(input);
  return parsed.success
    ? { ok: true, data: parsed.data as HopSubmission }
    : { ok: false, error: rejectionFromZodError(parsed.error, { code: REJECTION_CODES.invalidInput, input, schema }) };
}

/** The one held-draft rule of a findings retry, applied by `NavigationEngine.applyHeldContent`. */
export const HELD_FINDING_MERGE_RULE =
  'Resend focus_node_id with only the parts to correct. Sent fields and section angles replace held values; omissions keep them. Lists replace whole; [] clears one.';

/**
 * The repair order of a rejected finding: which parts are held and which must be resent.
 *
 * @param held - The held parts, or `null` when nothing is held.
 */
export function findingRepairOrder(held: HeldSubmissionParts | null): string {
  if (!held) return 'Nothing is held: resend the full call.';
  const kept = [...held.sections.map(angle => `sections.${angle}`), ...(held.summary ? ['summary'] : []), ...held.fields];
  return `Held: ${kept.join(', ')}. Resend: ${held.resend.join(', ') || 'only what the reason names'}. ${HELD_FINDING_MERGE_RULE}`;
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

/** Optional page cursor: the `next_cursor` of the previous result, echoed unchanged to read the next page. */
const CursorSchema = z.string().regex(/^\d+$/, 'cursor must be the next_cursor value of the previous result, unchanged')
  .describe('Page cursor: the next_cursor of the previous result, sent unchanged to read the next page of the same list. Omit for the first page.');

/** `lineage_get_screen_state` input: no field returns the screen card; `ids` or `filter` recalls the stored run. */
export const GetScreenStateInputSchema = z.object({
  ids: z.array(z.string()).min(1).max(SCREEN_STATE_MAX_IDS).optional()
    .describe('Canonical object ids to recall from the stored run, taken from the screen card\'s node_ids. Use without filter.'),
  filter: z.enum(['pruned', 'open_leads', 'stale']).optional()
    .describe('One class of the stored run to list: pruned, open_leads, or stale. Use without ids.'),
  cursor: CursorSchema.optional(),
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
  cursor: CursorSchema.optional(),
}).strict();

/** `lineage_get_object_detail` input. */
export const GetObjectDetailInputSchema = z.object({
  id: z.string().describe('Canonical object ID returned by a lineage search or scope tool.'),
  cursor: CursorSchema.optional(),
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

/** Hard cap on `name` (graph node label); its soft target is the field's own description. */
const PRESENT_RESULT_NAME_MAX = 90;
/** Hard cap on `title` (report heading); its soft target is the `title` output template. */
const PRESENT_RESULT_TITLE_MAX = 120;
/**
 * Hard cap on a `sections[].label`. The label's shape is owned by the field's own `.describe()`,
 * which states its role and deliberately no character target.
 */
const PRESENT_RESULT_SECTION_LABEL_MAX = 90;
/**
 * Hard boundary that keeps graph legend labels readable in the GUI. The softer authoring target is
 * owned by the `highlights` output template.
 */
const PRESENT_RESULT_HIGHLIGHT_LABEL_MAX = 60;
/**
 * Identity of a section label: whitespace collapsed, trimmed, case-folded. Two labels with the same
 * key name the same section, in a submission, a repair patch and a committed report alike.
 */
export function normalizePresentSectionLabel(label: string): string {
  return label.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * A refinement that also runs when the value already carries shape issues, so one parse reports
 * every defect of a call instead of hiding the cross-field ones behind the first shape failure.
 * Its `fn` reads the raw value and must tolerate a wrong type.
 */
function superRefineAll<T>(fn: (value: T, ctx: z.core.$RefinementCtx<T>) => void) {
  return z.superRefine<T>(fn, { when: () => true });
}

/** Refinement for a `sections` list: each final label maps to exactly one section text. */
function rejectDuplicateSectionLabels(sections: ReadonlyArray<{ label: string }>, ctx: z.core.$RefinementCtx): void {
  if (!Array.isArray(sections)) return;
  const seen = new Set<string>();
  for (const [index, section] of sections.entries()) {
    if (typeof section !== 'object' || section === null) continue;
    const { label } = section;
    if (typeof label !== 'string') continue;
    const key = normalizePresentSectionLabel(label);
    if (seen.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: [index, 'label'],
        message: `Duplicate section label "${label}" — each final label must map to exactly one section text`,
        params: { hint: 'Send one entry per section label. To correct a held section, resend its label with corrected content and omit remove; use remove: true only to delete that section.' },
      });
    } else {
      seen.add(key);
    }
  }
}
/** A non-empty `sections` list with unique labels: the one bound every stage's section array shares. */
function sectionList<T extends z.ZodType<{ label: string }>>(item: T) {
  return z.array(item).min(1).check(superRefineAll(rejectDuplicateSectionLabels));
}

/** The merged held-draft `sections` field, held to the same bound as the served section arrays. */
export const MergedSectionsSchema = z.object({ sections: sectionList(z.looseObject({ label: z.string() })) });

/**
 * The Lineage color-scheme enum shared by every colored surface. Declared once so
 * render paths cannot drift: flow-role schemes (`source` / `transform` / `target`) plus status
 * schemes (`good` / `warn` / `fail`).
 */
const HighlightSchemeSchema = z.enum(['source', 'transform', 'target', 'good', 'warn', 'fail']);

/**
 * One model-supplied node id, preserved verbatim and required non-empty.
 *
 * @remarks
 * A blank or whitespace-only entry would otherwise pass this boundary, resolve to nothing, and
 * surface as an "unknown IDs" rejection whose offender list renders empty. Rejecting it here names
 * the exact array index instead, which is a field path a repair can act on.
 */
const NodeIdSchema = z.string()
  .regex(/\S/, 'Node ID must not be blank.')
  .min(1, 'Node ID must not be blank.');

/**
 * One below-node caption. Its keys share nothing with a `sections[]` item's
 * `{label, node_ids, text}`, so `.strict()` names the offending keys when the two are conflated.
 */
const NoteSchema = z.object({
  node_id: NodeIdSchema.describe('Node ID the caption sits below.'),
  caption: z.string().regex(/\S/, 'Must contain non-whitespace text.').min(1, 'Note is missing its caption').describe('One-sentence caption, grounded in the evidence supplied for this stage.'),
}).strict();

/**
 * `present_result.notes`: an array of declared-key objects, the one object shape every
 * function-calling schema dialect expresses — a map keyed by data (`additionalProperties` with a
 * value schema) is not portable across providers. The parsed value is the shape every consumer
 * reads, so a held draft re-validates unchanged. A node ID given two different captions rejects,
 * since one of them would otherwise be lost; an identical repeat is harmless.
 */
const notesListSchema = (note: z.ZodType<z.infer<typeof NoteSchema>>) => z.array(note)
  .superRefine((notes, ctx) => {
    const captionByNode = new Map<string, string>();
    for (const [index, note] of notes.entries()) {
      const first = captionByNode.get(note.node_id);
      if (first === undefined) captionByNode.set(note.node_id, note.caption);
      else if (first !== note.caption) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'caption'],
          message: `notes gives "${note.node_id}" more than one caption — send one caption per node id.`,
        });
      }
    }
  })
  .describe('Below-node captions, one per node.');
const NotesModelSchema = notesListSchema(NoteSchema);

/**
 * Schema for a visual highlight group, grouping nodes by a shared role or status.
 */
const HighlightGroupSchema = z.object({
  label: z.string().regex(/\S/, 'Must contain non-whitespace text.').min(1, 'Group label is required').max(PRESENT_RESULT_HIGHLIGHT_LABEL_MAX).describe('Short legend label describing the shared graph role or status; length target: see the `highlights` output template.'),
  color: HighlightSchemeSchema.describe('Flow role or status. `source`: the deepest origins whose data feeds the answer. `target`: where the data lands — the queried object in an upstream trace. `transform`: nodes that create or change the answer\'s values. `good` / `warn` / `fail`: diagnostic status. One scheme per result.'),
  node_ids: z.array(NodeIdSchema).describe('Node IDs that share this graph role or status.'),
}).strict();

/**
 * One final report section: a label that becomes both the section heading and the graph badge, the
 * nodes it explains, and its detail body.
 */
const PresentResultSectionSchema = z.object({
  label: z.string().max(PRESENT_RESULT_SECTION_LABEL_MAX).regex(/\S/, 'Section label must not be blank.').min(1, 'Section label is required — provide a short final label for this detail section').describe('What the section\'s nodes share, as heading and badge (30 chars). No object names. Unique after trimming, whitespace collapse and lowercasing.'),
  node_ids: z.array(NodeIdSchema).describe('Nodes this section documents; put each node in one section. Empty array when it documents none.'),
  text: z.string().regex(/\S/, 'Must contain non-whitespace text.').min(1, 'Section is missing text — every final section label requires one detail body').describe('Required detail body for this section label.'),
}, {
  error: (issue) => issue.code === 'unrecognized_keys'
    ? 'A section holds only label, node_ids and text. Below-node captions go in the top-level notes array as {node_id, caption} objects, never inside a section.'
    : undefined,
}).strict();

/** Section fields whose defect can be repaired without resending the other content. */
export type PresentResultSectionRepairField = keyof typeof PresentResultSectionSchema.shape | 'start';

/**
 * One section of a held repair draft: `node_ids` and `text` may each be omitted to keep the held
 * value under that label, so a repair that adds one node id never retypes a body the model cannot
 * see (the held-draft view shows labels and node ids only).
 */
const PresentResultSectionDeletionSchema = z.object({
  label: PresentResultSectionSchema.shape.label,
  remove: z.literal(true).describe('true drops the held section under this label; omit replacement content.'),
}).strict();
const PresentResultSectionPatchSchema = z.union([
  PresentResultSectionSchema.extend({
    node_ids: PresentResultSectionSchema.shape.node_ids.optional(),
    text: PresentResultSectionSchema.shape.text.optional().describe('Detail body for this section label. Required when the label is not a held label; omit to keep a held label\'s text.'),
  }),
  PresentResultSectionDeletionSchema,
]);

/** Memoized per block count: a fresh schema per request is a new identity, which defeats `toModelJsonSchema`'s cache. */
const previewSchemaCache = new Map<number, ReturnType<typeof buildPreviewSchemas>>();

/**
 * The preview stage schemas for an answer of `blockCount` served blocks. A section is the
 * {@link PresentResultSectionSchema} keys with the body given as the served id `B1`..`B<blockCount>`
 * it starts at, so an id outside the answer cannot be sent; the engine ends each section before the
 * next one's start. The patch form lets `node_ids` and `start` be omitted to keep the held value
 * under the label. Preview reuses the discovery prose for `summary`/`title`; the model authors
 * `name` itself.
 */
function buildPreviewSchemas(blockCount: number) {
  const [first, ...rest] = Array.from({ length: Math.max(blockCount, 1) }, (_, index) => `B${index + 1}`);
  const start = z.enum([first, ...rest]).describe('First block of `answer_blocks` this section presents, e.g. "B3"; it runs to the block before the next section\'s start, the last section to the end. The first section starts at B1; starts ascend strictly.');
  const section = z.object({
    label: PresentResultSectionSchema.shape.label,
    node_ids: PresentResultSectionSchema.shape.node_ids,
    start,
  }, {
    error: (issue) => issue.code === 'unrecognized_keys'
      ? 'A section holds only label, node_ids and start. Below-node captions go in the top-level notes array as {node_id, caption} objects, never inside a section.'
      : undefined,
  }).strict();
  const patch = z.union([
    section.extend({ node_ids: PresentResultSectionSchema.shape.node_ids.optional(), start: start.optional() }),
    PresentResultSectionDeletionSchema,
  ]);
  const model = PresentResultModelSchema.omit({
    summary: true,
    title: true,
    intro: true,
    closing: true,
    prune_node_ids: true,
    add_node_ids: true,
    is_update: true,
  }).extend({
    sections: sectionList(section).describe(
      'Required report sections, at least one. Each names the block of the served `answer_blocks` it starts at; every node analysed and captured is linked into a section\'s node_ids.',
    ),
  }).strict();
  const patchSections = sectionList(patch).optional().describe(REPAIR_SECTIONS_DESCRIPTION);
  return { model, patchSections, section };
}

function previewSchemas(blockCount: number) {
  let schemas = previewSchemaCache.get(blockCount);
  if (!schemas) {
    schemas = buildPreviewSchemas(blockCount);
    previewSchemaCache.set(blockCount, schemas);
  }
  return schemas;
}

/**
 * Schema defining the shape of the final generated presentation result.
 */
export const PresentResultModelSchema = z.object({
  name: z.string().max(PRESENT_RESULT_NAME_MAX).regex(/\S/, 'Name must not be blank.').min(1, 'name is required').describe('Short name for the generated lineage view — aim for ~60 chars.'),
  summary: z.string().regex(/\S/, 'Must contain non-whitespace text.').min(1, 'summary is required — one-line graph purpose (~120 chars)').describe('One-line summary shown with the generated view.'),
  title: z.string().max(PRESENT_RESULT_TITLE_MAX).optional().describe('Optional report heading.'),
  intro: z.string().optional().describe('Optional grounded introduction to the final report.'),
  closing: z.string().optional().describe('Closing synthesis. Length is never a rejection axis.'),
  prune_node_ids: z.array(NodeIdSchema).optional().describe('ONLY permitted during Completed Phase follow-ups. Strictly forbidden during the initial Synthesis Phase.'),
  add_node_ids: z.array(NodeIdSchema).optional().describe('ONLY permitted during Completed Phase follow-ups. Strictly forbidden during the initial Synthesis Phase.'),
  layout_direction: z.enum(['LR', 'TB']).optional().describe('Graph layout: left-to-right or top-to-bottom.'),
  highlight_groups: z.array(HighlightGroupSchema).min(1).describe(
    'REQUIRED, at least 1 group. For zero-trace or single-node results, use color "target" on the origin/result node.'
  ),
  sections: sectionList(PresentResultSectionSchema).describe(
    'Required final report sections, at least one. Every node analysed and captured this turn '
    + '(anything with a detail slot) is linked into a section\'s node_ids, as that field describes — '
    + 'an analysed node absent from every section fails validation.',
  ),
  notes: NotesModelSchema.optional(),
  is_update: z.boolean().optional().describe('True only when updating an existing presentation.'),
}).strict();

/**
 * One section of a report that is already committed: `text` and `node_ids` may each be omitted to
 * keep the committed body or links under that label.
 */
const PresentResultRetainedSectionSchema = PresentResultSectionSchema.extend({
  node_ids: z.array(NodeIdSchema).optional().describe('Nodes this section documents; put each node in one section. Omit to keep the committed links for this label; an empty array unlinks them.'),
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
 * @returns The same schema with `sections` optional and each section's `text` and `node_ids`
 *   optional.
 */
function withRetainableSections<T extends z.ZodObject<z.ZodRawShape>>(schema: T) {
  return schema.extend({
    sections: sectionList(PresentResultRetainedSectionSchema).optional()
      .describe('Final report sections. Omit entirely to keep the committed report; list a label with no text to keep that section unchanged.'),
  });
}

/**
 * Selects the model-facing `present_result` schema from the phase and held-draft authorization.
 * Preview omits AI-authored wrapper prose; synthesis uses the full new-render contract; either
 * phase projects the existing strict patch schema while a repairable draft is held.
 *
 * @remarks
 * An unrecognized key (a `notes` list nested under a section, for one) rejects through `.strict()`'s
 * own `Unrecognized key(s)` message, naming the offending key and path.
 *
 * `retainable` is a live session fact, not a stage property: a render amends a committed report
 * only while the run that authored it is still the one rendering. Preview never amends.
 *
 * @param phase - Stage the call will be dispatched in.
 * @param repairFields - Fields a held draft authorizes for repair, when one is held.
 * @param retainable - Whether a committed report from this run exists to amend.
 * @param previewBlockCount - Served `answer_blocks` count; the preview stage's block ids are
 *   exactly `B1`..`B<count>`.
 * @param highlightLabelIndexes - Held highlight entries whose labels alone may be replaced.
 * @param sectionLeaves - Held section indexes and fields that alone may be replaced.
 * @returns The schema this stage offers the model.
 */
export function presentResultSchemaForPhase(
  phase?: string,
  repairFields: readonly PresentResultRepairField[] | null = null,
  retainable = false,
  previewBlockCount = 0,
  highlightLabelIndexes?: readonly number[],
  sectionLeaves?: readonly IndexedRepairFields<PresentResultSectionRepairField>[],
): z.ZodType {
  if (repairFields) return presentResultRepairPatchSchemaForFields(repairFields, phase, previewBlockCount, highlightLabelIndexes, sectionLeaves, retainable);
  if (phase === 'visual_preview') return previewSchemas(previewBlockCount).model;
  const synthesis = phase === 'synthesis';
  const schema = retainable
    ? (synthesis ? PresentResultRetainingSynthesisModelSchema : PresentResultRetainingModelSchema)
    : (synthesis ? PresentResultSynthesisModelSchema : PresentResultModelSchema);
  return schema;
}

/** How a resent `sections` list merges into the held draft is stated once, by the rejection (`keyedResendRule`). */
const REPAIR_SECTIONS_DESCRIPTION = 'Sections to add or change, keyed by label.';

/** One note of a held repair draft: a caption to add or replace under its node id, or the removal of the held one. */
const PresentResultNotePatchSchema = z.union([
  NoteSchema,
  z.object({
    node_id: NoteSchema.shape.node_id,
    remove: z.literal(true).describe('true drops the held note for this node id.'),
  }).strict(),
]);

/** Validates assembled sections against their stage's original schema after a repair merge. */
export function mergedSectionsSchemaForPhase(phase: string, previewBlockCount: number): z.ZodType {
  return phase === 'visual_preview' ? z.object({ sections: previewSchemas(previewBlockCount).model.shape.sections }) : MergedSectionsSchema;
}

/**
 * Strict patch schema for repairing a held `present_result` draft.
 *
 * @remarks
 * A repair payload is accepted whenever the session holds a previously held full draft from a narrow
 * repairable failure; because that held-draft context IS the authorization, `is_update` is a value
 * the model need not echo — the merge keeps the held draft's own. It may replace presentation
 * text/link/color fields (all
 * optional — an omitted key keeps the held draft's value) but cannot edit graph structure. Unknown
 * fields reject at the Zod boundary. DERIVED from {@link PresentResultModelSchema} via `.pick().partial()`
 * — not hand-listed — so a presentation field added there can never silently drift out of the repair
 * contract. `prune_node_ids`/`add_node_ids` are deliberately NOT picked: a repair patch cannot edit
 * graph structure. `sections` alone is re-declared over {@link PresentResultSectionPatchSchema}: a
 * resent section may omit `text`/`node_ids` to keep the held values under its label, while the
 * list itself keeps the model schema's non-empty bound (an empty list changes nothing and is a
 * boundary reject, never a silent no-op merge). The inferred type lives in `presentResult.ts` (its
 * sole consumer) as the single source of truth.
 */
const PresentResultRepairPatchSchema = PresentResultModelSchema.pick({
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
  sections: sectionList(PresentResultSectionPatchSchema).optional().describe(REPAIR_SECTIONS_DESCRIPTION),
  notes: z.array(PresentResultNotePatchSchema).min(1).optional().describe('Notes to add or change, keyed by node_id.'),
  is_update: z.boolean().optional().describe('Optional — a repair keeps the held draft\'s own value; the value sent here is not applied.'),
}).strict();

/**
 * The repair patch plus the graph-edit fields, which only a rejection of that same edit may authorize.
 *
 * @remarks
 * A held draft that fails on `add_node_ids`/`prune_node_ids` is otherwise unrepairable: the patch
 * cannot edit them, so the model has no call that corrects the field the rejection names. Beyond
 * that, only a completed-stage node-id rejection that offers `add_node_ids` as its route authorizes
 * it; a repair of any other field still cannot change graph structure.
 */
export const PresentResultAuthorizableRepairSchema = PresentResultRepairPatchSchema.extend({
  prune_node_ids: PresentResultModelSchema.shape.prune_node_ids,
  add_node_ids: PresentResultModelSchema.shape.add_node_ids,
}).strict();

/** Fields that a held-draft rejection may explicitly authorize for repair. */
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

/** Graph-edit fields that only a rejection of that same edit authorizes for repair. */
const PRESENT_RESULT_GRAPH_EDIT_FIELDS = ['prune_node_ids', 'add_node_ids'] as const;

/** Every top-level field `lineage_present_result` defines in any stage; a key outside it is not a field of the tool. */
export const PRESENT_RESULT_DEFINED_FIELDS: ReadonlySet<string> = new Set(Object.keys(PresentResultModelSchema.shape));

/** Presentation field that may be authorized in a held-draft repair patch. */
export type PresentResultRepairField = typeof PRESENT_RESULT_REPAIR_FIELDS[number] | typeof PRESENT_RESULT_GRAPH_EDIT_FIELDS[number];

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

/** Strict indexed replacements derived from the original field schemas for both held lists. */
function indexedRepairList(leaves: readonly IndexedRepairFields[], shape: z.ZodRawShape, list: string) {
  const entries = leaves.map(leaf => z.object({ index: z.literal(leaf.index),
    ...Object.fromEntries(leaf.fields.map(field => [field, shape[field]])),
  }).strict());
  const entry = entries.length === 1 ? entries[0]!
    : z.union(entries as [typeof entries[number], typeof entries[number], ...Array<typeof entries[number]>]);
  return z.array(entry).length(leaves.length).superRefine((values, ctx) => {
    const seen = new Set<number>();
    for (const [index, value] of values.entries()) {
      if (seen.has(value.index)) ctx.addIssue({ code: 'custom', path: [index, 'index'], message: `Send each authorized ${list} index once.` });
      seen.add(value.index);
    }
  }).describe(`Replace only indexed fields: ${leaves.map(leaf => `${leaf.index} (${leaf.fields.join(', ')})`).join('; ')}. Other fields and entries stay held.`);
}

/**
 * Builds the strict provider/runtime patch schema for a held-draft repair.
 *
 * @remarks
 * Outside the visual preview every presentation field stays sendable and replaces the held value,
 * so a repair carrying more than the rejection asked for is merged instead of refused; the
 * authorized fields are the ones the patch owes. A graph-edit field is sendable only when
 * authorized, and a preview repair accepts the authorized fields only.
 * A sole authorized field is `required` in the served schema, so a patch without it fails as a
 * missing property. Several fields `superRefine` one rule: a patch naming none of them (only
 * `is_update`, or nothing) rejects at the Zod boundary with one issue per authorized field, so
 * `issuePaths` names the whole set instead of an empty patch re-running the held-draft validation.
 * The receiving presentation handler admits raw arguments against this exact live schema; ports only decode transport arguments.
 *
 * @param fields - Held presentation fields authorized by the rejection.
 * @param phase - Stage serving the repair schema.
 * @param previewBlockCount - Number of engine-served preview blocks.
 * @param highlightLabelIndexes - Highlight entries restricted to `{index, label}` leaf repair.
 * @param sectionLeaves - Section entries restricted to the indexed fields named by the rejection.
 * @param retainable - Whether a committed report exists whose sections an omitted `sections` keeps.
 * @returns A strict schema owing the authorized fields and accepting every other presentation field.
 */
export function presentResultRepairPatchSchemaForFields(
  fields: readonly PresentResultRepairField[],
  phase?: string,
  previewBlockCount = 0,
  highlightLabelIndexes?: readonly number[],
  sectionLeaves?: readonly IndexedRepairFields<PresentResultSectionRepairField>[],
  retainable = false,
): z.ZodType<z.infer<typeof PresentResultAuthorizableRepairSchema>> {
  const keys = [...new Set<PresentResultRepairField>(fields)].sort();
  const preview = phase === 'visual_preview';
  const labelIndexes = highlightLabelIndexes ? [...new Set(highlightLabelIndexes)].sort((left, right) => left - right) : undefined;
  const sectionRepairs = sectionLeaves?.map(leaf => ({ index: leaf.index, fields: [...new Set(leaf.fields)].sort() }))
    .sort((left, right) => left.index - right.index);
  const cacheKey = `${preview ? `preview${previewBlockCount}:` : ''}${retainable ? 'retain:' : ''}${keys.join(',')}${labelIndexes ? `:labels=${labelIndexes.join(',')}` : ''}${sectionRepairs ? `:sections=${sectionRepairs.map(leaf => `${leaf.index}.${leaf.fields.join('+')}`).join(',')}` : ''}`;
  const cached = repairPatchSchemaCache.get(cacheKey);
  if (cached) return cached as z.ZodType<z.infer<typeof PresentResultAuthorizableRepairSchema>>;
  const sendable = preview ? keys : [...PRESENT_RESULT_REPAIR_FIELDS, ...keys];
  const mask = Object.fromEntries([...sendable, 'is_update'].map(key => [key, true]));
  const picked = PresentResultAuthorizableRepairSchema.pick(
    mask as Partial<Record<keyof typeof PresentResultAuthorizableRepairSchema.shape, true>>,
  );
  let staged = (preview && keys.includes('sections')
    ? picked.extend({ sections: previewSchemas(previewBlockCount).patchSections })
    : picked) as z.ZodObject<z.ZodRawShape>;
  if (labelIndexes) staged = staged.extend({ highlight_groups: indexedRepairList(
    labelIndexes.map(index => ({ index, fields: ['label'] })), HighlightGroupSchema.shape, 'highlight_groups') });
  if (sectionRepairs) staged = staged.extend({ sections: indexedRepairList(sectionRepairs,
    preview ? previewSchemas(previewBlockCount).section.shape : PresentResultSectionSchema.shape, 'sections') });
  const declared = labelIndexes || sectionRepairs
    ? staged.required(Object.fromEntries(keys.map(key => [key, true])) as Record<string, true>)
    // A committed report keeps its sections when the repair omits them, so a lone `sections` field is optional then.
    : keys.length === 1 && !(retainable && keys[0] === 'sections')
    ? (staged as z.ZodObject<z.ZodRawShape>).required({ [keys[0]]: true })
    : staged;
  const strict = declared.strict().superRefine((data, ctx) => {
    if (keys.length < 2) return;
    const touchesAuthorizedField = keys.some(
      key => (data as Record<string, unknown>)[key] !== undefined,
    );
    if (touchesAuthorizedField) return;
    const message = `Repair patch named no authorized field; send at least one of: ${keys.join(', ')}.`;
    for (const key of keys) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message });
    }
  });
  const schema = strict as z.ZodType<z.infer<typeof PresentResultAuthorizableRepairSchema>>;
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
const PresentResultSynthesisModelSchema = PresentResultModelSchema.omit({
  prune_node_ids: true,
  add_node_ids: true,
  is_update: true,
}).strict();

/**
 * The stage projections a render that amends a committed report is offered and parsed against.
 *
 * @remarks
 * Declared here rather than beside each source because {@link PresentResultSynthesisModelSchema} is
 * the last source to exist; the selector reads them, so each is built once per process.
 * A supplement round exits through synthesis, not the completed stage, so both stages have a
 * retaining projection.
 */
const PresentResultRetainingModelSchema = withRetainableSections(PresentResultModelSchema);
const PresentResultRetainingSynthesisModelSchema = withRetainableSections(PresentResultSynthesisModelSchema);

/**
 * Model-facing `lineage_submit_findings` input schema (the permissive BB∪CT superset).
 *
 * @remarks
 * The participant tool catalog retains the union of the BB and CT contracts
 * (`prune_neighbors`, `questions` and `column_flow`).
 * Instruction-plan compilation advertises the strict mode-and-classification-locked
 * schema (`submitFindingsSchemaForMode`) immediately before model dispatch, and the handler validates
 * the payload against that same contract. This is the model-facing
 * source used by `TOOL_DEFS`; the tool is dispatched internally and is not registered with VS Code.
 */
export const SubmitFindingsModelSchema = z.object({
  focus_node_id: z.string().describe('`focus_node.id` from `<hop_context>`.'),
  summary: z.string().optional().describe(SUMMARY_DESCRIPTION),
  prune_neighbors: z.array(PruneNeighborSchema).max(MAX_ID_LIST_LENGTH).optional().describe(PRUNE_NEIGHBORS_DESCRIPTION),
  questions: z.array(CtNeighborQuestionSchema).max(MAX_ID_LIST_LENGTH).optional().describe(QUESTIONS_DESCRIPTION),
  column_flow: ColumnFlowSchema.optional(),
  terminated_inputs: TerminatedInputsSchema.optional(),
  badge_label: advertisedMax(z.string(), { maxLength: SUBMIT_FINDINGS_BADGE_LABEL_MAX }).min(1)
    .refine(value => value.trim().length > 0, 'badge_label must contain non-whitespace text')
    .optional()
    .describe(BADGE_LABEL_DESCRIPTION),
  sections: CapturedSectionsSchema.optional().describe(SECTIONS_DESCRIPTION),
}).strict();

/**
 * Validates a discovery-tool input against its Zod schema.
 *
 * @remarks
 * The single runtime validation surface for the discovery tools: the Zod schema in this file is
 * the SSOT — no second hand-written field map. A failure is the one rejection shape, its reason
 * listing every violated field with the received value.
 *
 * @param schema - The tool's input schema (e.g. {@link SearchObjectsInputSchema}).
 * @param input - The raw input object provided by the language model.
 * @returns Parsed data on success, or the rejection naming every offending field.
 */
export function parseToolInput<T extends z.ZodType>(
  schema: T,
  input: unknown,
):
  | { readonly ok: true; readonly data: z.output<T> }
  | { readonly ok: false; readonly error: ToolRejection } {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, error: rejectionFromZodError(parsed.error, { code: REJECTION_CODES.invalidInput, input, schema }) };
}
