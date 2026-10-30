/** Zod input schemas and lightweight runtime validation for the AI tools. Zero VS Code imports — pure schema definitions. */
import { z } from 'zod';
import { ingestToolInput } from '../support/toolIngestion';
export { normalizePresentSectionLabel } from '../support/toolValidation';
import { findingShapeIssues } from '../support/findingShape';
import {
  captureToolFact,
  type ToolFactContext,
} from '../support/toolValidation';
import {
  markIdFormSearch,
  markObjectIdField,
  markColumnField,
} from './normalizeModelInput';
import {
  MAX_ID_LIST_LENGTH,
  SCREEN_STATE_MAX_IDS,
  ColumnTransformClassSchema,
} from '../../engine/shared/bridgeContract';
import { ExplorationDepthSelectionSchema } from '../../engine/shared/explorationDepthContract';
import { type ToolRejection } from '../support/toolErrorEnvelope';
import {
  CLASSIFICATION_KEPT_ANGLES,
  type ClassificationValue,
} from '../session/classification';
import { extractRawSectionAngles } from '../interaction/rules/submitFindingsRules';
import type { ColumnFlowEntry, HopFindingKept } from '../sm/smTypes';

/** A column identifier named by the user. Wildcards are rejected at the boundary: a wildcard target column locks an unwinnable CT session because no real column can match it. */
export const ColumnIdentifierSchema = z
  .string()
  .regex(/\S/, 'Must contain non-whitespace text.')
  .min(1)
  .regex(/^[^*%?]+$/, 'wildcards are not column identifiers')
  .describe(
    'A field of a table or view that the user named verbatim; a column trace starts only when at least one such column is named. Wildcards are rejected at the boundary.',
  );

const MissionBriefValueSchema = z
  .string()
  .min(1, 'Mission brief must not be empty.')
  .regex(/\S/, 'Mission brief must contain non-whitespace content.')
  .describe(
    'Compact investigation goal and relevance criteria preserved verbatim across exploration hops. Keep it compact (a few sentences); length is never a rejection axis.',
  );

const ScopeNotesValueSchema = z
  .array(
    z
      .string()
      .min(1)
      .regex(/\S/, 'A scope note must contain non-whitespace content.'),
  )
  .max(8)
  .describe(
    'Constraints the user stated that no filter field expresses (e.g. "ignore filter criteria"), one short note ' +
      "each in the user's terms; echoed at the approval gate and carried to every hop.",
  );

/** Canonical answer-lens values and primary-intent instruction shared by entry and tool schemas. */
export const ClassificationValueSchema = z
  .enum(['business', 'technical', 'both'])
  .describe(
    'Choose the answer lens from the primary user intent: "business" for meaning, purpose, impact or business rules, ' +
      'and for unspecified or ambiguous intent. Incidental SQL, table or schema mentions, or a small technical subquestion, ' +
      'do not change a primary business lens; answer those details with supported evidence. "technical" only for clear overall technical intent ' +
      '(performance, indexes, execution plan, query shape, load pattern); "both" only when the user explicitly asks for both perspectives. Required for a fresh proposal.',
  );

/** Single source for the `depth` describe text on both {@link StartExplorationInputSchema} and every provider branch spread through `StartPatchFields` — one canonical home instead of a second literal duplicating it. Required for a fresh proposal, like {@link ClassificationValueSchema}; a refine may omit it to keep the reviewed proposal's depth. The per-side `0` clause matches {@link ExplorationDepthSelectionSchema}'s own contract (`explorationDepthContract.ts`) and `isReachableInApprovedDirection` (`smBase.ts`): 0 is a permanent border for the rest of the session, not merely a one-time skip of the initial seed. */
const DEPTH_DESCRIPTION =
  'Starting scope: {upstream, downstream}, each {levels, exactness}; upstream levels reach the sources, downstream levels reach the consumers that read the origin. levels is a non-negative integer or "all"; 0 permanently closes that side for the session. exactness is "exact" when the user literally stated that level count, "approximate" when it is your own estimate — an approximate count above 0 does not bound the scope, which runs until the filters or the border stop it. A request for the complete chain sets levels "all" and exactness "exact"; "direct" means levels 1; with no stated depth, set levels 3 and exactness "approximate". Required for a fresh proposal; omit on a refine to keep the reviewed depth.';

const StartDepthSchema =
  ExplorationDepthSelectionSchema.nullish().describe(DEPTH_DESCRIPTION);

const ANALYSIS_MODE_DESCRIPTION =
  'Required for fresh exploration: "bb" traces whole objects; "ct" traces named columns. Default to "bb" when unclear.';

/** `targetColumns` on every exploration phase: column trace names the columns; blackboard forbids the property. */
const TARGET_COLUMNS_PHASE_DESCRIPTION =
  'CT only: name each column to trace. When the user asked for every column, read them with lineage_get_object_detail and send each one. BB forbids this property.';

const StartExcludeTypesSchema = z
  .array(z.string())
  .optional()
  .describe(
    'Object types excluded from the approved scope. Omit to keep the current list (on a fresh proposal, the types the GUI filter hides); a sent list replaces it.',
  );
const StartExcludeSchemasSchema = z
  .array(z.string())
  .optional()
  .describe(
    'Schema names excluded from the approved scope. Omit to keep the current list (on a fresh proposal, the schemas the GUI filter hides); a sent list replaces it, so repeat those you keep.',
  );
const StartExcludeNodeIdsSchema = z
  .array(z.string().meta({ toolValidated: 'start.reference' }))
  .optional()
  .describe(
    'Resolved object IDs to remove, including dependent branches reachable only through them. Omit to keep the current list (on a fresh proposal, the objects the GUI filter excludes); a sent list replaces it.',
  );
const StartPassNodeIdsSchema = z
  .array(z.string().meta({ toolValidated: 'start.reference' }))
  .optional()
  .describe(
    'Resolved object IDs to keep as topology-only passthrough nodes without analyzing them; the mapping for objects the user said to ignore or skip. Omit to keep the current list; a sent list replaces it.',
  );

const START_SCOPE_FIELDS = {
  origin: true,
  analysisMode: true,
  targetColumns: true,
  depth: true,
  excludeTypes: true,
  excludeSchemas: true,
  excludeNodeIds: true,
  passNodeIds: true,
} as const;

const FreshScopeAdmission = {
  required: ['origin', 'analysisMode', 'depth'],
  properties: { depth: { not: { type: 'null' }, toolIssue: 'missing' } },
};
const startScopeAdmission = (fresh: object) => [
  {
    name: 'start.scope',
    fields: Object.keys(START_SCOPE_FIELDS),
    assertions: { allOf: [fresh] },
  },
];

/** Strict domain boundary for fresh, refine, and completed-session exploration requests. */
export const StartExplorationInputSchema = z
  .object({
    origin: z
      .string()
      .min(1)
      .optional()
      .meta({ toolValidated: 'start.origin' })
      .describe('Canonical object ID that anchors a fresh exploration.'),
    question: z
      .string()
      .optional()
      .meta({ toolValidated: 'start.question' })
      .describe('The user question this exploration must answer.'),
    proposalRevision: z
      .number()
      .int()
      .positive()
      .optional()
      .meta({ toolValidated: 'start.proposalRevision' })
      .describe(
        'Required when refining a pending approval proposal; copy the revision shown by the gate.',
      ),
    analysisMode: z
      .enum(['bb', 'ct'])
      .optional()
      .meta({ toolValidated: 'start.analysisMode' })
      .describe(ANALYSIS_MODE_DESCRIPTION),
    targetColumns: z
      .array(ColumnIdentifierSchema.meta({ toolValidated: 'start.target' }))
      .optional()
      .meta({ toolValidated: 'start.targetColumns' })
      .describe(TARGET_COLUMNS_PHASE_DESCRIPTION),
    depth: StartDepthSchema,
    excludeTypes: StartExcludeTypesSchema,
    /** Schemas to drop from the BFS scope under the source comparison policy. Honored at scope-build time — any candidate node whose schema matches is excluded. REPLACE semantics: each call wipes prior filter state on the engine; accumulate across refine rounds by re-sending every prior exclusion plus the new one. */
    excludeSchemas: StartExcludeSchemasSchema,
    /** Specific node ids to drop from the BFS scope under the source comparison policy. Cuts the node and its subtree reachable only through it. Use only when the user explicitly says remove / drop / prune / cut. REPLACE semantics — see {@link excludeSchemas}. Every id must already be resolved via `lineage_search_objects` — unknown ids cause the call to reject with issue `not_found`. */
    excludeNodeIds: StartExcludeNodeIdsSchema,
    /** Specific node ids the engine keeps in scope but auto-passes (no analysis written, topology preserved so descendants stay reachable). Default interpretation when the user says ignore / skip / don't analyze. REPLACE semantics — see {@link excludeSchemas}. Every id must already be resolved via `lineage_search_objects` — unknown ids cause the call to reject with issue `not_found`. */
    passNodeIds: StartPassNodeIdsSchema,
    scopeNotes: ScopeNotesValueSchema.optional().meta({
      toolValidated: 'start.scopeNotes',
    }),
    mission_brief: MissionBriefValueSchema.optional().meta({
      toolValidated: 'start.mission_brief',
    }),
    classification: ClassificationValueSchema.optional().meta({
      toolValidated: 'start.classification',
    }),
  })
  .strict();

const startPhaseSchemas = [false, true].map((refining) =>
  StartExplorationInputSchema.meta({
    toolObjectFact: 'start.input',
    toolGroups: startScopeAdmission(refining ? {} : FreshScopeAdmission),
    toolAdmission: refining ? {} : { required: ['classification'] },
  }),
);
/** Resolves required scope facts from the real session stage, never a model's claimed revision. */
export const startExplorationSchemaForState = (
  refining: boolean,
): typeof StartExplorationInputSchema => startPhaseSchemas[Number(refining)];

const StartScopeFactSchema =
  StartExplorationInputSchema.pick(START_SCOPE_FIELDS);
/** Collects native-valid start scope and annotations without selecting missing scope values. */
export function startAdmissionFacts() {
  let scope: z.output<typeof StartScopeFactSchema> | undefined,
    input: Record<string, unknown> | undefined;
  const annotations: Partial<
    Pick<
      z.output<typeof StartExplorationInputSchema>,
      | 'question'
      | 'scopeNotes'
      | 'mission_brief'
      | 'classification'
      | 'proposalRevision'
      | 'analysisMode'
      | 'targetColumns'
      | 'origin'
    >
  > = {};
  const references = new Map<string, string>(),
    targets = new Map<number, string>();
  const fields = StartExplorationInputSchema.shape;
  const facts: ToolFactContext = {
    objects: new Map([
      [
        'start.input',
        (value) => {
          input = value;
        },
      ],
    ]),
    validated: new Map([
      [
        'start.scope',
        captureToolFact(StartScopeFactSchema, (value) => {
          scope = value;
        }),
      ],
      [
        'start.reference',
        captureToolFact(z.string(), (value, path) => {
          references.set(path, value);
        }),
      ],
      [
        'start.target',
        captureToolFact(ColumnIdentifierSchema, (value, path) => {
          targets.set(Number(path.split('/')[2]), value);
        }),
      ],
      ...(
        [
          'question',
          'scopeNotes',
          'mission_brief',
          'classification',
          'proposalRevision',
          'analysisMode',
          'targetColumns',
          'origin',
        ] as const
      ).map(
        (field) =>
          [
            `start.${field}`,
            captureToolFact(fields[field], (value) => {
              Object.assign(annotations, { [field]: value });
            }),
          ] as const,
      ),
    ]),
  };
  return {
    facts,
    references,
    targets,
    annotations,
    scope: () => scope,
    input: () => input,
  };
}

const StartOriginSchema = z
  .string()
  .min(1)
  .describe('Canonical object ID that anchors a fresh exploration.');
const StartQuestionSchema = z
  .string()
  .optional()
  .describe('The user question this exploration must answer.');
const StartScopeNotesSchema = ScopeNotesValueSchema.optional();
const StartMissionBriefSchema = MissionBriefValueSchema.optional();
const NamedCtTargetColumnsSchema = z
  .array(ColumnIdentifierSchema)
  .min(1)
  .describe('CT requires one or more user-named columns.');
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
const StartFreshBbProviderSchema = z
  .object({
    ...StartPatchFields,
    origin: StartOriginSchema,
    analysisMode: z.literal('bb').describe(ANALYSIS_MODE_DESCRIPTION),
    classification: ClassificationValueSchema,
    depth: ExplorationDepthSelectionSchema.describe(DEPTH_DESCRIPTION),
  })
  .strict();

/** Fresh CT proposal branch. It cannot encode refine or supplement fields. */
const StartFreshCtProviderSchema = z
  .object({
    ...StartPatchFields,
    origin: StartOriginSchema,
    analysisMode: z.literal('ct').describe(ANALYSIS_MODE_DESCRIPTION),
    classification: ClassificationValueSchema,
    depth: ExplorationDepthSelectionSchema.describe(DEPTH_DESCRIPTION),
    targetColumns: NamedCtTargetColumnsSchema,
  })
  .strict();

/** Pending-proposal patch branch. Omitted fields are merged mechanically by the dispatcher, except an omitted `mission_brief`, which is kept only while origin, analysis mode, target columns and depth are unchanged; a scope change clears it. */
const StartRefineProviderSchema = z
  .object({
    ...StartPatchFields,
    proposalRevision: z
      .number()
      .int()
      .positive()
      .describe('Revision shown by the pending approval gate.'),
    analysisMode: z
      .enum(['bb', 'ct'])
      .optional()
      .describe(ANALYSIS_MODE_DESCRIPTION),
    targetColumns: z
      .array(ColumnIdentifierSchema)
      .optional()
      .describe(TARGET_COLUMNS_PHASE_DESCRIPTION),
  })
  .strict();

/** Fresh-entry model contract selected for `sm_entry` before the first approval gate. */
export const StartExplorationFreshProviderInputSchema = z
  .object({
    ...StartPatchFields,
    origin: StartOriginSchema,
    analysisMode: z.enum(['bb', 'ct']).describe(ANALYSIS_MODE_DESCRIPTION),
    classification: ClassificationValueSchema,
    depth: ExplorationDepthSelectionSchema.describe(DEPTH_DESCRIPTION),
    targetColumns: z
      .array(ColumnIdentifierSchema)
      .optional()
      .describe(TARGET_COLUMNS_PHASE_DESCRIPTION),
  })
  .strict();

/** Gate-refinement model contract selected only while revising a pending proposal. */
export const StartExplorationRefineProviderInputSchema =
  StartRefineProviderSchema;

/** Canonical all-phase contract used by persistent VS Code/Copilot registration and manifest parity. API InstructionPlans replace it with exactly one phase-specific schema before each model call. */
export const StartExplorationProviderInputSchema = z.union([
  StartFreshBbProviderSchema,
  StartFreshCtProviderSchema,
  StartRefineProviderSchema,
]);
/** A `get_scope_bundle` depth: a non-negative integer or `"all"`. */
const ScopeDepthSchema = z.union([z.number().int().min(0), z.literal('all')]);
const ScopeOriginSchema = z
  .string()
  .min(1)
  .describe(
    'Canonical object ID at the center of the requested lineage scope.',
  );
const ScopeIncludeDdlSchema = z
  .boolean()
  .optional()
  .describe('Whether to include SQL bodies for nodes in the returned scope.');

/** Zod schema validating the parameters for the `get_scope_bundle` discovery tool. */
export const GetScopeBundleInputSchema = z
  .object({
    origin: ScopeOriginSchema.meta({ toolStringFact: 'modelObject' }),
    direction: z
      .enum(['upstream', 'downstream', 'bidirectional'])
      .optional()
      .describe(
        'Direction of dependencies to include; defaults to bidirectional.',
      ),
    depth: ScopeDepthSchema.optional().describe(
      'Optional symmetric hop depth, or "all" for the whole reachable chain. Omit to use the backend default of 3.',
    ),
    upstream_depth: ScopeDepthSchema.optional().describe(
      'Optional upstream hop depth for an asymmetric bidirectional scope.',
    ),
    downstream_depth: ScopeDepthSchema.optional().describe(
      'Optional downstream hop depth for an asymmetric bidirectional scope.',
    ),
    include_ddl: ScopeIncludeDdlSchema,
  })
  .strict()
  .meta({
    toolGroups: [
      {
        name: 'scope.parameters',
        fields: [
          'origin',
          'direction',
          'depth',
          'upstream_depth',
          'downstream_depth',
        ],
      },
    ],
    toolAdmission: {
      allOf: [
        {
          if: {
            anyOf: [
              { not: { required: ['direction'] } },
              {
                properties: { direction: { const: 'bidirectional' } },
                required: ['direction'],
              },
            ],
          },
          then: {
            allOf: [
              {
                if: {
                  required: ['depth'],
                  anyOf: [
                    { required: ['upstream_depth'] },
                    { required: ['downstream_depth'] },
                  ],
                },
                then: { properties: { depth: false } },
              },
              {
                if: {
                  not: { required: ['depth'] },
                  anyOf: [
                    { required: ['upstream_depth'] },
                    { required: ['downstream_depth'] },
                  ],
                },
                then: { required: ['upstream_depth', 'downstream_depth'] },
              },
            ],
          },
          else: {
            if: {
              anyOf: [
                { required: ['upstream_depth'] },
                { required: ['downstream_depth'] },
              ],
            },
            then: { properties: { direction: false } },
          },
        },
      ],
    },
  });

/** Inferred type of {@link GetScopeBundleInputSchema}. */
export type GetScopeBundleInput = z.infer<typeof GetScopeBundleInputSchema>;

/** Model-facing projection of `lineage_get_scope_bundle` sent on every model call. */
export const GetScopeBundleModelSchema = z
  .object({
    origin: ScopeOriginSchema.meta({ toolStringFact: 'modelObject' }),
    upstream_depth: ScopeDepthSchema.describe(
      'Upstream levels: a positive integer, "all" for the whole chain, or 0 to exclude upstream. Use the smallest depth that answers the question: 1 for direct neighbours; "all" only for a whole-chain or path question.',
    ),
    downstream_depth: ScopeDepthSchema.describe(
      'Downstream levels: a positive integer, "all" for the whole chain, or 0 to exclude downstream. Use the smallest depth that answers the question: 1 for direct neighbours; "all" only for a whole-chain or path question.',
    ),
    include_ddl: ScopeIncludeDdlSchema,
  })
  .strict();

const nonWhitespaceText = z
  .string()
  .regex(/\S/, 'Must contain non-whitespace text.');

/** Zod schema for `submit_findings.sections`, keyed by angle so the same angle cannot be sent twice. */
const CapturedSectionsSchema = z
  .object({
    /** Pre-formatted section body written per `business_capture`. */
    business: nonWhitespaceText.optional(),
    /** Pre-formatted section body written per `technical_capture`. */
    technical: nonWhitespaceText.optional(),
  })
  .strict();

/** Model-facing output of {@link CapturedSectionsSchema}: at most one string per angle. */
type CapturedSectionsWire = z.infer<typeof CapturedSectionsSchema>;

/** Single source for the `prune_neighbors` field describe text, shared by the strict per-mode schemas and the permissive participant union so the two cannot drift. */
const PRUNE_NEIGHBORS_DESCRIPTION =
  'A neighbor is either mapped or questioned (kept) or pruned, never both. ' +
  "Name each `can_prune: true` neighbor this node's SQL shows is irrelevant to the user question and arriving task. " +
  'That neighbor and whatever only it leads to are removed. The focus stays on the graph, including when every neighbor is named (a dead end). A neighbor named here gets no questions entry.';

/** One `prune_neighbors[]` entry: the neighbour and why this node's SQL shows it is off the answer. */
const PruneNeighborSchema = z
  .object({
    id: stringFact(z.string().min(1), 'pruneIdentity').describe(
      'A neighbor id from `<hop_context>`.',
    ),
    reason: nonWhitespaceText
      .min(1)
      .describe(
        "What in this node's SQL shows the neighbor is off the answer.",
      ),
  })
  .strict();

/** Single source for the `questions` field describe text, shared by the strict per-mode schemas and the permissive participant union. */
const QUESTIONS_DESCRIPTION =
  'Ask a kept neighbor what its own SQL must answer for the user question and arriving task: its rules, calculations and thresholds beyond automatic column continuation. ' +
  'A question to an out-of-scope neighbor becomes a follow-up offer. No questions to visited or pruned neighbors.';

const BB_PRUNE_NEIGHBORS_DESCRIPTION =
  "Name each `can_prune: true` neighbor this node's SQL shows is off the path; that neighbor and whatever only it leads to are removed. The focus stays on the graph, including when every neighbor is named (a dead end). A neighbor named here gets no questions entry.";
const BB_QUESTIONS_DESCRIPTION =
  'Provide a self-contained subquestion for each eligible in-scope neighbor kept for analysis or passthrough, tied to the user question. For an eligible out-of-scope neighbor, optionally propose a relevant follow-up; it is deferred until scope approval. No questions to visited or pruned neighbors.';

/** One `questions[]` entry, attached to that neighbour's queued hop. */
const NeighborQuestionSchema = z
  .object({
    nodeId: stringFact(z.string().min(1), 'questionIdentity').describe(
      'A neighbor id from `<hop_context>`.',
    ),
    question: z
      .string()
      .min(1)
      .describe(
        'The check, self-contained: name the neighbor and what to establish there.',
      ),
  })
  .strict();

const CtNeighborQuestionSchema = NeighborQuestionSchema.extend({
  caller_context: z
    .object({ node: z.string().min(1), col: z.string().min(1) })
    .strict()
    .optional()
    .describe(
      'For a function investigation, declare the real current caller output whose contribution its supplied SQL must establish. The caller SQL is supplied at the function hop to bind actual arguments; this declaration creates no column edge or function column.',
    ),
}).strict();

const SUBMIT_FINDINGS_BADGE_LABEL_MAX = 50;

/** Single source for the `badge_label` describe text, shared by the strict per-mode `submit_findings` schemas and the permissive participant union so the two never restate the same fact with different wording. The soft target (a 2-4 word label) lives here and nowhere else: `badge_label` is a per-hop tool field, not template-governed content. */
const BADGE_LABEL_DESCRIPTION = '2-4 word label for this node.';

function stringFact<S extends z.ZodType>(schema: S, name: string): S {
  return schema.meta({ ...schema.meta(), toolStringFact: name });
}

const SUPPLIER_FACT = { toolValidated: 'supplier' };

const ColumnRefSchema = z
  .object({
    node: stringFact(z.string(), 'flowReference').describe(
      'Node id of the source column.',
    ),
    col: stringFact(z.string(), 'supplierColumn').describe(
      'Source column name on that node.',
    ),
    transforms: z
      .array(ColumnTransformClassSchema)
      .optional()
      .describe(
        'Classify this source column’s own role end to end; omit when SQL does not determine it. ' +
          'pass_through: unchanged value. compute: expression input, including a CASE condition operand. aggregate: value summarised by an aggregate. ' +
          'combine: join, grouping, partition or ordering key. filter: predicate ' +
          'selecting contributing rows. Grouping, partition and ordering keys are not aggregate value inputs; ' +
          'display-only sorting contributes no role.',
      ),
    note: z
      .string()
      .max(200)
      .optional()
      .describe('The deciding expression, at most ~12 words.'),
  })
  .strict()
  .meta(SUPPLIER_FACT)
  .describe(
    'One source column entry inside upstream_columns: fields node, col, transforms, note.',
  );

/** One closed `column_flow` entry; provider projection and runtime parsing reject surplus keys. */
const OUT_COL_DESCRIPTION =
  "Output column resolved from this hop\'s column task; for a procedure, the column it writes to out_node.";
const OUT_NODE_DESCRIPTION =
  'Table from <hop_context> that this procedure writes out_col to. For a write to an object not listed, omit the entry and name the write in sections.';
const UPSTREAM_DESCRIPTION =
  'At a bodied focus, record the real source columns whose value flows into out_col: operands of its expression, an aggregate’s argument, each set-operation branch’s column at that position, caller-bound value inputs. Columns used only to join, filter, group, partition or order its rows are recorded with their indirect roles. ' +
  'Exclude the entry’s own out_node column, unused expressions and columns only copied alongside out_col (SELECT *, the rest of a column list). Resolve parameters and computed aliases to their source columns.';
/** At a procedure, a created value is the pair procedure.col -> out_node.out_col (D-130). */
const PROCEDURE_UPSTREAM_DESCRIPTION = `${UPSTREAM_DESCRIPTION} A value this procedure creates lists this procedure with the column its task names, else out_col; [] records no pair.`;

const ColumnFlowEntrySchema = z
  .object({
    out_col: stringFact(z.string(), 'flowOutColumn').describe(
      OUT_COL_DESCRIPTION,
    ),
    out_node: stringFact(z.string(), 'flowReference')
      .optional()
      .describe(OUT_NODE_DESCRIPTION),
    upstream_columns: z
      .array(ColumnRefSchema)
      .meta({ toolArrayFact: 'suppliers' })
      .describe(`${UPSTREAM_DESCRIPTION} [] means the value originates here.`),
  })
  .strict()
  .meta({
    toolGroups: [{ name: 'flowHeader', fields: ['out_col', 'out_node'] }],
    toolObjectFact: 'flowPresence',
  })
  .describe(
    'One output column: out_col, upstream_columns, optional out_node. note belongs inside an upstream_columns entry.',
  );

/** The engine owns the dispatched hop; a sent id only guards against a stale or misdirected call. */
const FOCUS_NODE_ID_DESCRIPTION =
  'Optional. Omit for the current hop; if sent, it must equal focus_node.id from <hop_context>.';

/** Reason-only removal of an irrelevant SQL node reached through a storage carrier. */
export const PruneCurrentInputSchema = z
  .object({
    focus_node_id: z
      .string()
      .min(1)
      .regex(/\S/)
      .optional()
      .meta({ toolValidated: 'prune.focus' })
      .describe(FOCUS_NODE_ID_DESCRIPTION),
    reason: z
      .string()
      .min(1)
      .regex(/\S/)
      .describe(
        'Why the whole current node is irrelevant to this investigation.',
      ),
  })
  .strict();

const COLUMN_FLOW_DESCRIPTION =
  'SQL-proved outputs related to the arriving columns in <current_task>, with their contributing neighbor columns. ' +
  'Reference only neighbors in <hop_context>. Not sources: row operations (TRUNCATE, DELETE); describe them in sections. [] when nothing feeds the arriving columns.';

/** Base flow grammar before hop-specific metadata admission; diagnostics reuse its structural certainty. */
export const ColumnFlowSchema = z
  .array(ColumnFlowEntrySchema)
  .describe(COLUMN_FLOW_DESCRIPTION);

/** Single source for the `sections` describe text, shared by the per-mode schemas and the participant union. */
const SECTIONS_DESCRIPTION =
  'Required for a fresh finding; on a revisit, omit angles saved on an earlier visit. An object keyed by angle, never a string: {"business": "…"} or {"technical": "…"}; only the classification\'s angle key(s). Each value is the section body per its capture recipe.';

/** Single source for the `summary` describe text, shared by the per-mode schemas and the participant union. */
const SUMMARY_DESCRIPTION =
  'Required. One sentence, readable without this hop: what this node does to the data and what it hands to which node.';

/** Shared `submit_findings` fields across BB and CT modes, one flat object. */
const HopFindingBaseSchema = z
  .object({
    focus_node_id: z.string().optional().describe(FOCUS_NODE_ID_DESCRIPTION),
    summary: z.string().optional().describe(SUMMARY_DESCRIPTION),
    badge_label: z
      .string()
      .max(SUBMIT_FINDINGS_BADGE_LABEL_MAX)
      .min(1)
      .regex(/\S/, 'badge_label must contain non-whitespace text')
      .optional()
      .describe(BADGE_LABEL_DESCRIPTION),
    prune_neighbors: z
      .array(PruneNeighborSchema)
      .max(MAX_ID_LIST_LENGTH)
      .optional()
      .describe(BB_PRUNE_NEIGHBORS_DESCRIPTION),
    questions: z
      .array(NeighborQuestionSchema)
      .max(MAX_ID_LIST_LENGTH)
      .optional()
      .describe(BB_QUESTIONS_DESCRIPTION),
    /** One string per fired `*_capture` template, keyed by angle. One key (`business` / `technical` classification) or two (`both`) — required for a fresh finding. Declared last: a model emits arguments in schema order, so the long prose closes the object after every short field. */
    sections: CapturedSectionsSchema.optional().describe(SECTIONS_DESCRIPTION),
  })
  .strict();

const { sections, summary, badge_label, prune_neighbors } =
  HopFindingBaseSchema.shape;

/** CT base requires `column_flow` for composed admission. Keep it after `focus_node_id`, before long capture prose. */
const HopFindingCtBaseSchema = HopFindingBaseSchema.omit({
  sections: true,
  summary: true,
  badge_label: true,
  prune_neighbors: true,
  questions: true,
})
  .extend({
    column_flow: ColumnFlowSchema,
    summary,
    badge_label,
    prune_neighbors: prune_neighbors.describe(PRUNE_NEIGHBORS_DESCRIPTION),
    questions: z
      .array(CtNeighborQuestionSchema)
      .max(MAX_ID_LIST_LENGTH)
      .optional()
      .describe(QUESTIONS_DESCRIPTION),
    sections,
  })
  .strict();

/** The flat, wire-shaped `submit_findings` payload once shape- and classification-validated — `sections` still keyed by angle, before {@link toHopFinding} converts it to the engine's internal union. This is what {@link submitFindingsSchemaForMode} itself parses to: the schema is a validator only, so parsing an already-valid `FlatSubmitFindings` a second time is a no-op. */
type FlatSubmitFindings = z.output<typeof HopFindingBaseSchema> & {
  column_flow?: z.output<typeof ColumnFlowSchema>;
};

const FINDING_DECISION_FIELDS = [
  'questions',
  'prune_neighbors',
  'column_flow',
] as const;

/** Native facts distinguish an undeclared field from a missing or invalid applicable field. */
export function findingAdmissionFacts(schema: z.ZodType) {
  if (!(schema instanceof z.ZodObject))
    throw new Error('Finding admission requires its object schema.');
  const fields: Partial<
    Pick<HopFindingKept, (typeof FINDING_DECISION_FIELDS)[number]>
  > = {};
  const valid = new Set<string>();
  const headers = new Map<
    string,
    Pick<ColumnFlowEntry, 'out_col' | 'out_node'>
  >();
  const columns = new Map<string, string>(),
    outColumns = new Map<string, string>();
  const suppliers = new Map<
    string,
    ColumnFlowEntry['upstream_columns'][number]
  >();
  const references = new Map<string, string>(),
    identities = new Map<string, string>(),
    arrays = new Map<string, number>(),
    rows = new Map<string, ReadonlySet<string>>();
  let supplied: Record<string, unknown> | undefined;
  const facts: ToolFactContext = {
    objects: new Map([
      [
        'findingPresence',
        (value) => {
          supplied = value;
        },
      ],
      [
        'flowPresence',
        (value, context) => {
          rows.set(context.instancePath, new Set(Object.keys(value)));
        },
      ],
    ]),
    arrays: new Map(
      ['column_flow', 'suppliers', 'questions', 'prune_neighbors'].map(
        (name) => [
          name,
          (value, context) => {
            arrays.set(context.instancePath, value.length);
          },
        ],
      ),
    ),
    strings: new Map([
      [
        'flowOutColumn',
        (value, context) => {
          outColumns.set(context.instancePath, value);
        },
      ],
      [
        'flowReference',
        (value, context) => {
          references.set(context.instancePath, value);
        },
      ],
      [
        'supplierColumn',
        (value, context) => {
          columns.set(context.instancePath, value);
        },
      ],
      ...['questionIdentity', 'pruneIdentity'].map(
        (name) =>
          [
            name,
            (value: string, context: { instancePath: string }) => {
              identities.set(context.instancePath, value);
            },
          ] as const,
      ),
    ]),
    validated: new Map([
      [
        'flowHeader',
        captureToolFact(
          ColumnFlowEntrySchema.omit({ upstream_columns: true }),
          (value, path) => {
            headers.set(path, value);
          },
        ),
      ],
      [
        'supplier',
        captureToolFact(ColumnRefSchema, (value, path) => {
          suppliers.set(path, value);
        }),
      ],
      [
        'questions',
        captureToolFact(HopFindingCtBaseSchema.shape.questions, (value) => {
          fields.questions = value;
          valid.add('questions');
        }),
      ],
      [
        'prune_neighbors',
        captureToolFact(HopFindingBaseSchema.shape.prune_neighbors, (value) => {
          fields.prune_neighbors = value;
          valid.add('prune_neighbors');
        }),
      ],
      [
        'column_flow',
        captureToolFact(ColumnFlowSchema, (value) => {
          fields.column_flow = value;
          valid.add('column_flow');
        }),
      ],
    ]),
  };
  return {
    facts,
    fields,
    headers,
    columns,
    outColumns,
    suppliers,
    references,
    identities,
    arrays,
    rows,
    unavailable: () =>
      new Set<keyof HopFindingKept>(
        FINDING_DECISION_FIELDS.filter(
          (field) =>
            Object.prototype.hasOwnProperty.call(schema.shape, field) &&
            (!supplied ||
              (!valid.has(field) &&
                (Object.prototype.hasOwnProperty.call(supplied, field) ||
                  !schema.shape[field].isOptional()))),
        ),
      ),
  };
}

/** Enforces the fresh kept shape of one flat `submit_findings` payload. */
function refineSubmitFindingsShape(
  value: FlatSubmitFindings,
  ctx: z.RefinementCtx,
  fresh: boolean,
  classification?: ClassificationValue,
): void {
  for (const error of findingShapeIssues(value, fresh, classification))
    ctx.addIssue({
      code: 'custom',
      path: error.path.split('.'),
      params: { issue: error.code },
    });
}

/** Converts a validated flat `submit_findings` payload to the {@link HopFinding} union the engine consumes. */
export function toHopFinding(value: FlatSubmitFindings): HopFindingKept {
  const kept: HopFindingKept = {
    focus_node_id: value.focus_node_id,
    sections: extractRawSectionAngles(value.sections ?? {}),
    summary: value.summary ?? '',
  };
  if (value.badge_label !== undefined) kept.badge_label = value.badge_label;
  if (value.prune_neighbors !== undefined)
    kept.prune_neighbors = value.prune_neighbors;
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
  const keptAngles = classification
    ? CLASSIFICATION_KEPT_ANGLES[classification]
    : undefined;
  const source = fresh
    ? schema
        .extend({
          sections: schema.shape.sections
            .unwrap()
            .meta({
              toolDisplay: keptAngles
                ? { required: [...keptAngles] }
                : {
                    anyOf: CLASSIFICATION_KEPT_ANGLES.both.map((angle) => ({
                      required: [angle],
                    })),
                  },
            })
            .optional()
            .describe(schema.shape.sections.description ?? ''),
        })
        .strict()
    : // Composition already supplied held values; archived sections may stay omitted, but every committed finding needs its summary.
      schema.safeExtend({
        summary: schema.shape.summary
          .unwrap()
          .regex(/\S/, 'A finding summary must contain non-whitespace text.')
          .describe(schema.shape.summary.description ?? ''),
      });
  const declared = source.safeExtend(
    Object.fromEntries(
      Object.entries(source.shape).map(([name, field]) => [
        name,
        FINDING_DECISION_FIELDS.some((decision) => decision === name)
          ? field.meta({
              ...field.meta(),
              toolValidated: name,
              toolArrayFact: name,
            })
          : field,
      ]),
    ),
  );
  const validated = declared
    .meta({
      toolFindingShape: { fresh, classification },
      toolObjectFact: 'findingPresence',
    })
    .describe(
      'A sent questions or prune_neighbors list replaces its held list whole; repeat entries you keep. Omit the list to retain it; [] withdraws it.',
    ) as z.ZodType<FlatSubmitFindings>;
  if (!fresh) return validated;
  const required = Object.entries(schema.shape)
    .filter(([, field]) => !field.isOptional())
    .map(([key]) => key);
  return validated.meta({
    toolFindingShape: { fresh, classification },
    toolObjectFact: 'findingPresence',
    required: [...required, 'summary', 'sections'],
  });
}

/** BB-mode submit_findings input. */
export const SubmitFindingsBbInputSchema = finalizeSubmitFindingsSchema(
  HopFindingBaseSchema,
  true,
);

/** CT-mode submit_findings input. */
export const SubmitFindingsCtInputSchema = finalizeSubmitFindingsSchema(
  HopFindingCtBaseSchema,
  true,
);

/** Number of per-hop findings schemas the cache keeps. */
const SUBMIT_FINDINGS_SCHEMA_CACHE_LIMIT = 16;

/** Memoized per (mode, classification, hop) narrowed `submit_findings` schemas built by {@link submitFindingsSchemaForMode}; beyond {@link SUBMIT_FINDINGS_SCHEMA_CACHE_LIMIT} entries the oldest is evicted so finished hops are not kept for the life of the host. */
const submitFindingsSchemaCache = new Map<
  string,
  z.ZodType<FlatSubmitFindings>
>();

/** Narrows {@link CapturedSectionsSchema} to the angle key(s) a locked classification keeps ({@link CLASSIFICATION_KEPT_ANGLES}). */
function capturedSectionSchemaForClassification(
  classification: ClassificationValue,
): z.ZodType<CapturedSectionsWire> {
  const kept = CLASSIFICATION_KEPT_ANGLES[classification];
  if (kept.length === CLASSIFICATION_KEPT_ANGLES.both.length) {
    const plainBody = nonWhitespaceText.optional();
    return z.strictObject({ business: plainBody, technical: plainBody });
  }
  const [onlyAngle] = kept;
  const offAngle = onlyAngle === 'business' ? 'technical' : 'business';
  const body = nonWhitespaceText
    .optional()
    .describe(
      `The only angle classification=${classification} keeps; fold any ${offAngle} content into this key — a separate "${offAngle}" key is rejected.`,
    );
  return z.strictObject({
    [onlyAngle]: body,
  }) as unknown as z.ZodType<CapturedSectionsWire>;
}

/** Backend-owned neighbor and column choices that narrow the served hop schema. */
export interface SubmitFindingsHopColumns {
  /** Focus node id of the current hop, admitting only equivalent metadata spellings when sent. */
  readonly focusNodeId?: string;
  /** Backend-owned current-hop neighbors, including closed evidence-only neighbors. */
  readonly neighbors?: readonly {
    readonly id: string;
    readonly can_question: boolean;
    readonly can_prune: boolean;
  }[];
  readonly outCols: readonly string[] | null;
  /** A procedure focus: each entry names the `out_node` it writes. */
  readonly outNode: boolean;
  /** Exact qualified destinations already named by current tasks; node and column choices stay paired. */
  readonly columnDestinations?: readonly {
    readonly node: string;
    readonly col: string;
  }[];
  readonly identifierCaseSensitive?: boolean;
  /** Neighboring functions eligible for an explicit current-caller output investigation. */
  readonly callerContextNodeIds?: readonly string[];
  /** Sorted ids the loaded store metadata admits as `upstream_columns` sources and `out_node` values: focus neighbors (and read suppliers of its declared scalar callers) that carry stored columns or are trusted without column metadata (procedure, external, function). A columnless function also stays eligible in `questions` via {@link SubmitFindingsHopColumns.callerContextNodeIds}. */
  readonly columnSourceNodeIds?: readonly string[];
}

/** The served and canonical enums share declared names; ModelPort normalizes equivalent SQL spellings first. */
function suppliedValueSchema(
  values: readonly string[],
  identifierCaseSensitive = false,
) {
  if (values.length === 0) return z.never();
  const field = z
    .string()
    .meta({ enum: [...values], toolIdentifier: { issue: 'unknown_column' } });
  markColumnField(field, values, identifierCaseSensitive);
  return field;
}

/** Offers canonical IDs while admitting only equivalent, unambiguous metadata spellings. */
function objectIdSchema(
  ids: readonly string[],
  identifierCaseSensitive = false,
  issue?: 'not_neighbor' | 'prune_target',
  closedIds: readonly string[] = [],
) {
  if (ids.length === 0 && closedIds.length === 0)
    return z.never().meta({ toolAdmission: { toolIssue: issue ?? 'never' } });
  const known = new Map([...ids, ...closedIds].map((id) => [id, true]));
  const field = z.string().meta({
    ...(ids.length ? { enum: [...ids] } : {}),
    toolIdentifier: {
      kind: 'object',
      values: [...ids],
      ...(closedIds.length ? { closedValues: [...closedIds] } : {}),
      caseSensitive: identifierCaseSensitive,
      issue: issue ?? 'not_neighbor',
    },
  });
  markObjectIdField(field, known, identifierCaseSensitive);
  return field;
}

function spellingField(
  ids: readonly string[],
  identifierCaseSensitive = false,
) {
  const field = z.string().meta({ toolDisplay: { enum: [...ids] } });
  markObjectIdField(
    field,
    new Map(ids.map((id) => [id, true])),
    identifierCaseSensitive,
  );
  return field;
}
const FLOW_HEADER_FACT = {
  toolObjectFact: 'flowPresence',
  toolGroups: [{ name: 'flowHeader', fields: ['out_col', 'out_node'] }],
};

/** The same supplier owner is used by full submissions and held tuple corrections. */
function columnRefSchemaForHop(hop: SubmitFindingsHopColumns) {
  return hop.columnSourceNodeIds
    ? ColumnRefSchema.extend({
        node: stringFact(
          objectIdSchema(hop.columnSourceNodeIds, hop.identifierCaseSensitive),
          'flowReference',
        ),
      })
        .strict()
        .meta(SUPPLIER_FACT)
    : ColumnRefSchema;
}

/** Projects {@link ColumnFlowSchema} onto one hop: declared output columns and the permitted pair endpoints. */
function columnFlowSchemaForHop(hop: SubmitFindingsHopColumns) {
  const outNodes = hop.columnSourceNodeIds?.filter(
    (id) => id !== hop.focusNodeId,
  );
  const outCol = !hop.outCols?.length
    ? ColumnFlowEntrySchema.shape.out_col
    : suppliedValueSchema(hop.outCols, hop.identifierCaseSensitive).describe(
        OUT_COL_DESCRIPTION,
      );
  const upstreamColumns = (
    hop.columnSourceNodeIds
      ? z.array(columnRefSchemaForHop(hop)).meta({ toolArrayFact: 'suppliers' })
      : ColumnFlowEntrySchema.shape.upstream_columns
  ).describe(
    hop.outNode
      ? PROCEDURE_UPSTREAM_DESCRIPTION
      : (ColumnFlowEntrySchema.shape.upstream_columns.description ?? ''),
  );
  const shape = {
    out_col: stringFact(outCol, 'flowOutColumn'),
    upstream_columns: upstreamColumns,
    // Required at a procedure focus: omission would attribute the pair to the procedure node.
    out_node: (hop.columnSourceNodeIds
      ? stringFact(
          objectIdSchema(outNodes!, hop.identifierCaseSensitive),
          'flowReference',
        )
      : stringFact(z.string(), 'flowReference')
    ).describe(OUT_NODE_DESCRIPTION),
  };
  if (hop.columnDestinations?.length) {
    const ids = [
        ...new Set(hop.columnDestinations.map((target) => target.node)),
      ],
      cols = [...new Set(hop.columnDestinations.map((target) => target.col))];
    const assertions = {
      anyOf: hop.columnDestinations.map((target) => ({
        properties: {
          out_col: { enum: [target.col] },
          out_node: { enum: [target.node] },
        },
      })),
    };
    const entry = z
      .object({
        out_col: stringFact(
          suppliedValueSchema(cols, hop.identifierCaseSensitive),
          'flowOutColumn',
        ),
        out_node: stringFact(
          spellingField(ids, hop.identifierCaseSensitive),
          'flowReference',
        ).describe('Object id from <hop_context>.'),
        upstream_columns: shape.upstream_columns,
      })
      .strict()
      .meta({
        toolObjectFact: 'flowPresence',
        toolGroups: [
          { name: 'flowHeader', fields: ['out_col', 'out_node'], assertions },
        ],
        toolDisplay: { allOf: [assertions] },
      });
    return z
      .array(entry)
      .describe(
        'Identify dependencies from the supplied caller SQL and function body. List supported in-scope suppliers, or upstream_columns: [] when none can be recorded; retain known outside dependencies and unresolved evidence in sections.',
      );
  }
  const entry = (
    hop.outNode
      ? z.object(shape)
      : z.object({
          out_col: shape.out_col,
          upstream_columns: shape.upstream_columns,
        })
  )
    .strict()
    .meta(FLOW_HEADER_FACT);
  const flow = z.array(entry).describe(COLUMN_FLOW_DESCRIPTION);
  return hop.outCols?.length === 0 || (hop.outNode && outNodes?.length === 0)
    ? flow.max(0)
    : flow;
}

/** Shared full-field finding schema, served and admitted alike; held content composes before admission. */
export function submitFindingsSchemaForMode(
  mode: 'bb' | 'ct',
  classification?: ClassificationValue,
  freshSubmission = false,
  hop?: SubmitFindingsHopColumns,
): z.ZodType<FlatSubmitFindings> {
  const hopKey = hop ? JSON.stringify(hop) : '';
  if (!classification && !hopKey && freshSubmission) {
    return mode === 'ct'
      ? SubmitFindingsCtInputSchema
      : SubmitFindingsBbInputSchema;
  }
  const cacheKey = `${mode}:${classification ?? ''}:${freshSubmission}:${hopKey}`;
  const cached = submitFindingsSchemaCache.get(cacheKey);
  if (cached) return cached;
  let narrowed = (
    mode === 'ct' ? HopFindingCtBaseSchema : HopFindingBaseSchema
  ) as typeof HopFindingCtBaseSchema;
  if (hop?.focusNodeId) {
    const focusField = z
      .string()
      .optional()
      .describe(FOCUS_NODE_ID_DESCRIPTION);
    markObjectIdField(
      focusField,
      new Map([[hop.focusNodeId, true]]),
      hop.identifierCaseSensitive ?? false,
    );
    narrowed = narrowed
      .extend({ focus_node_id: focusField })
      .strict() as typeof HopFindingCtBaseSchema;
  }
  const questionIds =
    hop?.neighbors
      ?.filter((neighbor) => neighbor.can_question)
      .map((neighbor) => neighbor.id) ?? [];
  const closedQuestionIds =
    hop?.neighbors
      ?.filter((neighbor) => !neighbor.can_question)
      .map((neighbor) => neighbor.id) ?? [];
  const baseQuestion = hop?.neighbors
    ? NeighborQuestionSchema.extend({
        nodeId: stringFact(
          objectIdSchema(
            questionIds,
            hop.identifierCaseSensitive,
            'not_neighbor',
            closedQuestionIds,
          ),
          'questionIdentity',
        ).describe(NeighborQuestionSchema.shape.nodeId.description ?? ''),
      })
    : NeighborQuestionSchema;
  if (mode === 'ct' && hop)
    narrowed = narrowed
      .extend({ column_flow: columnFlowSchemaForHop(hop) })
      .strict() as typeof HopFindingCtBaseSchema;
  const prunableIds =
    hop?.neighbors?.filter((n) => n.can_prune).map((n) => n.id) ?? [];
  if (hop?.neighbors)
    narrowed = narrowed
      .extend({
        prune_neighbors: (prunableIds.length
          ? z
              .array(
                PruneNeighborSchema.extend({
                  id: stringFact(
                    objectIdSchema(
                      prunableIds,
                      hop.identifierCaseSensitive,
                      'prune_target',
                    ),
                    'pruneIdentity',
                  ).describe(PruneNeighborSchema.shape.id.description ?? ''),
                }),
              )
              .max(MAX_ID_LIST_LENGTH)
          : z.array(PruneNeighborSchema).max(0)
        )
          .optional()
          .describe(
            mode === 'bb'
              ? BB_PRUNE_NEIGHBORS_DESCRIPTION
              : PRUNE_NEIGHBORS_DESCRIPTION,
          ),
        questions: z
          .array(baseQuestion)
          .max(questionIds.length ? MAX_ID_LIST_LENGTH : 0)
          .optional()
          .describe(
            mode === 'bb' ? BB_QUESTIONS_DESCRIPTION : QUESTIONS_DESCRIPTION,
          ),
      })
      .strict() as typeof HopFindingCtBaseSchema;
  if (mode === 'ct' && hop?.callerContextNodeIds) {
    const [first, ...rest] = hop.callerContextNodeIds;
    // The caller is the focus: its equivalent spellings bind to the focus id without serving another choice.
    const callerNode = z.string().min(1);
    if (hop.focusNodeId)
      markObjectIdField(
        callerNode,
        new Map([[hop.focusNodeId, true]]),
        hop.identifierCaseSensitive ?? false,
      );
    const callerIds = first === undefined ? [] : [first, ...rest];
    const neighborIds = questionIds;
    const nodeIds = [...new Set([...neighborIds, ...callerIds])];
    const assertions = {
      anyOf: [
        {
          properties: { nodeId: { enum: neighborIds }, question: {} },
          additionalProperties: false,
        },
        { properties: { nodeId: { enum: callerIds } } },
      ],
    };
    const question =
      first === undefined
        ? baseQuestion
        : CtNeighborQuestionSchema.extend({
            nodeId: stringFact(
              spellingField(nodeIds, hop.identifierCaseSensitive),
              'questionIdentity',
            ).describe(NeighborQuestionSchema.shape.nodeId.description ?? ''),
            caller_context: z
              .object({ node: callerNode, col: z.string().min(1) })
              .strict()
              .optional()
              .describe(
                CtNeighborQuestionSchema.shape.caller_context.description ?? '',
              ),
          })
            .strict()
            .meta({ toolDisplay: { allOf: [assertions] } });
    narrowed = narrowed
      .extend({
        questions: z
          .array(question)
          .max(hop.neighbors && !nodeIds.length ? 0 : MAX_ID_LIST_LENGTH)
          .optional()
          .describe(QUESTIONS_DESCRIPTION),
      })
      .strict() as typeof HopFindingCtBaseSchema;
  }
  if (classification) {
    const kept = CLASSIFICATION_KEPT_ANGLES[classification];
    const sectionsDescribe =
      (freshSubmission
        ? 'Required. '
        : 'Required for a fresh finding; on a revisit, omit angles saved on an earlier visit. ') +
      (kept.length === CLASSIFICATION_KEPT_ANGLES.both.length
        ? 'Pre-formatted section body for the `business` and `technical` recipes, under keys `business` and `technical`.'
        : `Pre-formatted section body for the \`${kept[0]}\` recipe, under key \`${kept[0]}\`.`);
    const narrowedSections = capturedSectionSchemaForClassification(
      classification,
    )
      .optional()
      .describe(sectionsDescribe);
    narrowed = narrowed
      .extend({ sections: narrowedSections })
      .strict() as typeof HopFindingCtBaseSchema;
  } else if (!freshSubmission) {
    narrowed = narrowed
      .extend({
        sections: narrowed.shape.sections.describe(SECTIONS_DESCRIPTION),
      })
      .strict() as typeof HopFindingCtBaseSchema;
  }
  const schema = finalizeSubmitFindingsSchema(
    narrowed,
    freshSubmission,
    classification,
  );
  if (submitFindingsSchemaCache.size >= SUBMIT_FINDINGS_SCHEMA_CACHE_LIMIT)
    submitFindingsSchemaCache.delete([...submitFindingsSchemaCache.keys()][0]);
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
  const angles = classification
    ? CLASSIFICATION_KEPT_ANGLES[classification]
    : CLASSIFICATION_KEPT_ANGLES.both;
  const section = z
    .object({ angle: z.enum(angles), text: nonWhitespaceText })
    .strict();
  const flow = hop ? columnFlowSchemaForHop(hop) : ColumnFlowSchema;
  return base
    .extend({
      summary: HopFindingBaseSchema.shape.summary.unwrap(),
      sections: z.array(section),
      ...(mode === 'ct'
        ? { column_flow: requireColumnFlow ? flow : flow.optional() }
        : {}),
    })
    .strict()
    .superRefine((value, ctx) => {
      const seen = new Set<string>();
      value.sections.forEach((entry, index) => {
        if (seen.has(entry.angle))
          ctx.addIssue({
            code: 'custom',
            path: ['sections', index, 'angle'],
            message: 'Each capture angle occurs once.',
            params: { issue: 'duplicate' },
          });
        seen.add(entry.angle);
      });
      refineSubmitFindingsShape(
        {
          ...value,
          sections: Object.fromEntries(
            value.sections.map((entry) => [entry.angle, entry.text]),
          ),
        } as FlatSubmitFindings,
        ctx,
        freshSubmission,
        classification,
      );
    });
}

/** Validates restorable held findings using the same fields as commit, without requiring resent CT flow. */
export function heldHopFindingSchemaForMode(mode: 'bb' | 'ct') {
  return internalKeptFindingSchema(mode, undefined, false, undefined, false);
}

/** Zod schema for `get_neighbor_columns` tool input. */
export const GetNeighborColumnsInputSchema = z
  .object({
    ids: z
      .array(z.string().min(1))
      .min(1)
      .describe('Neighbor ids, not the focus.'),
  })
  .strict();

/** `lineage_get_context` takes no input. */
export const GetContextInputSchema = z.object({}).strict();

/** Optional page cursor: the `next_cursor` of the previous result, echoed unchanged to read the next page. */
const CursorSchema = z
  .string()
  .regex(
    /^\d+$/,
    'cursor must be the next_cursor value of the previous result, unchanged',
  )
  .describe(
    'Page cursor: the next_cursor of the previous result, sent unchanged to read the next page of the same list. Omit for the first page.',
  );

/** `lineage_get_screen_state` input: no field returns the screen card; `ids` or `filter` recalls the stored run. */
export const GetScreenStateInputSchema = z
  .object({
    ids: z
      .array(z.string())
      .min(1)
      .max(SCREEN_STATE_MAX_IDS)
      .optional()
      .describe(
        "Canonical object ids to recall from the stored run, taken from the screen card's node_ids. Use without filter.",
      ),
    filter: z
      .enum(['pruned', 'open_leads', 'stale'])
      .optional()
      .describe(
        'One class of the stored run to list: pruned, open_leads, or stale. Use without ids.',
      ),
    cursor: CursorSchema.optional(),
  })
  .strict()
  .meta({
    toolAdmission: {
      if: { required: ['ids', 'filter'] },
      then: { properties: { filter: false } },
    },
  });

/** `lineage_search_objects` input. */
export const SearchObjectsInputSchema = z
  .object({
    query: z
      .string()
      .describe(
        "In substring mode: any part of an object or column name, without a schema prefix like '[dbo].'. In regex mode: the pattern, used verbatim. May be empty ONLY together with schemas[] to list everything in those schemas.",
      ),
    types: z
      .array(z.enum(['table', 'view', 'procedure', 'function', 'external']))
      .optional()
      .describe('Optional object-type filter.'),
    schemas: z
      .array(z.string())
      .optional()
      .describe(
        'Optional schema-name filter; combine with a zero-length query to list objects in those schemas.',
      ),
    mode: z
      .enum(['substring', 'regex'])
      .optional()
      .describe(
        'Name matching strategy: "substring" (default) or "regex" (case-insensitive, matched against name and schema.name).',
      ),
    cursor: CursorSchema.optional(),
  })
  .strict();
markIdFormSearch(SearchObjectsInputSchema);

/** `lineage_get_object_detail` input. */
export const GetObjectDetailInputSchema = z
  .object({
    id: z
      .string()
      .meta({ toolStringFact: 'modelObject' })
      .describe(
        'Canonical object ID returned by a lineage search or scope tool.',
      ),
    cursor: CursorSchema.optional(),
  })
  .strict();

/** `lineage_detect_graph_patterns` input. */
export const DetectGraphPatternsInputSchema = z
  .object({
    type: z
      .enum([
        'hubs',
        'islands',
        'orphans',
        'longest-path',
        'cycles',
        'external-refs',
      ])
      .describe('Structural graph pattern to detect.'),
    min_degree: z
      .number()
      .optional()
      .describe('Minimum node degree for hub detection.'),
    max_size: z
      .number()
      .optional()
      .describe(
        'Maximum nodes per island component (islands only); capped by the graph node limit. Omit to use the configured island-size limit.',
      ),
  })
  .strict();

/** `lineage_search_ddl` input. */
export const SearchDdlInputSchema = z
  .object({
    query: z
      .string()
      .describe(
        'Regular expression against SQL body text; case-insensitive; `^` and `$` match per line.',
      ),
    types: z
      .array(z.enum(['view', 'procedure', 'function']))
      .optional()
      .describe('Optional body-type filter; omit to search all three.'),
  })
  .strict();

/** A non-empty `sections` list with unique labels: the one bound every stage's section array shares. */
function sectionList<T extends z.ZodType<{ label: string }>>(item: T) {
  return nonemptyList(item).meta({ toolUniqueLabels: true });
}

/** Keep array bounds on arrays: malformed JSON may have a nonnumeric `length` member. */
function nonemptyList<T extends z.ZodType>(item: T) {
  return z.array(item).min(1);
}

/** The Lineage color-scheme enum shared by every colored surface. Declared once so render paths cannot drift: flow-role schemes (`source` / `transform` / `target`) plus status schemes (`good` / `warn` / `fail`). */
const HighlightSchemeSchema = z.enum([
  'source',
  'transform',
  'target',
  'good',
  'warn',
  'fail',
]);

/** One model-supplied node id, preserved verbatim and required non-empty. */
const NodeIdSchema = z
  .string()
  .regex(/\S/, 'Node ID must not be blank.')
  .min(1, 'Node ID must not be blank.')
  .meta({ toolValidated: 'report.node' });

/** One below-node caption. Its keys share nothing with a `sections[]` item's `{label, node_ids, text}`, so `.strict()` names the offending keys when the two are conflated. */
const NoteSchema = z
  .object({
    node_id: NodeIdSchema.meta({ toolValidated: 'report.node' }).describe(
      'Node ID the caption sits below.',
    ),
    caption: z
      .string()
      .regex(/\S/, 'Must contain non-whitespace text.')
      .min(1, 'Note is missing its caption')
      .describe(
        'One-sentence caption, grounded in the evidence supplied for this stage.',
      ),
  })
  .strict();

/** `present_result.notes`: an array of declared-key objects, the one object shape every function-calling schema dialect expresses — a map keyed by data (`additionalProperties` with a value schema) is not portable across providers. The parsed value is the shape every consumer reads, so a held draft re-validates unchanged. A node ID given two different captions rejects, since one of them would otherwise be lost; an identical repeat is harmless. */
const notesListSchema = (note: z.ZodType<z.infer<typeof NoteSchema>>) =>
  z
    .array(note)
    .meta({ toolNoteCaptions: true })
    .describe('Below-node captions, one per node.');
const NotesModelSchema = notesListSchema(NoteSchema);

/** Schema for a visual highlight group, grouping nodes by a shared role or status. */
const HighlightGroupSchema = z
  .object({
    label: z
      .string()
      .regex(/\S/, 'Must contain non-whitespace text.')
      .min(1, 'Group label is required')
      .max(60)
      .describe(
        'Short legend label describing the shared graph role or status; length target: see the `highlights` output template.',
      ),
    color: HighlightSchemeSchema.describe(
      "Flow role or status. `source`: the deepest origins whose data feeds the answer. `target`: where the data lands — the queried object in an upstream trace. `transform`: nodes that create or change the answer's values. `good` / `warn` / `fail`: diagnostic status. One scheme per result.",
    ),
    node_ids: z
      .array(NodeIdSchema)
      .describe('Node IDs that share this graph role or status.'),
  })
  .strict();

/** One final report section: a label that becomes both the section heading and the graph badge, the nodes it explains, and its detail body. */
const PresentResultSectionSchema = z
  .object(
    {
      label: z
        .string()
        .meta({ toolValidated: 'report.label' })
        .regex(/\S/, 'Section label must not be blank.')
        .min(
          1,
          'Section label is required — provide a short final label for this detail section',
        )
        .describe(
          "What the section's nodes share, as heading and badge (30 chars). No object names. Unique after trimming, whitespace collapse and lowercasing.",
        ),
      node_ids: z
        .array(NodeIdSchema)
        .meta({ toolValidated: 'report.sectionNodes' })
        .describe(
          'Nodes this section documents; put each node in one section. Empty array when it documents none.',
        ),
      text: z
        .string()
        .regex(/\S/, 'Must contain non-whitespace text.')
        .min(
          1,
          'Section is missing text — every final section label requires one detail body',
        )
        .meta({ toolValidated: 'report.text' })
        .describe('Required detail body for this section label.'),
    },
    {
      error: (issue) =>
        issue.code === 'unrecognized_keys'
          ? 'A section holds only label, node_ids and text. Below-node captions go in the top-level notes array as {node_id, caption} objects, never inside a section.'
          : undefined,
    },
  )
  .strict()
  .meta({
    toolValidated: 'report.section',
    toolObjectFact: 'report.sectionInput',
  });

/** Memoized per block count: a fresh schema per request is a new identity, which defeats `toModelJsonSchema`'s cache. */
const previewSchemaCache = new Map<
  number,
  ReturnType<typeof buildPreviewSchemas>
>();

/** The preview stage schemas for an answer of `blockCount` served blocks. A section is the {@link PresentResultSectionSchema} keys with the body given as the served id `B1`..`B<blockCount>` it starts at, so an id outside the answer cannot be sent; the engine ends each section before the next one's start. The patch form permits omission of `node_ids` and `start` to keep the held value under the label. Preview reuses the discovery prose for `summary`/`title`; the model authors `name` itself. */
function buildPreviewSchemas(blockCount: number) {
  const [first, ...rest] = Array.from(
    { length: Math.max(blockCount, 1) },
    (_, index) => `B${index + 1}`,
  );
  const start = z
    .enum([first, ...rest])
    .meta({ toolValidated: 'report.start' })
    .describe(
      'First block of `answer_blocks` this section presents, e.g. "B3"; it runs to the block before the next section\'s start, the last section to the end. The first section starts at B1; starts ascend strictly.',
    );
  const section = z
    .object(
      {
        label: PresentResultSectionSchema.shape.label,
        node_ids: PresentResultSectionSchema.shape.node_ids,
        start,
      },
      {
        error: (issue) =>
          issue.code === 'unrecognized_keys'
            ? 'A section holds only label, node_ids and start. Below-node captions go in the top-level notes array as {node_id, caption} objects, never inside a section.'
            : undefined,
      },
    )
    .strict()
    .meta({
      toolValidated: 'report.section',
      toolObjectFact: 'report.sectionInput',
    });
  const model = PresentResultModelSchema.omit({
    summary: true,
    title: true,
    intro: true,
    closing: true,
    prune_node_ids: true,
    add_node_ids: true,
    is_update: true,
  })
    .extend({
      sections: sectionList(section).describe(
        "Required report sections, at least one. Each names the block of the served `answer_blocks` it starts at; every node analysed and captured is linked into a section's node_ids.",
      ),
    })
    .strict();
  return { model, section };
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
export const PresentResultModelSchema = z
  .object({
    name: z
      .string()
      .regex(/\S/, 'Name must not be blank.')
      .min(1, 'name is required')
      .max(90)
      .describe(
        'Short name for the generated lineage view — aim for ~60 chars.',
      ),
    summary: z
      .string()
      .regex(/\S/, 'Must contain non-whitespace text.')
      .min(1, 'summary is required — one-line graph purpose (~120 chars)')
      .describe('One-line summary shown with the generated view.'),
    title: z.string().max(120).optional().describe('Optional report heading.'),
    intro: z
      .string()
      .optional()
      .describe('Optional grounded introduction to the final report.'),
    closing: z
      .string()
      .optional()
      .describe('Closing synthesis. Length is never a rejection axis.'),
    prune_node_ids: z
      .array(NodeIdSchema)
      .optional()
      .describe(
        'ONLY permitted during Completed Phase follow-ups. Strictly forbidden during the initial Synthesis Phase.',
      ),
    add_node_ids: z
      .array(NodeIdSchema)
      .optional()
      .describe(
        'ONLY permitted during Completed Phase follow-ups. Strictly forbidden during the initial Synthesis Phase.',
      ),
    layout_direction: z
      .enum(['LR', 'TB'])
      .optional()
      .describe('Graph layout: left-to-right or top-to-bottom.'),
    highlight_groups: nonemptyList(HighlightGroupSchema).describe(
      'REQUIRED, at least 1 group. For zero-trace or single-node results, use color "target" on the origin/result node.',
    ),
    sections: sectionList(PresentResultSectionSchema).describe(
      'Required final report sections, at least one. Every node analysed and captured this turn ' +
        "(anything with a detail slot) is linked into a section's node_ids, as that field describes — " +
        'an analysed node absent from every section fails validation.',
    ),
    notes: NotesModelSchema.optional(),
    is_update: z
      .boolean()
      .optional()
      .describe('True only when updating an existing presentation.'),
  })
  .strict();

/** One section of a report that is already committed: `text` and `node_ids` may each be omitted to keep the committed body or links under that label. */
const PresentResultRetainedSectionSchema = PresentResultSectionSchema.extend({
  node_ids: z
    .array(NodeIdSchema)
    .optional()
    .meta({ toolValidated: 'report.sectionNodes' })
    .describe(
      'Nodes this section documents; put each node in one section. Omit to keep the committed links for this label; an empty array unlinks them.',
    ),
  text: nonWhitespaceText
    .optional()
    .meta({ toolValidated: 'report.text' })
    .describe(
      'Detail body. Omit to keep the committed text for this label; supply it only to rewrite that section.',
    ),
}).meta({
  toolValidated: 'report.section',
  toolObjectFact: 'report.sectionInput',
});

/** Projects a `present_result` schema onto a render that amends a committed report. */
function withRetainableSections<
  T extends z.ZodObject<Record<string, z.ZodType>>,
>(schema: T) {
  return schema.extend({
    sections: sectionList(PresentResultRetainedSectionSchema)
      .optional()
      .describe(
        'Final report sections. Omit entirely to keep the committed report; list a label with no text to keep that section unchanged.',
      ),
  });
}

const reportAdmissionSchemas = new WeakMap<z.ZodType, z.ZodType>();
function reportAdmissionSchema(
  schema: z.ZodObject<Record<string, z.ZodType>>,
): z.ZodType {
  const cached = reportAdmissionSchemas.get(schema);
  if (cached) return cached;
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([name, field]) => [
      name,
      field.meta({
        ...field.meta(),
        toolValidated: ['title', 'intro', 'closing'].includes(name)
          ? [`report.${name}`, 'report.text']
          : `report.${name}`,
        ...(['sections', 'notes'].includes(name)
          ? { toolArrayFact: `report.${name}` }
          : {}),
      }),
    ]),
  );
  const annotated = schema
    .extend(shape)
    .meta({ toolObjectFact: 'report.input' });
  reportAdmissionSchemas.set(schema, annotated);
  return annotated;
}

/** Type witnesses share the declared row/field owners; only native-valid facts reach callbacks. */
const ReportSectionFactSchema = PresentResultSectionSchema.partial({
  node_ids: true,
  text: true,
}).extend({ start: z.string().optional() });
/** Schema witnesses for the typed facts emitted by every report phase. */
export const ReportFactSchemas = {
  fields: {
    ...PresentResultModelSchema.shape,
    sections: z.array(ReportSectionFactSchema),
  },
  section: ReportSectionFactSchema,
  node: NodeIdSchema,
  nodes: z.array(NodeIdSchema),
  text: z.string(),
  start: z.string(),
};

/** The full phase schema is unchanged during repair; held fields are applied before its single validation. */
export function presentResultSchemaForPhase(
  phase?: string,
  retainable = false,
  previewBlockCount = 0,
): z.ZodType {
  if (phase === 'visual_preview')
    return reportAdmissionSchema(previewSchemas(previewBlockCount).model);
  const synthesis = phase === 'synthesis';
  const schema = retainable
    ? synthesis
      ? PresentResultRetainingSynthesisModelSchema
      : PresentResultRetainingModelSchema
    : synthesis
      ? PresentResultSynthesisModelSchema
      : PresentResultModelSchema;
  return reportAdmissionSchema(schema);
}

/** Presentation fields named by deterministic validation errors. */
export type PresentResultRepairField = keyof z.infer<
  typeof PresentResultModelSchema
>;

/** Model-facing schema for a new synthesis render. */
const PresentResultSynthesisModelSchema = PresentResultModelSchema.omit({
  prune_node_ids: true,
  add_node_ids: true,
  is_update: true,
}).strict();

/** The stage projections a render that amends a committed report is offered and parsed against. */
const PresentResultRetainingModelSchema = withRetainableSections(
  PresentResultModelSchema,
);
const PresentResultRetainingSynthesisModelSchema = withRetainableSections(
  PresentResultSynthesisModelSchema,
);

/** Model-facing `lineage_submit_findings` input schema (the permissive BB∪CT superset). */
export const SubmitFindingsModelSchema = z
  .object({
    focus_node_id: z.string().optional().describe(FOCUS_NODE_ID_DESCRIPTION),
    summary: z.string().optional().describe(SUMMARY_DESCRIPTION),
    prune_neighbors: z
      .array(PruneNeighborSchema)
      .max(MAX_ID_LIST_LENGTH)
      .optional()
      .describe(PRUNE_NEIGHBORS_DESCRIPTION),
    questions: z
      .array(CtNeighborQuestionSchema)
      .max(MAX_ID_LIST_LENGTH)
      .optional()
      .describe(QUESTIONS_DESCRIPTION),
    column_flow: ColumnFlowSchema.optional(),
    badge_label: z
      .string()
      .max(SUBMIT_FINDINGS_BADGE_LABEL_MAX)
      .min(1)
      .regex(/\S/, 'badge_label must contain non-whitespace text')
      .optional()
      .describe(BADGE_LABEL_DESCRIPTION),
    sections: CapturedSectionsSchema.optional().describe(SECTIONS_DESCRIPTION),
  })
  .strict();

/** Validates a discovery-tool input against its Zod schema. */
export function parseToolInput<T extends z.ZodType>(
  schema: T,
  input: unknown,
):
  | { readonly ok: true; readonly data: z.output<T> }
  | { readonly ok: false; readonly error: ToolRejection } {
  const result = ingestToolInput({
    input,
    schema,
    context: '',
    inspect: (view) => {
      const parsed = view.parsed;
      return parsed.success
        ? () => ({ ok: true as const, data: parsed.data })
        : undefined;
    },
  });
  return 'ok' in result ? result : { ok: false, error: result };
}
