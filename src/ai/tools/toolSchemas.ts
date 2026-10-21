/** Zod input schemas and lightweight runtime validation for the AI tools. Zero VS Code imports — pure schema definitions. */
import { z } from 'zod';
import { resolveModelNodeId } from '../support/modelReferences';
import { markIdFormSearch, markObjectIdField } from './normalizeModelInput';
import { normalizeColName } from '../../utils/sql';
import { MAX_ID_LIST_LENGTH, SCREEN_STATE_MAX_IDS, ColumnTransformClassSchema, DIRECT_TRANSFORM_CLASSES } from '../../engine/shared/bridgeContract';
import {
  ExplorationDepthLimitSchema,
  ExplorationDepthSelectionSchema,
} from '../../engine/shared/explorationDepthContract';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { rejectionFromZodError, type ToolRejection } from '../support/toolErrorEnvelope';
import { CLASSIFICATION_KEPT_ANGLES, type ClassificationValue } from '../session/classification';
import { extractRawSectionAngles } from '../interaction/rules/submitFindingsRules';
import type { IndexedRepairFields } from '../support/repairDraftStore';
import type { ColumnFlowEntry, HopFinding, HopFindingKept, HopSubmission } from '../sm/smTypes';

/** A column identifier named by the user. Wildcards are rejected at the boundary: a wildcard target column locks an unwinnable CT session because no real column can match it. */
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
    'Answer lens selected from primary user intent. "business": domain meaning, purpose, impact, or business rules (default when ambiguous or unspecified). '
    + '"technical": execution mechanics, indexes, performance, query shapes, or loading patterns. "both": explicitly requested dual perspective. Required for fresh proposals.',
  );

const SupplementNodeIdsSchema = z.array(z.string().min(1)).min(1).max(MAX_ID_LIST_LENGTH).describe(
  'Resolved object IDs that require new per-node analysis in the completed exploration; use present_result add_node_ids for presentation-only additions.',
);
/** Chain extension of a supplement: the named objects plus everything reachable from them. */
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

/** Single source for the `depth` describe text on both {@link StartExplorationInputSchema} and every provider branch spread through `StartPatchFields` — one canonical home instead of a second literal duplicating it. Required for a fresh proposal, like {@link ClassificationValueSchema}; a refine may omit it to keep the reviewed proposal's depth. The per-side `0` clause matches {@link ExplorationDepthSelectionSchema}'s own contract (`explorationDepthContract.ts`) and `isReachableInApprovedDirection` (`smBase.ts`): 0 is a permanent border for the rest of the session, not merely a one-time skip of the initial seed. */
const DEPTH_DESCRIPTION =
  'Starting scope: {upstream, downstream}, each {levels, exactness}; upstream levels reach the sources, downstream levels reach the consumers that read the origin. levels is a non-negative integer or "all"; 0 permanently closes that side for the session. levels "all", exact, only when the user asks for the complete chain on that side; a count the user states is that count, exact ("direct" is 1); with neither, levels 3, approximate. exactness is "exact" for a user-specified bound; use "approximate" when the count is your own estimate — an approximate count above 0 does not bound the scope, which runs until the filters or the border stop it. Required for a fresh proposal; omit on a refine to keep the reviewed depth.';

const StartDepthSchema = ExplorationDepthSelectionSchema.nullish().describe(DEPTH_DESCRIPTION);

const ANALYSIS_MODE_DESCRIPTION =
  'Required for fresh exploration: "bb" traces whole objects; "ct" traces named columns. Default to "bb" when unclear.';

/** Issue text when a start_exploration call carries neither an origin nor a supplement. */
const START_SHAPE_REQUIRED_MESSAGE = "Either 'origin' (fresh proposal) or 'supplement' with nodeIds must be provided.";

/** Recovery when column trace is requested without named columns. The schema issue and the rejection hint are this one string. */
export const CT_TARGET_COLUMNS_RECOVERY =
  'Name the columns to trace; for all columns, read them with lineage_get_object_detail and send each one. Then resubmit CT.';

/** `targetColumns` on every exploration phase: column trace names the columns; blackboard forbids the property. */
const TARGET_COLUMNS_PHASE_DESCRIPTION =
  'CT only: name each column to trace. When the user asked for every column, read them with lineage_get_object_detail and send each one. BB forbids this property.';

const StartExcludeTypesSchema = z.array(z.string()).optional().describe('Object types excluded from the approved scope. Omit to keep the current list (on a fresh proposal, the types the GUI filter hides); a sent list replaces it.');
const StartExcludeSchemasSchema = z.array(z.string()).optional().describe('Schema names excluded from the approved scope. Omit to keep the current list (on a fresh proposal, the schemas the GUI filter hides); a sent list replaces it, so repeat those you keep.');
const StartExcludeNodeIdsSchema = z.array(z.string()).optional().describe('Resolved object IDs to remove, including dependent branches reachable only through them. Omit to keep the current list (on a fresh proposal, the objects the GUI filter excludes); a sent list replaces it.');
const StartPassNodeIdsSchema = z.array(z.string()).optional().describe('Resolved object IDs to keep as topology-only passthrough nodes without analyzing them; the mapping for objects the user said to ignore or skip. Omit to keep the current list; a sent list replaces it.');

/** Strict domain boundary for fresh, refine, and completed-session exploration requests. */
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
  /** Schemas to drop from the BFS scope under the source comparison policy. Honored at scope-build time — any candidate node whose schema matches is excluded. REPLACE semantics: each call wipes prior filter state on the engine; accumulate across refine rounds by re-sending every prior exclusion plus the new one. */
  excludeSchemas: StartExcludeSchemasSchema,
  /** Specific node ids to drop from the BFS scope under the source comparison policy. Cuts the node and its subtree reachable only through it. Use only when the user explicitly says remove / drop / prune / cut. REPLACE semantics — see {@link excludeSchemas}. Every id must already be resolved via `lineage_search_objects` — unknown ids cause the call to reject with `unknown_node_ids`. */
  excludeNodeIds: StartExcludeNodeIdsSchema,
  /** Specific node ids the engine keeps in scope but auto-passes (no analysis written, topology preserved so descendants stay reachable). Default interpretation when the user says ignore / skip / don't analyze. REPLACE semantics — see {@link excludeSchemas}. Every id must already be resolved via `lineage_search_objects` — unknown ids cause the call to reject with `unknown_node_ids`. */
  passNodeIds: StartPassNodeIdsSchema,
  scopeNotes: ScopeNotesValueSchema.optional(),
  mission_brief: MissionBriefValueSchema.optional(),
  classification: ClassificationValueSchema.optional(),
  /** Post-synthesis supplement: extend the existing archive with explicit nodes. Runs through the SM hop loop; slots merge into the existing `AiMemoryManager`. No `origin` needed — the existing exploration is the origin. Fails if no completed engine is attached to the session. */
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

/** Pending-proposal patch branch. Omitted fields are merged mechanically by the dispatcher, except an omitted `mission_brief`, which is kept only while origin, analysis mode, target columns and depth are unchanged; a scope change clears it. */
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

/** Fresh-entry model contract selected for `sm_entry` before the first approval gate. */
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

/** Completed-session (follow-up) model contract: one flat object admitting either an explicit supplement or a fresh re-proposal, never a top-level `anyOf`/`oneOf`. */
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

/** Canonical all-phase contract used by persistent VS Code/Copilot registration and manifest parity. API InstructionPlans replace it with exactly one phase-specific schema before each model call. */
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

/** Zod schema validating the parameters for the `get_scope_bundle` discovery tool. */
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

/** Model-facing projection of `lineage_get_scope_bundle` sent on every model call. */
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

/** Zod schema for `submit_findings.sections`, keyed by angle so the same angle cannot be sent twice. */
const CapturedSectionsSchema = z.object({
  /** Pre-formatted section body written per `business_capture`. */
  business: z.string().optional(),
  /** Pre-formatted section body written per `technical_capture`. */
  technical: z.string().optional(),
}).strict();

/** Model-facing output of {@link CapturedSectionsSchema}: at most one string per angle. */
type CapturedSectionsWire = z.infer<typeof CapturedSectionsSchema>;

/** Single source for the `prune_neighbors` field describe text, shared by the strict per-mode schemas and the permissive participant union so the two cannot drift. */
const PRUNE_NEIGHBORS_DESCRIPTION =
  'Optional. A neighbor is either mapped or questioned (kept) or pruned, never both. '
  + 'Name each `can_prune: true` neighbor that is off the value path (it gives only indirect lineage: filter, join, group by, sort, window or conditional). A neighbor whose value lands in an output column (identity, transformation or aggregation) is mapped.';

/** One `prune_neighbors[]` entry: the neighbour and why this node's SQL shows it is off the answer. */
const PruneNeighborSchema = z.object({
  id: z.string().min(1).describe('A neighbor id from `<hop_context>`.'),
  reason: z.string().min(1).describe('What in this node\'s SQL shows the neighbor is off the answer.'),
}).strict();

/** Single source for the `questions` field describe text, shared by the strict per-mode schemas and the permissive participant union. */
const QUESTIONS_DESCRIPTION =
  'Optional. Ask a kept neighbor what its own SQL must answer for the arriving columns: its rules, calculations and thresholds, not only which columns feed this object. Column continuation to mapped neighbors is automatic. '
  + 'A question to an out-of-scope neighbor becomes a follow-up offer. No questions to visited or pruned neighbors.';

/** One `questions[]` entry, attached to that neighbour's queued hop. */
const NeighborQuestionSchema = z.object({
  nodeId: z.string().min(1).describe('A neighbor id from `<hop_context>`.'),
  question: z.string().min(1).describe('The check, self-contained: name the neighbor and what to establish there.'),
}).strict();

const CtNeighborQuestionSchema = NeighborQuestionSchema.extend({
  caller_context: z.object({ node: z.string().min(1), col: z.string().min(1) }).strict().optional().describe('For a function investigation, declare the real current caller output whose contribution its supplied SQL must establish. The caller SQL is supplied at the function hop to bind actual arguments; this declaration creates no column edge or function column.'),
}).strict();

const SUBMIT_FINDINGS_BADGE_LABEL_MAX = 50;

/** Single source for the `badge_label` describe text, shared by the strict per-mode `submit_findings` schemas and the permissive participant union so the two never restate the same fact with different wording. The soft target (a 2-4 word label) lives here and nowhere else: `badge_label` is a per-hop tool field, not template-governed content. */
const BADGE_LABEL_DESCRIPTION = '2-4 word label for this node.';

/** Fixed fault text for a classified ref without a DIRECT role: such a ref is not a source. */
const DIRECT_ROLE_MESSAGE = 'transforms needs pass_through, compute or aggregate; a column that only filters or joins is not a source: remove it and describe it in sections.';

const ColumnRefSchema = z.object({
  node: z.string().describe('Node id of the source column.'),
  col: z.string().describe('Source column name on that node.'),
  transforms: z.array(ColumnTransformClassSchema).min(1, { message: DIRECT_ROLE_MESSAGE, abort: true })
    .refine(roles => roles.some(role => DIRECT_TRANSFORM_CLASSES.includes(role)), DIRECT_ROLE_MESSAGE).optional().describe(
    'Role of this source column: pass_through (unchanged), compute (expression or CASE operand), aggregate (aggregate argument). ' +
    'combine or filter only as an extra role beside one of these, never alone. Omit when the SQL does not show the role.',
  ),
  note: z.string().optional().describe('At most 12 words: the deciding expression, e.g. "Qty * Price".'),
}).strict().describe('One source column entry inside upstream_columns: fields node, col, transforms, note.');

const ColumnFlowWritesToObject = z.object({
  node: z.string().describe('Object id from <hop_context>.'),
  col: z.string().describe('Column name on that object.'),
}).strict();

/** One closed `column_flow` entry; provider projection and runtime parsing reject surplus keys. */
const OUT_COL_DESCRIPTION = "Output column of this hop from its column task; for a procedure, the column it writes. Never invent names.";

const ColumnFlowEntrySchema = z.object({
  out_col: z.string().describe(OUT_COL_DESCRIPTION),
  writes_to: ColumnFlowWritesToObject.nullish().describe('Table column {node, col} this output is written to, when that table is a neighbor in <hop_context>; otherwise null and name the write in sections.'),
  returns_to: ColumnFlowWritesToObject.optional().describe('Real caller output supplied in caller_output_targets for this scalar-return task; never a table write.'),
  upstream_columns: z.array(ColumnRefSchema).describe(
    'Neighbor columns whose value flows into out_col: expression operands, aggregate arguments, each UNION branch column, caller-bound inputs. ' +
    'Resolve parameters and aliases to source columns; exclude the entry\'s own writes_to column. [] means the value originates here.',
  ),
}).strict().describe('One output column: out_col, upstream_columns, optional writes_to or returns_to. note belongs inside an upstream_columns entry.');


/** The engine owns the dispatched hop; a sent id only guards against a stale or misdirected call. */
const FOCUS_NODE_ID_DESCRIPTION = 'Optional. Omit for the current hop; if sent, it must equal focus_node.id from <hop_context>.';

/** Reason-only removal of an irrelevant SQL node reached through a storage carrier. */
export const PruneCurrentInputSchema = z.object({
  focus_node_id: z.string().min(1).regex(/\S/).optional().describe(FOCUS_NODE_ID_DESCRIPTION),
  reason: z.string().min(1).regex(/\S/).describe('Why the whole current node is irrelevant to this investigation.'),
}).strict();

const COLUMN_FLOW_DESCRIPTION = 'One entry per arriving column named in <current_task> (the out_col values offered): for each, the neighbor columns its value comes from or is written to. '
  + 'Example: [{"out_col":"Total","upstream_columns":[{"node":"[dbo].[Orders]","col":"Qty","transforms":["compute"],"note":"Qty * Price"}]}]. '
  + 'Reference only neighbors in <hop_context>. Not sources: a column only in ON, WHERE, GROUP BY, PARTITION BY or ORDER BY, a lookup key, and row operations (TRUNCATE, DELETE); describe them in sections. [] when nothing feeds the arriving columns.';

const ColumnFlowSchema = z.array(ColumnFlowEntrySchema).describe(COLUMN_FLOW_DESCRIPTION);

/** Single source for the `sections` describe text, shared by the per-mode schemas and the participant union. */
const SECTIONS_DESCRIPTION = 'Required. An object keyed by angle, never a string: {"business": "…"} or {"technical": "…"}; only the classification\'s angle key(s). Each value is the section body per its capture recipe.';

/** Single source for the `summary` describe text, shared by the per-mode schemas and the participant union. */
const SUMMARY_DESCRIPTION =
  'Required for a fresh finding; omit a saved summary on correction. One sentence, readable without this hop: what this node does to the data and what it hands to which node.';

/** Shared `submit_findings` fields across BB and CT modes, one flat object. */
const HopFindingBaseSchema = z.object({
  focus_node_id: z.string().optional().describe(FOCUS_NODE_ID_DESCRIPTION),
  summary: z.string().optional().describe(SUMMARY_DESCRIPTION),
  badge_label: z.string().max(SUBMIT_FINDINGS_BADGE_LABEL_MAX).min(1)
    .refine(value => value.trim().length > 0, 'badge_label must contain non-whitespace text')
    .optional()
    .describe(BADGE_LABEL_DESCRIPTION),
  prune_neighbors: z.array(PruneNeighborSchema).max(MAX_ID_LIST_LENGTH).optional().describe(PRUNE_NEIGHBORS_DESCRIPTION),
  questions: z.array(NeighborQuestionSchema).max(MAX_ID_LIST_LENGTH).optional().describe(QUESTIONS_DESCRIPTION),
  /** One string per fired `*_capture` template, keyed by angle. One key (`business` / `technical` classification) or two (`both`) — required for a fresh finding. Declared last: a model emits arguments in schema order, so the long prose closes the object after every short field. */
  sections: CapturedSectionsSchema.optional().describe(SECTIONS_DESCRIPTION),
}).strict();

const { sections, summary, badge_label, prune_neighbors } = HopFindingBaseSchema.shape;

/** CT form: the BB form plus `column_flow` (served-required — always in the served `required` list, `[]` allowed when no columns continue), declared right after `focus_node_id`, ahead of `sections`/`summary`, so the short required structured field is emitted before the long capture prose: a model emits arguments in schema order, and a required field placed after several thousand characters of section text tends to drop on the longest generations. */
const HopFindingCtBaseSchema = HopFindingBaseSchema
  .omit({ sections: true, summary: true, badge_label: true, prune_neighbors: true, questions: true })
  .extend({
    column_flow: ColumnFlowSchema,
    summary,
    badge_label,
    prune_neighbors,
    questions: z.array(CtNeighborQuestionSchema).max(MAX_ID_LIST_LENGTH).optional().describe(QUESTIONS_DESCRIPTION),
    sections,
  })
  .strict();

/** The flat, wire-shaped `submit_findings` payload once shape- and classification-validated — `sections` still keyed by angle, before {@link toHopFinding} converts it to the engine's internal union. This is what {@link submitFindingsSchemaForMode} itself parses to: the schema is a validator only, so parsing an already-valid `FlatSubmitFindings` a second time is a no-op. */
type FlatSubmitFindings = z.output<typeof HopFindingBaseSchema> & { column_flow?: z.output<typeof ColumnFlowSchema> };

const FINDING_DECISION_FIELDS = ['questions', 'prune_neighbors', 'column_flow'] as const;

/** Independently usable decisions from the actual owning schemas; invalid fields remain explicitly unavailable. */
export function validatedFindingFields(input: unknown, schema: z.ZodType): {
  fields: Partial<Pick<HopFindingKept, typeof FINDING_DECISION_FIELDS[number]>>;
  unavailable: ReadonlySet<keyof HopFindingKept>;
  pruneIdentities?: readonly string[];
  /** Shape-valid slices for local diagnostics only; never substitute these for the unavailable full flow. */
  columnFlowDiagnostics?: readonly { entry: ColumnFlowEntry; index: number; upstreamIndexes: readonly number[] }[];
  /** Independently valid supplier identities whose header or other tuple fields are unavailable. */
  columnSupplierDiagnostics?: readonly { ref: ColumnFlowEntry['upstream_columns'][number]; path: string }[];
} {
  const fields: Partial<Pick<HopFindingKept, typeof FINDING_DECISION_FIELDS[number]>> = {};
  const unavailable = new Set<keyof HopFindingKept>();
  if (!(schema instanceof z.ZodObject) || typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { fields, unavailable: new Set(FINDING_DECISION_FIELDS) };
  }
  const raw = input as Record<string, unknown>;
  for (const field of FINDING_DECISION_FIELDS) {
    const owner = schema.shape[field];
    if (!owner) { unavailable.add(field); continue; }
    const parsed = owner.safeParse(raw[field]);
    if (parsed.success) Object.assign(fields, { [field]: parsed.data });
    else unavailable.add(field);
  }
  // A malformed reason or surplus key does not hide independently verified target identities.
  // This is evidence for dependency checks, never a usable prune decision.
  const pruneField = schema.shape.prune_neighbors;
  const pruneOwner = pruneField instanceof z.ZodOptional ? pruneField.unwrap() : pruneField;
  const idOwner = pruneOwner instanceof z.ZodArray && pruneOwner.element instanceof z.ZodObject
    ? pruneOwner.element.shape.id as z.ZodType | undefined : undefined;
  const identities = idOwner && Array.isArray(raw.prune_neighbors)
    ? raw.prune_neighbors.map(entry => idOwner.safeParse(entry && typeof entry === 'object' ? entry.id : undefined)) : undefined;
  const pruneIdentities = identities?.every(result => result.success)
    ? identities.map(result => result.data as string) : undefined;
  const flowField = schema.shape.column_flow;
  const flowOwner = flowField instanceof z.ZodOptional ? flowField.unwrap() : flowField;
  const columnFlowDiagnostics: Array<{ entry: ColumnFlowEntry; index: number; upstreamIndexes: number[] }> = [];
  const columnSupplierDiagnostics: Array<{ ref: ColumnFlowEntry['upstream_columns'][number]; path: string }> = [];
  if (unavailable.has('column_flow') && flowOwner instanceof z.ZodArray && Array.isArray(raw.column_flow)) {
    const entryOwner = flowOwner.element as z.ZodType<ColumnFlowEntry>;
    const variants = flowOwner.element instanceof z.ZodUnion ? flowOwner.element.options : [flowOwner.element];
    const supplierOwners = variants.flatMap(variant => {
      if (!(variant instanceof z.ZodObject)) return [];
      const upstream = variant.shape.upstream_columns;
      // Every flow variant uses this supplier owner, with the hop's node narrowing.
      return upstream instanceof z.ZodArray && upstream.element instanceof z.ZodObject
        ? [upstream.element as unknown as typeof ColumnRefSchema] : [];
    });
    const identityOwners = supplierOwners.map(owner => owner.pick({ node: true, col: true }));
    for (const [index, entry] of raw.column_flow.entries()) {
      if (!entry || typeof entry !== 'object' || !Array.isArray(entry.upstream_columns)) continue;
      const header = entryOwner.safeParse({ ...entry, upstream_columns: [] });
      const upstreamIndexes: number[] = [];
      const upstream_columns: ColumnFlowEntry['upstream_columns'] = [];
      for (const [refIndex, ref] of entry.upstream_columns.entries()) {
        const parsed = supplierOwners.map(owner => owner.safeParse(ref)).find(result => result.success);
        if (!parsed?.success) {
          if (ref && typeof ref === 'object') {
            const identity = identityOwners.map(owner => owner.safeParse({ node: ref.node, col: ref.col })).find(result => result.success);
            if (identity?.success) columnSupplierDiagnostics.push({ ref: identity.data, path: `column_flow.${index}.upstream_columns.${refIndex}` });
          }
          continue;
        }
        if (!header.success) {
          columnSupplierDiagnostics.push({ ref: parsed.data, path: `column_flow.${index}.upstream_columns.${refIndex}` });
          continue;
        }
        upstreamIndexes.push(refIndex);
        upstream_columns.push(parsed.data);
      }
      if (header.success) columnFlowDiagnostics.push({ entry: { ...header.data, upstream_columns }, index, upstreamIndexes });
    }
  }
  return { fields, unavailable, ...(pruneIdentities ? { pruneIdentities } : {}),
    ...(columnFlowDiagnostics.length ? { columnFlowDiagnostics } : {}),
    ...(columnSupplierDiagnostics.length ? { columnSupplierDiagnostics } : {}) };
}

/** Enforces the fresh kept shape of one flat `submit_findings` payload. */
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

/** Converts a validated flat `submit_findings` payload to the {@link HopFinding} union the engine consumes. */
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
  return kept;
}

/** Applies the fresh-content check to one flat per-mode object. */
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
    : schema.shape.summary ? schema.extend({
      summary: schema.shape.summary.unwrap().regex(/\S/, 'A supplied summary must contain non-whitespace text.').optional(),
    }).strict() : schema;
  const validated = source
    .check(superRefineAll((value, ctx) => refineSubmitFindingsShape(value as FlatSubmitFindings, ctx, fresh, classification))) as z.ZodType<FlatSubmitFindings>;
  if (!fresh) return validated;
  const required = Object.entries(schema.shape)
    .filter(([, field]) => !field.isOptional())
    .map(([key]) => key);
  return validated.meta({ required: [...required, 'summary', 'sections'] });
}

/** BB-mode submit_findings input. */
export const SubmitFindingsBbInputSchema = finalizeSubmitFindingsSchema(HopFindingBaseSchema, true);

/** CT-mode submit_findings input. */
export const SubmitFindingsCtInputSchema = finalizeSubmitFindingsSchema(HopFindingCtBaseSchema, true);

/** Memoized per (mode, classification) narrowed `submit_findings` schemas built by {@link submitFindingsSchemaForMode}. */
const submitFindingsSchemaCache = new Map<string, z.ZodType<FlatSubmitFindings>>();

/** Narrows {@link CapturedSectionsSchema} to the angle key(s) a locked classification keeps ({@link CLASSIFICATION_KEPT_ANGLES}). */
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

/** Backend-owned neighbor and column choices that narrow the served hop schema. */
export interface SubmitFindingsHopColumns {
  /** Focus node id of the current hop, admitting only equivalent metadata spellings when sent. */
  readonly focusNodeId?: string;
  /** Backend-owned current-hop neighbors, including closed evidence-only neighbors. */
  readonly neighbors?: readonly { readonly id: string; readonly can_question: boolean; readonly can_prune: boolean }[];
  readonly outCols: readonly string[] | null;
  readonly writesTo: boolean;
  readonly returnTargets?: readonly { readonly node: string; readonly col: string }[];
  readonly identifierCaseSensitive?: boolean;
  /** Neighboring functions eligible for an explicit current-caller output investigation. */
  readonly callerContextNodeIds?: readonly string[];
  /** Sorted ids the loaded store metadata admits as `upstream_columns` sources: focus neighbors (and read suppliers of its declared scalar callers) that carry stored columns or are trusted without column metadata (procedure, external, function). A columnless function also stays eligible in `questions` via {@link SubmitFindingsHopColumns.callerContextNodeIds}. */
  readonly columnSourceNodeIds?: readonly string[];
  /** Sorted ids the focus has a recorded dependency into; the only admissible `writes_to.node` values. */
  readonly writeTargetNodeIds?: readonly string[];
}

/** One choice schema for supplied identifiers, with an optional comparison key for column names. The provider enum and rejection choices share the same values; parsing preserves input. */
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
  const field = z.string().refine(value => resolveModelNodeId(value, known, identifierCaseSensitive) !== null,
    { message: 'Name a supplied object identity.', params: { allowed_values: [...ids] } }).meta({ enum: [...ids] });
  markObjectIdField(field, known, identifierCaseSensitive);
  return field;
}

/** Advertises canonical column names while accepting their shared SQL comparison form without rewriting input. */
function columnNameSchema(names: readonly string[], identifierCaseSensitive = false, node?: string) {
  return suppliedValueSchema(names, name => normalizeColName(name, identifierCaseSensitive), node);
}

/** The same supplier owner is used by full submissions and held tuple corrections. */
function columnRefSchemaForHop(hop: SubmitFindingsHopColumns) {
  return hop.columnSourceNodeIds
    ? ColumnRefSchema.extend({ node: objectIdSchema(hop.columnSourceNodeIds, hop.identifierCaseSensitive) }).strict()
    : ColumnRefSchema;
}

/** Projects {@link ColumnFlowSchema} onto one hop: declared output columns, permitted contributors and procedure write destinations. */
function columnFlowSchemaForHop(hop: SubmitFindingsHopColumns) {
  const outCol = !hop.outCols?.length
    ? ColumnFlowEntrySchema.shape.out_col
    : columnNameSchema(hop.outCols, hop.identifierCaseSensitive).describe(OUT_COL_DESCRIPTION);
  const upstreamColumns = hop.columnSourceNodeIds
    ? z.array(columnRefSchemaForHop(hop)).describe(ColumnFlowEntrySchema.shape.upstream_columns.description ?? '')
    : ColumnFlowEntrySchema.shape.upstream_columns;
  const shape = {
    out_col: outCol,
    upstream_columns: upstreamColumns,
    // Required at a procedure focus (null when no neighbor table is written); omission would silently attribute the edge to the procedure node.
    writes_to: (hop.writeTargetNodeIds
      ? ColumnFlowWritesToObject.extend({ node: objectIdSchema(hop.writeTargetNodeIds, hop.identifierCaseSensitive) })
      : ColumnFlowWritesToObject
    ).nullable().describe(ColumnFlowEntrySchema.shape.writes_to.description ?? ''),
  };
  if (hop.returnTargets?.length) {
    const destinations = hop.returnTargets.map(target => z.object({
      out_col: columnNameSchema([target.col], hop.identifierCaseSensitive, target.node),
      returns_to: z.object({ node: objectIdSchema([target.node], hop.identifierCaseSensitive), col: columnNameSchema([target.col], hop.identifierCaseSensitive, target.node) }).strict(),
      upstream_columns: shape.upstream_columns,
    }).strict());
    const entry = destinations.length === 1 ? destinations[0]! : z.union(destinations as [typeof destinations[number], typeof destinations[number], ...Array<typeof destinations[number]>]);
    return z.array(entry).describe('One mapping per entry in caller_output_targets, with matching returns_to. Identify dependencies from the supplied caller SQL and function body. List supported in-scope suppliers, or upstream_columns: [] when none can be recorded; retain known outside dependencies and unresolved evidence in sections.');
  }
  const entry = (hop.writesTo
    ? z.object(shape)
    : z.object({ out_col: shape.out_col, upstream_columns: shape.upstream_columns })
  ).strict();
  const flow = z.array(entry).describe(COLUMN_FLOW_DESCRIPTION);
  return hop.outCols?.length === 0 ? flow.max(0) : flow;
}

/** Selects the strict, mode-and-classification-locked `submit_findings` schema advertised to the model during an active SM hop. */
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
  if (hop?.focusNodeId) {
    const focusField = z.string().optional().describe(FOCUS_NODE_ID_DESCRIPTION);
    markObjectIdField(focusField, new Map([[hop.focusNodeId, true]]), hop.identifierCaseSensitive ?? false);
    narrowed = narrowed.extend({ focus_node_id: focusField }).strict() as typeof HopFindingCtBaseSchema;
  }
  const baseQuestion = hop?.neighbors
    ? NeighborQuestionSchema.extend({ nodeId: objectIdSchema(hop.neighbors.filter(n => n.can_question).map(n => n.id), hop.identifierCaseSensitive) })
    : NeighborQuestionSchema;
  if (mode === 'ct' && hop) narrowed = narrowed.extend({ column_flow: columnFlowSchemaForHop(hop) }).strict() as typeof HopFindingCtBaseSchema;
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
    const sectionsDescribe = (freshSubmission ? 'Required. ' : 'Omit held sections; supply only section angles needing correction. ')
      + (kept.length === CLASSIFICATION_KEPT_ANGLES.both.length
        ? 'Pre-formatted section body for the `business` and `technical` recipes, under keys `business` and `technical`.'
        : `Pre-formatted section body for the \`${kept[0]}\` recipe, under key \`${kept[0]}\`.`);
    const narrowedSections = capturedSectionSchemaForClassification(classification)
      .optional()
      .describe(sectionsDescribe);
    narrowed = narrowed.extend({ sections: narrowedSections }).strict() as typeof HopFindingCtBaseSchema;
  } else if (!freshSubmission) {
    narrowed = narrowed.extend({ sections: narrowed.shape.sections.describe(
      'Omit held sections; supply only section angles needing correction, keyed by business or technical.',
    ) }).strict() as typeof HopFindingCtBaseSchema;
  }
  const schema = finalizeSubmitFindingsSchema(narrowed, freshSubmission, classification);
  submitFindingsSchemaCache.set(cacheKey, schema);
  return schema;
}

/** Validates the engine's internal finding representation against the current hop contract. Shares field schemas and content requirements with wire admission while retaining section arrays. No normalization, held-content merge or engine mutation occurs here. */
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

/** Validates a typed finding before held merge or mutation, sharing wire fields and content checks. */
export function validateHopSubmissionShape(
  input: unknown,
  mode: 'bb' | 'ct',
  classification?: ClassificationValue,
  freshSubmission = false,
  hop?: SubmitFindingsHopColumns,
): { readonly ok: true; readonly data: HopSubmission } | { readonly ok: false; readonly error: ToolRejection; readonly actions: ReturnType<typeof validatedFindingFields>; readonly sections?: HopFindingKept['sections'] } {
  const schema = internalKeptFindingSchema(mode, classification, freshSubmission, hop);
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data as HopSubmission };
  const sections = schema.shape.sections.safeParse(typeof input === 'object' && input !== null ? (input as Record<string, unknown>).sections : undefined);
  return { ok: false, error: rejectionFromZodError(parsed.error, { code: REJECTION_CODES.invalidInput, input, schema, form: true }),
    actions: validatedFindingFields(input, schema), ...(sections.success ? { sections: sections.data } : {}) };
}

/** The way out of a rejected finding, offered with the last repair opportunity. */
export const SUBMIT_FINDINGS_WAY_OUT = 'If a reference cannot be mapped, remove it and record it in sections or as a question. An empty column_flow ends the arriving columns.';

/** Zod schema for `get_neighbor_columns` tool input. */
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
markIdFormSearch(SearchObjectsInputSchema);

/** `lineage_get_object_detail` input. */
export const GetObjectDetailInputSchema = z.object({
  id: z.string().describe('Canonical object ID returned by a lineage search or scope tool.'),
  cursor: CursorSchema.optional(),
}).strict();

/** `lineage_detect_graph_patterns` input. */
export const DetectGraphPatternsInputSchema = z.object({
  type: z.enum(['hubs', 'islands', 'orphans', 'longest-path', 'cycles', 'external-refs']).describe('Structural graph pattern to detect.'),
  min_degree: z.number().optional().describe('Minimum node degree for hub detection.'),
  max_size: z.number().optional().describe('Maximum nodes per island component (islands only); capped by the graph node limit. Omit to use the configured island-size limit.'),
}).strict();

/** `lineage_search_ddl` input. */
export const SearchDdlInputSchema = z.object({
  query: z.string().describe('Regular expression against SQL body text; case-insensitive; `^` and `$` match per line.'),
  types: z.array(z.enum(['view', 'procedure', 'function'])).optional().describe('Optional body-type filter; omit to search all three.'),
}).strict();

/** Hard cap on a `sections[].label`. The label's shape is owned by the field's own `.describe()`, which states its role and deliberately no character target. */
const PRESENT_RESULT_SECTION_LABEL_MAX = 90;
/** Identity of a section label: whitespace collapsed, trimmed, case-folded. Two labels with the same key name the same section, in a submission, a repair patch and a committed report alike. */
export function normalizePresentSectionLabel(label: string): string {
  return label.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A refinement that also runs when the value already carries shape issues, so one parse reports every defect of a call instead of hiding the cross-field ones behind the first shape failure. Its `fn` reads the raw value and must tolerate a wrong type. */
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

/** The Lineage color-scheme enum shared by every colored surface. Declared once so render paths cannot drift: flow-role schemes (`source` / `transform` / `target`) plus status schemes (`good` / `warn` / `fail`). */
const HighlightSchemeSchema = z.enum(['source', 'transform', 'target', 'good', 'warn', 'fail']);

/** One model-supplied node id, preserved verbatim and required non-empty. */
const NodeIdSchema = z.string()
  .regex(/\S/, 'Node ID must not be blank.')
  .min(1, 'Node ID must not be blank.');

/** One below-node caption. Its keys share nothing with a `sections[]` item's `{label, node_ids, text}`, so `.strict()` names the offending keys when the two are conflated. */
const NoteSchema = z.object({
  node_id: NodeIdSchema.describe('Node ID the caption sits below.'),
  caption: z.string().regex(/\S/, 'Must contain non-whitespace text.').min(1, 'Note is missing its caption').describe('One-sentence caption, grounded in the evidence supplied for this stage.'),
}).strict();

/** `present_result.notes`: an array of declared-key objects, the one object shape every function-calling schema dialect expresses — a map keyed by data (`additionalProperties` with a value schema) is not portable across providers. The parsed value is the shape every consumer reads, so a held draft re-validates unchanged. A node ID given two different captions rejects, since one of them would otherwise be lost; an identical repeat is harmless. */
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

/** Schema for a visual highlight group, grouping nodes by a shared role or status. */
const HighlightGroupSchema = z.object({
  label: z.string().regex(/\S/, 'Must contain non-whitespace text.').min(1, 'Group label is required').describe('Legend label describing the shared graph role or status; presentation style: see the `highlights` output template.'),
  color: HighlightSchemeSchema.describe('Flow role or status. `source`: upstream origins feeding the flow. `target`: destination or focal object. `transform`: intermediate nodes that transform values. `good` / `warn` / `fail`: diagnostic status. One role per group.'),
  node_ids: z.array(NodeIdSchema).describe('Node IDs that share this graph role or status.'),
}).strict();

/** One final report section: a label that becomes both the section heading and the graph badge, the nodes it explains, and its detail body. */
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

/** One section of a held repair draft: `node_ids` and `text` may each be omitted to keep the held value under that label, so a repair that adds one node id never retypes a body the model cannot see (the held-draft view shows labels and node ids only). */
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

/** The preview stage schemas for an answer of `blockCount` served blocks. A section is the {@link PresentResultSectionSchema} keys with the body given as the served id `B1`..`B<blockCount>` it starts at, so an id outside the answer cannot be sent; the engine ends each section before the next one's start. The patch form permits omission of `node_ids` and `start` to keep the held value under the label. Preview reuses the discovery prose for `summary`/`title`; the model authors `name` itself. */
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

/** Schema defining the shape of the final generated presentation result. */
export const PresentResultModelSchema = z.object({
  name: z.string().regex(/\S/, 'Name must not be blank.').min(1, 'name is required').describe('Name for the generated lineage view.'),
  summary: z.string().regex(/\S/, 'Must contain non-whitespace text.').min(1, 'summary is required — one-line graph purpose (~120 chars)').describe('One-line summary shown with the generated view.'),
  title: z.string().optional().describe('Optional report heading.'),
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

/** One section of a report that is already committed: `text` and `node_ids` may each be omitted to keep the committed body or links under that label. */
const PresentResultRetainedSectionSchema = PresentResultSectionSchema.extend({
  node_ids: z.array(NodeIdSchema).optional().describe('Nodes this section documents; put each node in one section. Omit to keep the committed links for this label; an empty array unlinks them.'),
  text: z.string().optional().describe('Detail body. Omit to keep the committed text for this label; supply it only to rewrite that section.'),
});

/** Projects a `present_result` schema onto a render that amends a committed report. */
function withRetainableSections<T extends z.ZodObject<z.ZodRawShape>>(schema: T) {
  return schema.extend({
    sections: sectionList(PresentResultRetainedSectionSchema).optional()
      .describe('Final report sections. Omit entirely to keep the committed report; list a label with no text to keep that section unchanged.'),
  });
}

/** Selects the model-facing `present_result` schema from the phase and held-draft authorization. Preview omits AI-authored wrapper prose; synthesis uses the full new-render contract; either phase projects the existing strict patch schema while a repairable draft is held. */
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

/** Strict patch schema for repairing a held `present_result` draft. */
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

/** The repair patch plus the graph-edit fields, which only a rejection of that same edit may authorize. */
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

/** Per-field-set memo for {@link presentResultRepairPatchSchemaForFields}. */
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

/** Builds the strict provider/runtime patch schema for a held-draft repair. */
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

/** Model-facing schema for a new synthesis render. */
const PresentResultSynthesisModelSchema = PresentResultModelSchema.omit({
  prune_node_ids: true,
  add_node_ids: true,
  is_update: true,
}).strict();

/** The stage projections a render that amends a committed report is offered and parsed against. */
const PresentResultRetainingModelSchema = withRetainableSections(PresentResultModelSchema);
const PresentResultRetainingSynthesisModelSchema = withRetainableSections(PresentResultSynthesisModelSchema);

/** Model-facing `lineage_submit_findings` input schema (the permissive BB∪CT superset). */
export const SubmitFindingsModelSchema = z.object({
  focus_node_id: z.string().optional().describe(FOCUS_NODE_ID_DESCRIPTION),
  summary: z.string().optional().describe(SUMMARY_DESCRIPTION),
  prune_neighbors: z.array(PruneNeighborSchema).max(MAX_ID_LIST_LENGTH).optional().describe(PRUNE_NEIGHBORS_DESCRIPTION),
  questions: z.array(CtNeighborQuestionSchema).max(MAX_ID_LIST_LENGTH).optional().describe(QUESTIONS_DESCRIPTION),
  column_flow: ColumnFlowSchema.optional(),
  badge_label: z.string().max(SUBMIT_FINDINGS_BADGE_LABEL_MAX).min(1)
    .refine(value => value.trim().length > 0, 'badge_label must contain non-whitespace text')
    .optional()
    .describe(BADGE_LABEL_DESCRIPTION),
  sections: CapturedSectionsSchema.optional().describe(SECTIONS_DESCRIPTION),
}).strict();

/** Validates a discovery-tool input against its Zod schema. */
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
