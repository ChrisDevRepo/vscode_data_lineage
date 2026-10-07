/**
 * Zod input schemas and lightweight runtime validation for the AI tools.
 * Zero VS Code imports — pure schema definitions.
 */
import { z } from 'zod';
import { resolveModelNodeId } from '../support/inputNormalization';
import { MAX_ID_LIST_LENGTH, SCREEN_STATE_MAX_IDS, ColumnTransformClassSchema } from '../../engine/shared/bridgeContract';
import {
  ExplorationDepthLimitSchema,
  ExplorationDepthSelectionSchema,
  numericStringDepth,
} from '../../engine/shared/explorationDepthContract';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { rejectionFromZodError, type ToolRejection } from '../support/toolErrorEnvelope';
import { CLASSIFICATION_KEPT_ANGLES, type ClassificationValue } from '../session/classification';
import { extractRawSectionAngles } from '../interaction/rules/submitFindingsRules';
import type { HeldSubmissionParts, HopFinding, HopFindingKept, HopSubmission } from '../sm/smTypes';
import { keyedResendRule } from '../support/repairDraftStore';

/**
 * A column identifier the user actually named. Wildcards are rejected at the boundary: a
 * wildcard target column locks an unwinnable CT session because no real column can match it.
 */
export const ColumnIdentifierSchema = z.string().trim().min(1).regex(/^[^*%?]+$/, 'wildcards are not column identifiers').describe(
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
    + 'reachable in that direction inside the approved schema selection is analysed and joins the same graph. Omit to add the named objects only.',
  ),
}).strict().describe(
  'Completed-session analysis extension, sent alone: a supplement call carries no other field — it runs in the '
  + "approved trace's mode, columns and scope. nodeIds lie inside the approved schema selection; an object outside it "
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
  'Starting scope: {upstream, downstream}, each {levels, exactness}; upstream levels reach the sources, downstream levels reach the consumers that read the origin. levels is a non-negative integer or "all"; 0 permanently closes that side for the session. exactness is "exact" when the user literally stated that level count, "approximate" when it is your own estimate — an approximate count above 0 does not bound the scope, which runs until the filters or the border stop it. Required for a fresh proposal; omit on a refine to keep the reviewed depth.';

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
/** A `get_scope_bundle` depth: a non-negative integer, a canonical digit string, or `"all"`. */
const ScopeDepthSchema = numericStringDepth(z.union([z.number().int().min(0), z.literal('all')]));
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
 * Applicability prefix for the fields only a kept verdict carries (`sections`, `badge_label`,
 * `prune_neighbors`), so each field states in its own describe its requirements.
 */
const KEPT_VERDICT_ONLY = 'Only with analyze or passthrough: ';

/** Requirement prefix for `summary` and `sections`, which a kept verdict must carry. */
const KEPT_VERDICT_REQUIRED = 'Required with analyze or passthrough. ';

/**
 * Single source for the `prune_neighbors` field describe text, shared by the strict per-mode
 * schemas and the permissive participant union so the two cannot drift.
 */
const PRUNE_NEIGHBORS_DESCRIPTION =
  'Name each `can_prune: true` neighbor this node\'s SQL shows is off the path; that neighbor and whatever only it leads to are removed. '
  + 'The focus stays on the graph, including when every neighbor is named (a dead end). A neighbor named here gets no questions entry.';

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
  KEPT_VERDICT_ONLY + 'Provide a self-contained subquestion for each eligible in-scope neighbor kept for analysis or passthrough, tied to the user question. '
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

/** Single source for the `reason` describe text. The served verdicts do not use it. */
const IGNORED_REASON_DESCRIPTION =
  'Ignored on analyze and passthrough. Omit it.';

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
const BADGE_LABEL_DESCRIPTION = KEPT_VERDICT_ONLY + '2-4 word label for this node.';

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
    'combine: join, grouping, partition or ordering key. filter: predicate ' +
    'selecting contributing rows. Grouping, partition and ordering keys are not aggregate value inputs; ' +
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
const OUT_COL_DESCRIPTION = 'Output column resolved from this hop\'s column task; for a procedure, the column it writes to writes_to.';

const ColumnFlowEntrySchema = z.object({
  out_col: z.string().describe(OUT_COL_DESCRIPTION),
  writes_to: ColumnFlowWritesToObject.nullish().describe('Actual destination object and column for this procedure\'s output, as declared by its SQL; null when it writes no table.'),
  returns_to: ColumnFlowWritesToObject.optional().describe('Real caller output supplied in caller_output_targets for this scalar-return task; never a table write.'),
  upstream_columns: z.array(ColumnRefSchema).describe(
    'At a bodied focus, only the real source columns whose value flows into out_col: operands of its expression, ' +
    'an aggregate’s argument, each set-operation branch’s column at that position, caller-bound value inputs. ' +
    'A column used only to join, filter, group, partition or order rows is not a source: omit it here and state it in sections. ' +
    'Exclude the entry’s own writes_to column and unused expressions. Resolve parameters and computed aliases to their source columns. ' +
    'At a bodyless focus, follow carrier-side neighbours (writers upstream, readers downstream) with the ' +
    'tracked column unchanged; [] only when out_col terminates here.',
  ),
}).strict();


/**
 * `verdict` field for `submit_findings`: one definition set for BB, CT and the participant union.
 *
 * @remarks
 * CT is BB plus columns, so the verdict words mean the same in both modes. The focus is never
 * removed: a neighbor off the path is named in `prune_neighbors`.
 */
const HopVerdictSchema = z.enum(['analyze', 'passthrough']).describe(
  'analyze: transforms data on the answer path (a calculation, condition, filter, join or status change). '
  + 'passthrough: on the path, handing values on unchanged (a stored table, SELECT *, a synonym). '
  + 'The focus stays. Name off-path neighbors in prune_neighbors; naming every neighbor leaves this node visible as a dead end.',
);

const COLUMN_FLOW_DESCRIPTION = 'One entry per tracked column this node carries; [] when it carries none. `upstream_columns` names what each neighbor carries.';

const ColumnFlowSchema = z.array(ColumnFlowEntrySchema).describe(COLUMN_FLOW_DESCRIPTION);

/** Single source for the `sections` describe text, shared by the per-mode schemas and the participant union. */
const SECTIONS_DESCRIPTION = KEPT_VERDICT_REQUIRED + 'Pre-formatted section body per fired capture recipe, keyed by angle: `{business, technical}`; a locked classification keeps only its angle key(s).';

/** Single source for the `summary` describe text, shared by the per-mode schemas and the participant union. */
const SUMMARY_DESCRIPTION =
  KEPT_VERDICT_REQUIRED + 'One sentence, readable without this hop: what this node does to the data and what it hands to which node.';

/**
 * Shared `submit_findings` fields across BB and CT modes, one flat object.
 *
 * @remarks
 * Flat by design: a top-level `anyOf` defeats constrained decoding, so the verdict-dependent shape
 * (it carries sections and summary) is stated in
 * the describes and enforced by {@link refineSubmitFindingsShape} at parse.
 */
const HopFindingBaseSchema = z.object({
  focus_node_id: z.string().describe('`focus_node.id` from `<hop_context>`.'),
  verdict: HopVerdictSchema,
  summary: z.string().optional().describe(SUMMARY_DESCRIPTION),
  badge_label: advertisedMax(z.string(), { maxLength: SUBMIT_FINDINGS_BADGE_LABEL_MAX }).min(1)
    .refine(value => value.trim().length > 0, 'badge_label must contain non-whitespace text')
    .optional()
    .describe(BADGE_LABEL_DESCRIPTION),
  prune_neighbors: z.array(PruneNeighborSchema).max(MAX_ID_LIST_LENGTH).optional().describe(PRUNE_NEIGHBORS_DESCRIPTION),
  questions: z.array(NeighborQuestionSchema).max(MAX_ID_LIST_LENGTH).optional().describe(QUESTIONS_DESCRIPTION),
  reason: z.string().optional().describe(IGNORED_REASON_DESCRIPTION),
  /**
   * One string per fired `*_capture` template, keyed by angle. One key (`business` /
   * `technical` classification) or two (`both`) — required with a kept verdict. Declared last:
   * a model emits arguments in schema order, so the long prose closes the object after every
   * short field.
   */
  sections: CapturedSectionsSchema.optional().describe(SECTIONS_DESCRIPTION),
}).strict();

const { sections, summary, badge_label, prune_neighbors, reason } = HopFindingBaseSchema.shape;

/**
 * CT form: the BB form plus `column_flow` (served-required — always in the served `required` list,
 * `[]` allowed for a verdict that needs no entries), declared right after `verdict`, ahead of
 * `sections`/`summary`, so the short required structured field is emitted before the long capture
 * prose: a model emits arguments in schema order, and a required field placed after several
 * thousand characters of section text tends to drop on the longest `analyze` generations.
 */
const HopFindingCtBaseSchema = HopFindingBaseSchema
  .omit({ sections: true, summary: true, badge_label: true, prune_neighbors: true, questions: true, reason: true })
  .extend({
    column_flow: ColumnFlowSchema,
    summary,
    badge_label,
    prune_neighbors,
    questions: z.array(CtNeighborQuestionSchema).max(MAX_ID_LIST_LENGTH).optional().describe(QUESTIONS_DESCRIPTION),
    reason,
    sections,
  })
  .strict();

/**
 * The flat, wire-shaped `submit_findings` payload once shape- and classification-validated —
 * `sections` still keyed by angle, before {@link toHopFinding} converts it to the engine's
 * internal union. This is what {@link submitFindingsSchemaForMode} itself parses to: the schema is
 * a validator only, so parsing an already-valid `FlatSubmitFindings` a second time is a no-op.
 */
export type FlatSubmitFindings = z.output<typeof HopFindingBaseSchema> & { column_flow?: z.output<typeof ColumnFlowSchema> };

/** Tool-call argument notation inside a string value: the start of a named argument, or the end of one or of the call. */
const ARGUMENT_BOUNDARY = /<parameter\s+name="([A-Za-z_]\w*)"\s*>|<\/parameter>|<\/invoke>/;

/**
 * Finds a tool-call argument boundary inside one string argument: the value was delivered with the
 * arguments that follow it still attached.
 *
 * @param value - The string argument as received.
 * @param field - The argument's own name; its closing tag counts as a boundary.
 * @returns The first argument named after the boundary, `''` when a boundary names none, `null`
 *   when the value carries no boundary.
 */
export function displacedArgumentIn(value: string, field: string): string | null {
  const named = /<parameter\s+name="([A-Za-z_]\w*)"\s*>/.exec(value);
  if (named) return named[1];
  return ARGUMENT_BOUNDARY.test(value) || value.includes(`</${field}>`) ? '' : null;
}

/**
 * Enforces the fresh kept shape of one flat `submit_findings` payload.
 *
 * @remarks
 * A `summary` that still carries another argument ({@link displacedArgumentIn}) fails at its own
 * path on every call, fresh or not, so it is never held; when the argument it carries is `sections`,
 * that one issue states the fault and the missing-`sections` issue is not added beside it.
 * A kept verdict carries `sections` and `summary` (and, in CT, `column_flow`). A `reason` sent
 * with it is accepted and dropped by {@link toHopFinding}. `summary` may be empty only when a held
 * draft exists (`fresh` unset), and the engine keeps the held summary. A fresh kept verdict under
 * a `both` lock that sends a non-empty `sections` names each missing angle in the same parse as any
 * shape fault. An invalid or missing `verdict` is reported once by its own enum issue and skips
 * every verdict-dependent check. Each fault is one issue on its own path, so the rejection names
 * the exact field to drop or add.
 */
function refineSubmitFindingsShape(value: FlatSubmitFindings, ctx: z.RefinementCtx, fresh: boolean, classification?: ClassificationValue): void {
  if (typeof value !== 'object' || value === null || !HopVerdictSchema.safeParse(value.verdict).success) return;
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
  const displaced = typeof value.summary === 'string' ? displacedArgumentIn(value.summary, 'summary') : null;
  if (displaced !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['summary'],
      message: 'carries another argument after its sentence.',
      params: {
        hint: displaced
          ? `End summary at its one sentence. Send the text after it as the separate \`${displaced}\` argument.`
          : 'End summary at its one sentence. Send every other field as its own argument.',
      },
    });
  }
  const filled = new Set(Object.entries(value.sections ?? {})
    .filter(([, body]) => typeof body === 'string' && body.trim() !== '').map(([angle]) => angle));
  if (fresh && filled.size === 0 && displaced !== 'sections') {
    ctx.addIssue({
      code: 'custom',
      path: ['sections'],
      message: `required with verdict ${value.verdict}.`,
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
      message: `required with verdict ${value.verdict}.`,
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
    verdict: value.verdict,
    sections: extractRawSectionAngles(value.sections ?? {}),
    summary: value.summary ?? '',
  };
  if (value.badge_label !== undefined) kept.badge_label = value.badge_label;
  if (value.prune_neighbors !== undefined) kept.prune_neighbors = value.prune_neighbors;
  if (value.questions !== undefined) kept.questions = value.questions;
  if (value.column_flow !== undefined) kept.column_flow = value.column_flow;
  return kept;
}

/**
 * Applies the verdict-shape check to one flat per-mode object.
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
    : schema;
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
 * The node's self-status is `analyze` (carries lineage) or `passthrough` (kept, not a key transform).
 * The focus stays. Every open neighbour not named in `prune_neighbors` is enqueued; `questions`
 * attach a check to one of them. Naming every neighbor leaves the focus visible as a dead end.
 * BB does not carry CT-only `column_flow`.
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
 * One kept angle drops the other key. Sending it on a kept verdict raises a custom issue from
 * {@link refineSubmitFindingsShape} whose hint says to fold that key's content into the kept angle.
 * The fold guidance also lives on the kept key's description, where the model reads it before
 * authoring. `both` keeps both angles, each key optional; a fresh kept submission serves both keys
 * through {@link finalizeSubmitFindingsSchema}'s conditional requiredness, so a retry with a held
 * draft names only the angle it changes. {@link refineSubmitFindingsShape} refuses `{}` on a kept
 * verdict of a fresh submission and names a missing angle of a fresh `both` submission in the same
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
 * The per-hop column facts that narrow the served CT `column_flow` entry.
 *
 * @remarks
 * `outCols` is the hop's active tracked columns when the validator accepts nothing else as
 * `out_col` (an upstream trace), `[]` when no tracked local output is eligible, and `null` when it accepts any focus column. `writesTo` is true only
 * for a procedure focus, the one node that writes a column elsewhere.
 */
export interface SubmitFindingsHopColumns {
  readonly outCols: readonly string[] | null;
  readonly writesTo: boolean;
  readonly returnTargets?: readonly { readonly node: string; readonly col: string }[];
  /** Neighboring functions eligible for an explicit current-caller output investigation. */
  readonly callerContextNodeIds?: readonly string[];
  /**
   * Sorted ids the loaded store metadata admits as `upstream_columns` sources: focus neighbors
   * (and read suppliers of its declared scalar callers) that carry stored columns or hold the
   * procedure/external missing-metadata fallback. Columnless scalar functions are absent; they
   * stay eligible in `questions` via {@link SubmitFindingsHopColumns.callerContextNodeIds}.
   */
  readonly columnSourceNodeIds?: readonly string[];
}

/**
 * Advertises the hop's metadata-eligible contributor ids as the served `node` enum while
 * admitting the equivalent spellings ({@link resolveModelNodeId}) the engine itself resolves,
 * so normalized object references keep passing the boundary a columnless function cannot.
 */
function columnSourceNodeSchema(sources: readonly string[]) {
  const resolvable = new Map(sources.map(id => [id, id] as const));
  return z.string().refine(
    value => resolveModelNodeId(value, resolvable) !== null,
    { message: 'upstream_columns[].node must name a served column-carrying source; a scalar function without stored columns is named in questions, not as a column source.' },
  ).meta({ enum: [...sources] });
}

/** Projects {@link ColumnFlowSchema} onto one hop: `out_col` as the hop's tracked-column enum, `writes_to` only for a procedure focus. */
function columnFlowSchemaForHop(hop: SubmitFindingsHopColumns) {
  const [first, ...rest] = hop.outCols ?? [];
  const outCol = first === undefined
    ? ColumnFlowEntrySchema.shape.out_col
    : z.enum([first, ...rest]).describe(OUT_COL_DESCRIPTION);
  const upstreamColumns = hop.columnSourceNodeIds
    ? z.array(ColumnRefSchema.extend({ node: columnSourceNodeSchema(hop.columnSourceNodeIds) }).strict()).describe(ColumnFlowEntrySchema.shape.upstream_columns.description ?? '')
    : ColumnFlowEntrySchema.shape.upstream_columns;
  const shape = {
    out_col: outCol,
    upstream_columns: upstreamColumns,
    writes_to: ColumnFlowEntrySchema.shape.writes_to.unwrap().describe(ColumnFlowEntrySchema.shape.writes_to.description ?? ''),
  };
  if (hop.returnTargets?.length) {
    const destinations = hop.returnTargets.map(target => z.object({
      out_col: z.literal(target.col),
      returns_to: z.object({ node: z.literal(target.node), col: z.literal(target.col) }).strict(),
      upstream_columns: shape.upstream_columns,
    }).strict());
    const entry = destinations.length === 1 ? destinations[0]! : z.union(destinations as [typeof destinations[number], typeof destinations[number], ...Array<typeof destinations[number]>]);
    return z.array(entry).describe('One entry per qualified caller_output_target; returns_to is required. Read the supplied caller SQL and function body to identify real contributors; [] upstream only when the target terminates locally.');
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
 * `required` list, `[]` allowed for a verdict that needs no entries). When
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
 * @param freshSubmission - Refuse `{}` sections and an empty `summary` on a kept verdict; unset
 * so a held draft or an archived angle still validates.
 * @param hop - CT only: the active hop's column facts; narrows `column_flow[].out_col`, offers
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
): z.ZodType<FlatSubmitFindings> {
  const hopKey = mode === 'ct' && hop ? `${hop.writesTo}:${JSON.stringify(hop.outCols)}:${JSON.stringify(hop.returnTargets ?? [])}:${JSON.stringify(hop.callerContextNodeIds ?? null)}:${JSON.stringify(hop.columnSourceNodeIds ?? null)}` : '';
  if (!classification && !hopKey && freshSubmission) {
    return mode === 'ct' ? SubmitFindingsCtInputSchema : SubmitFindingsBbInputSchema;
  }
  const cacheKey = `${mode}:${classification ?? ''}:${freshSubmission}:${hopKey}`;
  const cached = submitFindingsSchemaCache.get(cacheKey);
  if (cached) return cached;
  let narrowed = (mode === 'ct' ? HopFindingCtBaseSchema : HopFindingBaseSchema) as typeof HopFindingCtBaseSchema;
  if (hopKey && hop) narrowed = narrowed.extend({ column_flow: columnFlowSchemaForHop(hop) }).strict() as typeof HopFindingCtBaseSchema;
  if (mode === 'ct' && hop?.callerContextNodeIds) {
    const [first, ...rest] = hop.callerContextNodeIds;
    const question = first === undefined ? NeighborQuestionSchema : z.union([
      NeighborQuestionSchema,
      CtNeighborQuestionSchema.extend({ nodeId: z.enum([first, ...rest]).describe(NeighborQuestionSchema.shape.nodeId.description ?? '') }),
    ]);
    narrowed = narrowed.extend({ questions: z.array(question).max(MAX_ID_LIST_LENGTH).optional().describe(QUESTIONS_DESCRIPTION) }).strict() as typeof HopFindingCtBaseSchema;
  }
  if (classification) {
    const kept = CLASSIFICATION_KEPT_ANGLES[classification];
    const sectionsDescribe = kept.length === CLASSIFICATION_KEPT_ANGLES.both.length
      ? KEPT_VERDICT_REQUIRED + 'Pre-formatted section body for the `business` and `technical` recipes, under keys `business` and `technical`.'
      : `${KEPT_VERDICT_REQUIRED}Pre-formatted section body for the \`${kept[0]}\` recipe, under key \`${kept[0]}\`.`;
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
 * Shares field schemas and verdict requirements with wire admission while retaining section arrays.
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
  return base.omit({ reason: true }).extend({
    verdict: z.enum(['analyze', 'passthrough']),
    summary: HopFindingBaseSchema.shape.summary.unwrap(),
    sections: z.array(section),
    ...(mode === 'ct' ? { column_flow: requireColumnFlow ? flow : flow.optional() } : {}),
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

/** Validates a typed finding before held merge or mutation, sharing wire fields and verdict checks. */
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

/** Required call envelope retained by every held findings repair. */
export const HELD_FINDING_CALL_ORDER =
  'Resend the full call: always focus_node_id, verdict and every other required field; the failed field(s) corrected';

/** The shared resend rule for a finding rejection whose schema-valid content remains held. */
export function heldSubmissionRepairHint(held: HeldSubmissionParts): string {
  const labels = [
    ...(held.sections.length > 0 ? [`sections (${held.sections.join(', ')})`] : []),
    ...(held.summary ? ['summary'] : []),
    ...held.fields,
  ].join(', ');
  const omittable = [...(held.summary ? ['summary'] : []), ...held.fields];
  return `Held: ${labels}. ${HELD_FINDING_CALL_ORDER}`
    + (omittable.length > 0 ? `; omit ${omittable.join(', ')} to keep the held ${omittable.length > 1 ? 'values' : 'value'}` : '')
    + '.'
    + (held.sections.length > 0 ? ` ${keyedResendRule('sections', 'angle')}` : '');
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
 * Error text for a string over its hard cap: the dotted path, the measured length and the limit.
 * A model cannot count characters, so the measured length is part of the message; the engine never
 * truncates authored text.
 */
function overLength(limit: number) {
  return {
    error: (issue: z.core.$ZodRawIssue) =>
      `${(issue.path ?? []).join('.')} is over its length limit: ${String(issue.input).length} chars, limit ${limit}. Shorten it — the engine never truncates authored text.`,
  };
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
  for (const [index, { label }] of sections.entries()) {
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
 * One model-supplied node id: trimmed, required non-empty.
 *
 * @remarks
 * A blank or whitespace-only entry would otherwise pass this boundary, resolve to nothing, and
 * surface as an "unknown IDs" rejection whose offender list renders empty. Rejecting it here names
 * the exact array index instead, which is a field path a repair can act on. Invisible-character
 * stripping belongs to `resolveModelNodeId` (`src/engine/shared/nodeIdResolution.ts`).
 */
const NodeIdSchema = z.string()
  .trim()
  .min(1, 'Node ID must not be blank.');

/**
 * One below-node caption. Its keys share nothing with a `sections[]` item's
 * `{label, node_ids, text}`, so `.strict()` names the offending keys when the two are conflated.
 */
const NoteSchema = z.object({
  node_id: NodeIdSchema.describe('Node ID the caption sits below.'),
  caption: z.string().trim().min(1, 'Note is missing its caption').describe('One-sentence caption, grounded in the evidence supplied for this stage.'),
}).strict();

/**
 * `present_result.notes`: an array of declared-key objects, the one object shape every
 * function-calling schema dialect expresses — a map keyed by data (`additionalProperties` with a
 * value schema) is not portable across providers. The parsed value is the shape every consumer
 * reads, so a held draft re-validates unchanged. A node ID given two different captions rejects,
 * since one of them would otherwise be lost; an identical repeat is harmless.
 */
const NotesModelSchema = z.array(NoteSchema)
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

/**
 * Schema for a visual highlight group, grouping nodes by a shared role or status.
 */
const HighlightGroupSchema = z.object({
  label: z.string().trim().min(1, 'Group label is required').max(PRESENT_RESULT_HIGHLIGHT_LABEL_MAX, overLength(PRESENT_RESULT_HIGHLIGHT_LABEL_MAX)).describe('Short legend label describing the shared graph role or status; length target: see the `highlights` output template.'),
  color: HighlightSchemeSchema.describe('Flow role or status. `source`: the deepest origins whose data feeds the answer. `target`: where the data lands — the queried object in an upstream trace. `transform`: nodes that create or change the answer\'s values. `good` / `warn` / `fail`: diagnostic status. One scheme per result.'),
  node_ids: z.array(NodeIdSchema).describe('Node IDs that share this graph role or status.'),
}).strict();

/**
 * One final report section: a label that becomes both the section heading and the graph badge, the
 * nodes it explains, and its detail body.
 */
const PresentResultSectionSchema = z.object({
  label: z.string().max(PRESENT_RESULT_SECTION_LABEL_MAX, overLength(PRESENT_RESULT_SECTION_LABEL_MAX)).trim().min(1, 'Section label is required — provide a short final label for this detail section').describe('What the section\'s nodes share, as heading and badge (30 chars). No object names.'),
  node_ids: z.array(NodeIdSchema).describe('Nodes this section documents; put each node in one section. Empty array when it documents none.'),
  text: z.string().trim().min(1, 'Section is missing text — every final section label requires one detail body').describe('Required detail body for this section label.'),
}, {
  error: (issue) => issue.code === 'unrecognized_keys'
    ? 'A section holds only label, node_ids and text. Below-node captions go in the top-level notes array as {node_id, caption} objects, never inside a section.'
    : undefined,
}).strict();

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
  return { model, patchSections };
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
  name: z.string().max(PRESENT_RESULT_NAME_MAX, overLength(PRESENT_RESULT_NAME_MAX)).trim().min(1, 'name is required').describe('Short name for the generated lineage view — aim for ~60 chars.'),
  summary: z.string().trim().min(1, 'summary is required — one-line graph purpose (~120 chars)').describe('One-line summary shown with the generated view.'),
  title: z.string().max(PRESENT_RESULT_TITLE_MAX, overLength(PRESENT_RESULT_TITLE_MAX)).optional().describe('Optional report heading.'),
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
 * @param sectionTextLeaves - Held section indexes and text leaves that alone may be replaced.
 * @returns The schema this stage offers the model.
 */
export function presentResultSchemaForPhase(
  phase?: string,
  repairFields: readonly PresentResultRepairField[] | null = null,
  retainable = false,
  previewBlockCount = 0,
  highlightLabelIndexes?: readonly number[],
  sectionTextLeaves?: readonly { readonly index: number; readonly fields: readonly ('label' | 'text')[] }[],
): z.ZodType {
  if (repairFields) return presentResultRepairPatchSchemaForFields(repairFields, phase, previewBlockCount, highlightLabelIndexes, sectionTextLeaves, retainable);
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
 * @param sectionTextLeaves - Section entries restricted to indexed `label`/`text` leaf repair.
 * @param retainable - Whether a committed report exists whose sections an omitted `sections` keeps.
 * @returns A strict schema owing the authorized fields and accepting every other presentation field.
 */
export function presentResultRepairPatchSchemaForFields(
  fields: readonly PresentResultRepairField[],
  phase?: string,
  previewBlockCount = 0,
  highlightLabelIndexes?: readonly number[],
  sectionTextLeaves?: readonly { readonly index: number; readonly fields: readonly ('label' | 'text')[] }[],
  retainable = false,
): z.ZodType<z.infer<typeof PresentResultAuthorizableRepairSchema>> {
  const keys = [...new Set<PresentResultRepairField>(fields)].sort();
  const preview = phase === 'visual_preview';
  const labelIndexes = highlightLabelIndexes ? [...new Set(highlightLabelIndexes)].sort((left, right) => left - right) : undefined;
  const sectionLeaves = sectionTextLeaves?.map(leaf => ({ index: leaf.index, fields: [...new Set(leaf.fields)].sort() }))
    .sort((left, right) => left.index - right.index);
  const cacheKey = `${preview ? `preview${previewBlockCount}:` : ''}${retainable ? 'retain:' : ''}${keys.join(',')}${labelIndexes ? `:labels=${labelIndexes.join(',')}` : ''}${sectionLeaves ? `:sectionText=${sectionLeaves.map(leaf => `${leaf.index}.${leaf.fields.join('+')}`).join(',')}` : ''}`;
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
  if (labelIndexes) {
    const entrySchemas = labelIndexes.map(index => z.object({
      index: z.literal(index).describe('Zero-based index of the held highlight group named by the rejection.'),
      label: HighlightGroupSchema.shape.label.describe('Replacement containing only this held group\'s short shared role or status, ending before any dash, colon, example or member list.'),
    }).strict());
    const entrySchema = entrySchemas.length === 1
      ? entrySchemas[0]!
      : z.union(entrySchemas as [typeof entrySchemas[number], typeof entrySchemas[number], ...Array<typeof entrySchemas[number]>]);
    staged = staged.extend({
      highlight_groups: z.array(entrySchema).length(labelIndexes.length).superRefine((entries, ctx) => {
        const seen = new Set<number>();
        for (const [entryIndex, entry] of entries.entries()) {
          if (seen.has(entry.index)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: [entryIndex, 'index'], message: `Highlight label index ${entry.index} is duplicated. Send each index once.` });
          }
          seen.add(entry.index);
        }
      }).describe(`Correct only the held overlong highlight labels at zero-based indexes ${labelIndexes.join(', ')}. Send one {index, label} entry per listed index; colors, node_ids, other labels and group order remain held.`),
    });
  }
  if (sectionLeaves) {
    const entrySchemas = sectionLeaves.map(leaf => z.object({
      index: z.literal(leaf.index).describe('Zero-based index of the held section named by the rejection.'),
      ...(leaf.fields.includes('label') ? {
        label: PresentResultSectionSchema.shape.label.describe('Corrected held section label; unique after trimming, whitespace collapse and lowercasing.'),
      } : {}),
      ...(leaf.fields.includes('text') ? {
        text: PresentResultSectionSchema.shape.text.describe('Corrected held section body.'),
      } : {}),
    }).strict());
    const entrySchema = entrySchemas.length === 1
      ? entrySchemas[0]!
      : z.union(entrySchemas as [typeof entrySchemas[number], typeof entrySchemas[number], ...Array<typeof entrySchemas[number]>]);
    staged = staged.extend({
      sections: z.array(entrySchema).length(sectionLeaves.length).superRefine((entries, ctx) => {
        const seen = new Set<number>();
        for (const [entryIndex, entry] of entries.entries()) {
          if (seen.has(entry.index)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [entryIndex, 'index'], message: `Section text index ${entry.index} is duplicated. Send each index once.` });
          seen.add(entry.index);
        }
      }).describe(`Correct only rejected text leaves on held sections: ${sectionLeaves.map(leaf => `${leaf.index} (${leaf.fields.join(' + ')})`).join(', ')}. Node links, other text and order remain held.`),
    });
  }
  const declared = labelIndexes || sectionLeaves
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
 * The participant tool catalog retains the union of the BB and CT contracts (verdict
 * `analyze | passthrough`, `prune_neighbors`, `questions` and `column_flow`).
 * Instruction-plan compilation advertises the strict mode-and-classification-locked
 * schema (`submitFindingsSchemaForMode`) immediately before model dispatch, and the handler validates
 * the payload against that same contract, verdict shape included. This is the model-facing
 * source used by `TOOL_DEFS`; the tool is dispatched internally and is not registered with VS Code.
 */
export const SubmitFindingsModelSchema = z.object({
  focus_node_id: z.string().describe('`focus_node.id` from `<hop_context>`.'),
  verdict: HopVerdictSchema,
  summary: z.string().optional().describe(SUMMARY_DESCRIPTION),
  prune_neighbors: z.array(PruneNeighborSchema).max(MAX_ID_LIST_LENGTH).optional().describe(PRUNE_NEIGHBORS_DESCRIPTION),
  questions: z.array(CtNeighborQuestionSchema).max(MAX_ID_LIST_LENGTH).optional().describe(QUESTIONS_DESCRIPTION),
  column_flow: ColumnFlowSchema.optional(),
  badge_label: advertisedMax(z.string(), { maxLength: SUBMIT_FINDINGS_BADGE_LABEL_MAX }).min(1)
    .refine(value => value.trim().length > 0, 'badge_label must contain non-whitespace text')
    .optional()
    .describe(BADGE_LABEL_DESCRIPTION),
  reason: z.string().optional().describe(IGNORED_REASON_DESCRIPTION),
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
