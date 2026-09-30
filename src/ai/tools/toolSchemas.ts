/**
 * Zod input schemas and lightweight runtime validation for the AI tools.
 * Zero VS Code imports — pure schema definitions.
 */
import { z } from 'zod';
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
import type { HopFinding, HopFindingKept } from '../sm/smTypes';

/**
 * A column identifier the user actually named. Wildcards are rejected at the boundary: a
 * wildcard target column locks an unwinnable CT session because no real column can match it.
 */
export const ColumnIdentifierSchema = z.string().trim().min(1).regex(/^[^*%?]+$/, 'wildcards are not column identifiers').describe(
  'A field of a table or view that the user named verbatim; a column trace starts only when at least one such column is named. When the user named no specific column, supply none; wildcards are rejected at the boundary.',
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
  'Starting scope: upstream levels reach the sources, downstream levels reach the consumers that read the origin. levels is a non-negative integer or "all"; 0 permanently closes that side for the session. exactness is "exact" when the user literally stated that level count, "approximate" when it is your own estimate — an approximate side does not bound the scope, which runs until the filters or the border stop it. Required for a fresh proposal; omit on a refine to keep the reviewed depth.';

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
  excludeTypes: z.array(z.string()).optional().describe('Object types excluded from the approved scope. Omit to keep the current list (on a fresh proposal, the types the GUI filter hides); a sent list replaces it.'),
  /**
   * Schemas to drop from the BFS scope (case-insensitive). Honored at scope-build time —
   * any candidate node whose schema matches is excluded. REPLACE semantics: each call
   * wipes prior filter state on the engine; accumulate across refine rounds by re-sending
   * every prior exclusion plus the new one.
   */
  excludeSchemas: z.array(z.string()).optional().describe('Schema names excluded from the approved scope. Omit to keep the current list (on a fresh proposal, the schemas the GUI filter hides); a sent list replaces it, so repeat those you keep.'),
  /**
   * Specific node ids to drop from the BFS scope (case-insensitive). Cuts the node and
   * its subtree reachable only through it. Use only when the user explicitly says
   * remove / drop / prune / cut. REPLACE semantics — see {@link excludeSchemas}.
   * Every id must already be resolved via `lineage_search_objects` — unknown ids cause
   * the call to reject with `unknown_node_ids`.
   */
  excludeNodeIds: z.array(z.string()).optional().describe('Resolved object IDs to remove, including dependent branches reachable only through them. Omit to keep the current list (on a fresh proposal, the objects the GUI filter excludes); a sent list replaces it.'),
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
      message: 'Fresh origin and completed-session supplement are mutually exclusive.',
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
const StartExcludeTypesSchema = z.array(z.string()).optional().describe('Object types the user explicitly excluded from the approved scope.');
const StartExcludeSchemasSchema = z.array(z.string()).optional().describe('Complete replacement list of schema names excluded from the approved scope.');
const StartExcludeNodeIdsSchema = z.array(z.string()).optional().describe('Resolved object IDs to remove, including dependent branches reachable only through them.');
const StartPassNodeIdsSchema = z.array(z.string()).optional().describe('Resolved object IDs to keep as topology-only passthrough nodes without analyzing them.');
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
 * `technical`). This base shape backs the permissive registered union
 * ({@link SubmitFindingsModelSchema}) and stays angle-open; the strict per-dispatch schema
 * (`submitFindingsSchemaForMode`) narrows the object to the locked classification's kept
 * angle key(s) before every active-hop dispatch, so an off-lock angle fails there as an
 * unrecognized key and the model re-submits with its content folded into a kept key.
 * `interaction/rules/submitFindingsRules.validateSectionsAgainstClassification` still checks,
 * after that, that every kept angle the lock requires is actually present.
 */
const CapturedSectionsSchema = z.object({
  /** Pre-formatted section body written per `business_capture`. */
  business: z.string().min(1).optional(),
  /** Pre-formatted section body written per `technical_capture`. */
  technical: z.string().min(1).optional(),
}).strict();

/** Model-facing output of {@link CapturedSectionsSchema}: at most one string per angle. */
type CapturedSectionsWire = z.infer<typeof CapturedSectionsSchema>;

/**
 * Applicability prefix for the fields only a kept verdict carries (`sections`, `badge_label`,
 * `prune_neighbors`), so each field states in its own describe that an `end_branch` submit omits it.
 */
const KEPT_VERDICT_ONLY = 'Only with analyze or passthrough: ';

/** Requirement prefix for `summary` and `sections`, which a kept verdict must carry. */
const KEPT_VERDICT_REQUIRED = 'Required with analyze or passthrough';

/**
 * Single source for the `prune_neighbors` field describe text, shared by the strict per-mode
 * schemas and the permissive registered union so the two cannot drift.
 */
export const PRUNE_NEIGHBORS_DESCRIPTION =
  KEPT_VERDICT_ONLY + 'removes a neighbor you have not visited, and whatever only it leads to, based on this node\'s SQL alone; '
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

/** Single source for the `reason` describe text of an `end_branch` submit, in BB and CT. */
const END_BRANCH_REASON_DESCRIPTION =
  'Required with end_branch; empty string with a kept verdict. Why '
  + END_BRANCH_ROW_DECISION_CONDITION;

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
 * `submit_findings` schemas and the permissive registered union so the two never restate the
 * same fact with different wording. The soft target (a 2-4 word label) lives here and nowhere
 * else: `badge_label` is a per-hop tool field, not template-governed content.
 */
export const BADGE_LABEL_DESCRIPTION = KEPT_VERDICT_ONLY + '2-4 word label for this node.';

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
}).meta({ additionalProperties: false });

/**
 * One `column_flow` entry. Served closed (`additionalProperties: false`); a surplus key the model
 * still sends is stripped by Zod's default object parse and logged by the model port.
 */
const OUT_COL_DESCRIPTION = 'A column from the `<column_trace>` Active columns list, as named on this node; for a procedure, the column it writes.';

const ColumnFlowEntrySchema = z.object({
  out_col: z.string().describe(OUT_COL_DESCRIPTION),
  writes_to: ColumnFlowWritesToObject.nullish().describe('Procedure focus: the written target as an object {"node": table id, "col": column name}; null when none.'),
  upstream_columns: z.array(ColumnRefSchema).describe(
    'Two states by focus: at a bodied focus, the real upstream columns the node READS that contribute to out_col ' +
    '(never columns it computes or writes out); at a focus with no body of its own, continuation — name the neighbours ' +
    'on this focus\'s carrier side (the nodes that write it on an upstream trace, the nodes that read it on a downstream ' +
    'trace), carrying the tracked column unchanged; use [] only when out_col terminates here.',
  ),
}).meta({ additionalProperties: false });


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

const COLUMN_FLOW_DESCRIPTION = 'One entry per tracked column this node carries; [] when it carries none, and always [] with verdict end_branch. `upstream_columns` names what each neighbor carries.';

const ColumnFlowSchema = z.array(ColumnFlowEntrySchema).describe(COLUMN_FLOW_DESCRIPTION);

/** Single source for the `sections` describe text, shared by the per-mode schemas and the registered union. */
const SECTIONS_DESCRIPTION = KEPT_VERDICT_REQUIRED + ', {} with end_branch. Pre-formatted section body per fired capture recipe, keyed by angle: `{business, technical}`; a locked classification keeps only its angle key(s).';

/** Single source for the `summary` describe text, shared by the per-mode schemas and the registered union. */
const SUMMARY_DESCRIPTION =
  'One sentence, readable without this hop: what this node does to the data and what it hands to which node. Empty string with end_branch.';

/**
 * Shared `submit_findings` fields across BB and CT modes, one flat object.
 *
 * @remarks
 * Flat by design: a top-level `anyOf` defeats constrained decoding, so the verdict-dependent shape
 * (a kept verdict carries sections and summary and ignores `reason`, `end_branch` requires `reason` and ignores summary, sections and badge_label) is stated in
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
  reason: z.string().optional().describe(END_BRANCH_REASON_DESCRIPTION),
  /**
   * One string per fired `*_capture` template, keyed by angle. One key (`business` /
   * `technical` classification) or two (`both`) — required with a kept verdict. Declared last:
   * a model emits arguments in schema order, so the long prose closes the object after every
   * short field.
   */
  sections: CapturedSectionsSchema.optional().describe(SECTIONS_DESCRIPTION),
}).strict();

const { sections, summary, badge_label, prune_neighbors, questions, reason } = HopFindingBaseSchema.shape;

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
    questions,
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

/** Fields that act on a kept verdict and are therefore refused with `end_branch` — `column_flow` has its own check, since CT serves it always-present. */
const END_BRANCH_EXCLUDED_FIELDS = ['prune_neighbors', 'questions'] as const;

/**
 * Enforces the verdict-dependent shape of one flat `submit_findings` payload.
 *
 * @remarks
 * `end_branch` requires `reason` and refuses the fields that act on a kept verdict; `summary`,
 * `sections` and `badge_label` are accepted and dropped by {@link toHopFinding}. A kept verdict carries `sections`
 * and `summary` (and, in CT, `column_flow`); a `reason` sent with it is accepted and dropped by
 * {@link toHopFinding}, as `summary` and `sections` are on `end_branch`. `summary` may be empty only when a held draft
 * exists (`fresh` unset), and the engine keeps the held summary. A fresh kept verdict under a `both`
 * lock that sends a non-empty `sections` names each missing angle in the same parse as any shape
 * fault; `end_branch` sections are inert and never checked. Each fault is one
 * issue on its own path, so the rejection names the exact field to drop or add. `column_flow` is
 * served-required in CT (always in the served `required` list, never omissible at the schema level)
 * so its own content check runs for every verdict rather than joining
 * {@link END_BRANCH_EXCLUDED_FIELDS}'s omission-only check.
 */
function refineSubmitFindingsShape(value: FlatSubmitFindings, ctx: z.RefinementCtx, mode: 'bb' | 'ct', fresh: boolean, bothAnglesRequired = false): void {
  if (typeof value !== 'object' || value === null) return;
  const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
  if (value.verdict === 'end_branch') {
    for (const field of END_BRANCH_EXCLUDED_FIELDS) {
      if (value[field] == null) continue;
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: 'not accepted with verdict end_branch; verdict analyze or passthrough keeps the node.',
        params: { hint: `Omit ${field}.` },
      });
    }
    if (mode === 'ct' && (Array.isArray(value.column_flow) ? value.column_flow.length : 0) > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['column_flow'],
        message: 'not accepted with verdict end_branch; verdict analyze or passthrough keeps the node.',
        params: { hint: 'Send column_flow: [].' },
      });
    }
    if (!reason) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'required with verdict end_branch.',
        params: { hint: 'Send reason: one sentence on why nothing on the answer path runs through this node.' },
      });
    }
    return;
  }
  const sectionsEmpty = value.sections === undefined
    || (typeof value.sections === 'object' && value.sections !== null && Object.keys(value.sections).length === 0);
  if (fresh && sectionsEmpty) {
    ctx.addIssue({
      code: 'custom',
      path: ['sections'],
      message: `required with verdict ${value.verdict}; empty only with end_branch.`,
      params: { hint: 'Send sections: the section body keyed by angle.' },
    });
  }
  if (bothAnglesRequired && typeof value.sections === 'object' && value.sections !== null && Object.keys(value.sections).length > 0) {
    for (const angle of CLASSIFICATION_KEPT_ANGLES.both) {
      if ((value.sections as Record<string, unknown>)[angle] !== undefined) continue;
      ctx.addIssue({ code: 'custom', path: ['sections', angle], message: 'required with a both classification when sections is not empty.', params: { hint: `Send sections.${angle}.` } });
    }
  }
  if (fresh && (value.summary === undefined || (typeof value.summary === 'string' && value.summary.trim() === ''))) {
    ctx.addIssue({
      code: 'custom',
      path: ['summary'],
      message: `required with verdict ${value.verdict}; empty only with end_branch.`,
      params: { hint: 'Send summary: one sentence on what this node does to the data and hands on.' },
    });
  }
}

/**
 * Converts a validated flat `submit_findings` payload to the {@link HopFinding} union the engine
 * consumes.
 *
 * @remarks
 * Called exactly once, by `executeSubmitFindings`, on the payload the tool-attempt boundary already
 * parsed against the served {@link submitFindingsSchemaForMode} schema — never inside the schema
 * itself, so the schema's output type stays equal to its input type. The boundary decides
 * `valid`/`invalid`; only the handler converts.
 *
 * @param value - A payload {@link refineSubmitFindingsShape} accepted.
 * @returns The `end_branch` or kept variant, carrying exactly that variant's fields.
 */
export function toHopFinding(value: FlatSubmitFindings): HopFinding {
  if (value.verdict === 'end_branch') {
    return { focus_node_id: value.focus_node_id, verdict: 'end_branch', reason: value.reason ?? '' };
  }
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
  mode: 'bb' | 'ct',
  fresh: boolean,
  classification?: ClassificationValue,
): z.ZodType<FlatSubmitFindings> {
  const bothAnglesRequired = fresh && classification !== undefined
    && CLASSIFICATION_KEPT_ANGLES[classification].length === CLASSIFICATION_KEPT_ANGLES.both.length;
  return schema
    .check(superRefineAll((value, ctx) => refineSubmitFindingsShape(value as FlatSubmitFindings, ctx, mode, fresh, bothAnglesRequired))) as z.ZodType<FlatSubmitFindings>;
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
export const SubmitFindingsBbInputSchema = finalizeSubmitFindingsSchema(HopFindingBaseSchema, 'bb', true);

/**
 * CT-mode submit_findings input.
 *
 * @remarks
 * CT is BB plus column tracking, so every BB field is present on the CT form; `column_flow`'s own
 * contract is documented on {@link ColumnFlowSchema}, and its `upstream_columns` are the carry each
 * enqueued neighbour receives.
 */
export const SubmitFindingsCtInputSchema = finalizeSubmitFindingsSchema(HopFindingCtBaseSchema, 'ct', true);

/** Memoized per (mode, classification) narrowed `submit_findings` schemas built by {@link submitFindingsSchemaForMode}. */
const submitFindingsSchemaCache = new Map<string, z.ZodType<FlatSubmitFindings>>();

/**
 * Narrows {@link CapturedSectionsSchema} to the angle key(s) a locked classification keeps
 * ({@link CLASSIFICATION_KEPT_ANGLES}).
 *
 * @remarks
 * One kept angle drops the other key. Sending it raises a custom issue whose hint says to fold
 * that key's content into the kept angle. The fold guidance also lives on the kept key's
 * description, where the model reads it before authoring.
 * `both` keeps both angles, each key optional so `{}` stays valid with `end_branch`; a fresh
 * submission additionally serves both keys in the JSON Schema `required` list (the validator stays
 * lenient, so an `end_branch` sending `{}` is never refused), and a retry with a held draft names
 * only the angle it changes. {@link refineSubmitFindingsShape} refuses `{}` on a
 * kept verdict of a fresh submission, and {@link validateSectionsAgainstClassification} requires
 * both angles of a kept verdict at the handler, after held and archived angles are counted;
 * {@link refineSubmitFindingsShape} names a missing angle of a fresh kept verdict in the same parse
 * as a shape fault and never checks `end_branch` sections. The parent
 * field is served optional and non-nullable: {@link refineSubmitFindingsShape} accepts an `end_branch`
 * whether `sections` is omitted, `{}` or present, and requires it on a fresh kept verdict;
 * {@link toHopFinding} drops it.
 *
 * @param classification - The locked classification this dispatch's schema narrows to.
 * @param freshSubmission - No held draft and no archived angle: the `both` keys carry no held-body wording.
 * @returns The sections object for that classification. A one-angle lock carries only that key;
 * `both` carries both keys, optional.
 */
function capturedSectionSchemaForClassification(
  classification: ClassificationValue,
  freshSubmission: boolean,
): z.ZodType<CapturedSectionsWire> {
  const kept = CLASSIFICATION_KEPT_ANGLES[classification];
  if (kept.length === CLASSIFICATION_KEPT_ANGLES.both.length) {
    const plainBody = z.string().min(1).optional();
    if (freshSubmission) {
      return z.strictObject({ business: plainBody, technical: plainBody }).meta({ required: [...CLASSIFICATION_KEPT_ANGLES.both] });
    }
    const heldBody = plainBody.describe('Send only an angle you change; an angle left out keeps its held body.');
    return z.strictObject({ business: heldBody, technical: heldBody });
  }
  const [onlyAngle] = kept;
  const offAngle = onlyAngle === 'business' ? 'technical' : 'business';
  const body = z.string().min(1).optional().describe(
    `The only angle classification=${classification} keeps; fold any ${offAngle} content into this key — a separate "${offAngle}" key is rejected.`,
  );
  return z.looseObject({ [onlyAngle]: body })
    .superRefine((value, ctx) => {
      const surplus = Object.keys(value).filter((key) => key !== onlyAngle);
      if (surplus.includes(offAngle)) {
        ctx.addIssue({
          code: 'custom',
          message: `"${offAngle}" is not kept under classification=${classification}`,
          params: { hint: `Fold the ${offAngle} content into "${onlyAngle}" and drop the "${offAngle}" key.` },
        });
      }
      const unknown = surplus.filter((key) => key !== offAngle);
      if (unknown.length > 0) ctx.addIssue({ code: 'unrecognized_keys', keys: unknown, message: 'Unrecognized keys' });
    })
    .meta({ additionalProperties: false }) as unknown as z.ZodType<CapturedSectionsWire>;
}

/**
 * The per-hop column facts that narrow the served CT `column_flow` entry.
 *
 * @remarks
 * `outCols` is the hop's active tracked columns when the validator accepts nothing else as
 * `out_col` (an upstream trace), `null` when it accepts any focus column. `writesTo` is true only
 * for a procedure focus, the one node that writes a column elsewhere.
 */
export interface SubmitFindingsHopColumns {
  readonly outCols: readonly string[] | null;
  readonly writesTo: boolean;
}

/** Projects {@link ColumnFlowSchema} onto one hop: `out_col` as the hop's tracked-column enum, `writes_to` only for a procedure focus. */
function columnFlowSchemaForHop(hop: SubmitFindingsHopColumns) {
  const [first, ...rest] = hop.outCols ?? [];
  const outCol = first === undefined
    ? ColumnFlowEntrySchema.shape.out_col
    : z.enum([first, ...rest]).describe(OUT_COL_DESCRIPTION);
  const shape = { ...ColumnFlowEntrySchema.shape, out_col: outCol };
  const entry = (hop.writesTo
    ? z.object(shape)
    : z.object({ out_col: shape.out_col, upstream_columns: shape.upstream_columns })
  ).meta({ additionalProperties: false });
  return z.array(entry).describe(COLUMN_FLOW_DESCRIPTION);
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
 * with a held draft names only the angle it changes; `sections: {}` is the `end_branch`
 * shape {@link refineSubmitFindingsShape} exempts. The host path uses this at the last seam
 * before the model sees the tool set so the model cannot fill a field or angle invalid for the
 * locked mode/classification — the contract is the form's shape, not prompt prose. The static
 * catalog and `package.json` manifest keep the permissive union (drift guard + single-tool Copilot
 * lane unaffected).
 *
 * @param mode - Locked active analysis mode used for provider projection.
 * @param classification - Locked output classification; omitted callers get the mode-only schema.
 * @param freshSubmission - Refuse `{}` sections and an empty `summary` on a kept verdict; unset
 * so a held draft or an archived angle still validates.
 * @param hop - CT only: the active hop's column facts; narrows `column_flow[].out_col` and offers
 * `writes_to` for a procedure focus alone.
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
  const hopKey = mode === 'ct' && hop ? `${hop.writesTo}:${JSON.stringify(hop.outCols)}` : '';
  if (!classification && !hopKey) {
    return mode === 'ct' ? SubmitFindingsCtInputSchema : SubmitFindingsBbInputSchema;
  }
  const cacheKey = `${mode}:${classification ?? ''}:${freshSubmission}:${hopKey}`;
  const cached = submitFindingsSchemaCache.get(cacheKey);
  if (cached) return cached;
  let narrowed = (mode === 'ct' ? HopFindingCtBaseSchema : HopFindingBaseSchema) as typeof HopFindingCtBaseSchema;
  if (hopKey && hop) narrowed = narrowed.extend({ column_flow: columnFlowSchemaForHop(hop) }).strict() as typeof HopFindingCtBaseSchema;
  if (classification) {
    const kept = CLASSIFICATION_KEPT_ANGLES[classification];
    const sectionsDescribe = kept.length === CLASSIFICATION_KEPT_ANGLES.both.length
      ? KEPT_VERDICT_REQUIRED + (freshSubmission ? ', omitted with end_branch' : ', {} with end_branch') + '. Pre-formatted section body for the `business` and `technical` recipes, under keys `business` and `technical`.'
      : `${KEPT_VERDICT_REQUIRED}, {} with end_branch. Pre-formatted section body for the \`${kept[0]}\` recipe, under key \`${kept[0]}\`.`;
    const narrowedSections = capturedSectionSchemaForClassification(classification, freshSubmission)
      .optional()
      .describe(sectionsDescribe);
    narrowed = narrowed.extend({ sections: narrowedSections }).strict() as typeof HopFindingCtBaseSchema;
  }
  const schema = finalizeSubmitFindingsSchema(narrowed, mode, freshSubmission, classification);
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
/** Max color groups on one rendered result — a small cap keeps the graph legend scannable. */
export const PRESENT_RESULT_HIGHLIGHT_GROUPS_MAX = 5;
const HIGHLIGHT_GROUPS_OVER_MAX = `highlight_groups exceeds maximum of ${PRESENT_RESULT_HIGHLIGHT_GROUPS_MAX}`;

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
  label: z.string().max(PRESENT_RESULT_HIGHLIGHT_LABEL_MAX, overLength(PRESENT_RESULT_HIGHLIGHT_LABEL_MAX)).trim().min(1, 'Group label is required').describe('Short legend label describing the shared graph role or status; length target: see the `highlights` output template.'),
  color: HighlightSchemeSchema.describe('Flow role or status. `source`: the deepest origins whose data feeds the answer. `target`: where the data lands — the queried object in an upstream trace. `transform`: nodes that create or change the answer\'s values. `good` / `warn` / `fail`: diagnostic status. One scheme per result.'),
  node_ids: z.array(NodeIdSchema).describe('Node IDs that share this graph role or status.'),
}).strict();

/**
 * One final report section: a label that becomes both the section heading and the graph badge, the
 * nodes it explains, and its detail body.
 */
const PresentResultSectionSchema = z.object({
  label: z.string().max(PRESENT_RESULT_SECTION_LABEL_MAX, overLength(PRESENT_RESULT_SECTION_LABEL_MAX)).trim().min(1, 'Section label is required — provide a short final label for this detail section').describe('Short heading naming the section\'s role, unique in the report; also the badge on every linked node.'),
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
const PresentResultSectionPatchSchema = PresentResultSectionSchema.extend({
  node_ids: z.array(NodeIdSchema).optional().describe('Nodes this section documents; put each node in one section. Omit to keep the held links under this label; an empty array unlinks them.'),
  text: z.string().trim().min(1, 'Section is missing text — every final section label requires one detail body').optional().describe('Detail body. Omit to keep the held text under this label; supply it to rewrite that section, and always for a label not on file.'),
  remove: z.literal(true).optional().describe('true drops the held section under this label; send only the label with it.'),
});

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
  const patch = section.extend({
    node_ids: z.array(NodeIdSchema).optional().describe('Nodes this section documents; put each node in one section. Omit to keep the held links under this label; an empty array unlinks them.'),
    start: start.optional(),
    remove: z.literal(true).optional().describe('true drops the held section under this label; send only the label with it.'),
  });
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
  highlight_groups: z.array(HighlightGroupSchema).min(1).max(PRESENT_RESULT_HIGHLIGHT_GROUPS_MAX, HIGHLIGHT_GROUPS_OVER_MAX).describe(
    'REQUIRED for new renders, 1-5 groups. For zero-trace or single-node results, use color "target" on the origin/result node.'
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
 * @returns The schema this stage offers the model.
 */
export function presentResultSchemaForPhase(
  phase?: string,
  repairFields: readonly PresentResultRepairField[] | null = null,
  retainable = false,
  previewBlockCount = 0,
): z.ZodType {
  if (repairFields) return presentResultRepairPatchSchemaForFields(repairFields, phase, previewBlockCount);
  if (phase === 'visual_preview') return previewSchemas(previewBlockCount).model;
  const synthesis = phase === 'synthesis';
  const schema = retainable
    ? (synthesis ? PresentResultRetainingSynthesisModelSchema : PresentResultRetainingModelSchema)
    : (synthesis ? PresentResultSynthesisModelSchema : PresentResultModelSchema);
  return schema;
}

/** The one statement of how a resent `sections` list merges into the held draft. */
const REPAIR_SECTIONS_DESCRIPTION = 'Sections to add or change, each under its held label; a held section this list does not name is kept as authored; {label, remove: true} drops one.';

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
  sections: sectionList(PresentResultSectionPatchSchema).optional().describe(REPAIR_SECTIONS_DESCRIPTION),
  is_update: z.boolean().optional().describe('Optional — a repair keeps the held draft\'s own value; the value sent here is not applied.'),
}).strict();

/**
 * The repair patch plus the graph-edit fields, which only a rejection of that same edit may authorize.
 *
 * @remarks
 * A held draft that fails on `add_node_ids`/`prune_node_ids` is otherwise unrepairable: the patch
 * cannot edit them, so the model has no call that corrects the field the rejection names. No other
 * rejection authorizes them, so a repair of any other field still cannot change graph structure.
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
export const PRESENT_RESULT_GRAPH_EDIT_FIELDS = ['prune_node_ids', 'add_node_ids'] as const;

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
  phase?: string,
  previewBlockCount = 0,
): z.ZodType<z.infer<typeof PresentResultAuthorizableRepairSchema>> {
  const keys = [...new Set<PresentResultRepairField>(fields)].sort();
  const preview = phase === 'visual_preview';
  const cacheKey = `${preview ? `preview${previewBlockCount}:` : ''}${keys.join(',')}`;
  const cached = repairPatchSchemaCache.get(cacheKey);
  if (cached) return cached as z.ZodType<z.infer<typeof PresentResultAuthorizableRepairSchema>>;
  const mask = Object.fromEntries([...keys, 'is_update'].map(key => [key, true]));
  const picked = PresentResultAuthorizableRepairSchema.pick(
    mask as Partial<Record<keyof typeof PresentResultAuthorizableRepairSchema.shape, true>>,
  );
  const staged = preview && keys.includes('sections')
    ? picked.extend({ sections: previewSchemas(previewBlockCount).patchSections })
    : picked;
  const strict = staged.strict().superRefine((data, ctx) => {
    if (keys.length === 0) return;
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
export const PresentResultSynthesisModelSchema = PresentResultModelSchema.omit({
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
  summary: z.string().optional().describe(SUMMARY_DESCRIPTION),
  prune_neighbors: z.array(PruneNeighborSchema).max(MAX_ID_LIST_LENGTH).optional().describe(PRUNE_NEIGHBORS_DESCRIPTION),
  questions: z.array(NeighborQuestionSchema).max(MAX_ID_LIST_LENGTH).optional().describe(QUESTIONS_DESCRIPTION),
  column_flow: ColumnFlowSchema.optional(),
  badge_label: advertisedMax(z.string(), { maxLength: SUBMIT_FINDINGS_BADGE_LABEL_MAX }).min(1)
    .refine(value => value.trim().length > 0, 'badge_label must contain non-whitespace text')
    .optional()
    .describe(BADGE_LABEL_DESCRIPTION),
  reason: z.string().optional().describe(END_BRANCH_REASON_DESCRIPTION),
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
