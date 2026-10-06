import { z } from 'zod';
import type { SmState } from './smTypes';
import { ColumnTransformClassSchema } from '../../engine/shared/bridgeContract';
import { bothSidesClosed } from '../../engine/shared/explorationDepthContract';
import { heldHopFindingSchemaForMode } from '../tools/toolSchemas';

/** Stable failure of the navigation-snapshot shape check; a live engine invariant reports through the engine's error status instead. */
export class InvalidEngineCheckpointError extends Error {
  /** Stable machine code exposed to the checkpoint caller. */
  public readonly code = 'invalid_engine_checkpoint' as const;
  /** Validation paths safe to include in debug output without checkpoint values. */
  public readonly issuePaths: readonly string[];
  /** Original parser failure retained for internal diagnostics. */
  public readonly cause: unknown;

  public constructor(issuePaths: readonly string[], options?: { readonly cause?: unknown }) {
    super('The saved exploration state is invalid or incompatible. Start a new analysis.');
    this.name = 'InvalidEngineCheckpointError';
    this.issuePaths = [...issuePaths];
    this.cause = options?.cause;
  }

  /** Safe debug detail containing paths only, never persisted checkpoint values. */
  public get diagnostic(): string {
    return this.issuePaths.length > 0 ? this.issuePaths.join(', ') : '(root)';
  }
}

const NonEmptyString = z.string().min(1);
const NonNegativeInt = z.number().int().nonnegative();
const NonEmptyStrings = z.array(NonEmptyString).min(1);
const NonEmptyStringTuple = z.tuple([NonEmptyString], NonEmptyString);

const DepthSideValueSchema = z.object({
  levels: z.union([z.number().int().nonnegative(), z.literal('all')]),
  exactness: z.enum(['exact', 'approximate']),
}).strict();

/** Current per-side depth record — required, both sides, no "unstated" side. */
const CurrentDepthIntentSchema = z.object({
  upstream: DepthSideValueSchema,
  downstream: DepthSideValueSchema,
}).strict().refine(intent => !bothSidesClosed(intent.upstream, intent.downstream), {
  message: 'Depth cannot be 0 in both directions.',
});

/**
 * Levels a pre-per-side checkpoint seeded for an unstated side: the mechanical default the retired
 * `lineage_start_exploration` depth contract declared for an omitted side (its schema text read
 * "Omitted/null defaults to 3"). Read-side only; a live call always states its own levels.
 */
const LEGACY_UNSTATED_DEPTH_LEVELS = 3;

/**
 * Pre-per-side checkpoint format, read tolerantly and mapped onto the current shape: a legacy
 * finite/`'all'` side maps to `exact`, a legacy unstated (`null`) side maps to `approximate` at
 * {@link LEGACY_UNSTATED_DEPTH_LEVELS}. An older init also wrote that default into an unstated
 * `asymmetric` side, which therefore reads back as `exact`; the checkpoint's own `depthLimits`
 * (`null` for such a side) still decide enforcement and how the depth is reported. This mapping
 * exists only for reading an old checkpoint; a live call always names `exactness` itself.
 */
const LegacyDepthIntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('explicit'), levels: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('full_frontier') }).strict(),
  z.object({
    kind: z.literal('asymmetric'),
    upstream: z.union([z.number().int().nonnegative(), z.literal('all')]).nullable(),
    downstream: z.union([z.number().int().nonnegative(), z.literal('all')]).nullable(),
  }).strict(),
  z.object({ kind: z.literal('default_start') }).strict(),
]).transform((legacy) => {
  const side = (value: number | 'all' | null | undefined): z.infer<typeof DepthSideValueSchema> =>
    value == null ? { levels: LEGACY_UNSTATED_DEPTH_LEVELS, exactness: 'approximate' } : { levels: value, exactness: 'exact' };
  switch (legacy.kind) {
    case 'explicit': return { upstream: side(legacy.levels), downstream: side(legacy.levels) };
    case 'full_frontier': return { upstream: side('all'), downstream: side('all') };
    case 'asymmetric': return { upstream: side(legacy.upstream), downstream: side(legacy.downstream) };
    case 'default_start': return { upstream: side(null), downstream: side(null) };
  }
});

const DepthIntentSchema = z.union([CurrentDepthIntentSchema, LegacyDepthIntentSchema]);

const ColumnEdgeSchema = z.object({
  hop_node: NonEmptyString,
  hop: NonNegativeInt,
  from_node: NonEmptyString,
  from_col: NonEmptyString,
  to_node: NonEmptyString,
  to_col: NonEmptyString,
  transforms: z.array(ColumnTransformClassSchema).optional(),
  note: z.string().optional(),
}).strict();

const ColumnAspectSchema = z.object({
  target_columns: NonEmptyStrings,
  active_columns: z.array(NonEmptyString),
  edges: z.array(ColumnEdgeSchema),
}).strict();

const NodeStateSchema = z.object({
  nodeId: NonEmptyString,
  action: z.enum(['analyze', 'passthrough', 'prune']),
  source: z.enum(['ai', 'engine', 'user']),
  reason: z.enum([
    'submitted_analyze',
    'submitted_passthrough',
    'submitted_prune',
    'bb_prune_neighbor',
    'user_pass_filter',
    'non_bodied_passthrough',
  ]),
  columns: z.array(NonEmptyString).optional(),
  columnRole: z.enum(['carrier', 'row_role_only']).optional(),
  viaNodeId: NonEmptyString.optional(),
  atHop: NonNegativeInt.optional(),
}).strict();

const DetailSlotSchema = z.object({
  nodeId: NonEmptyString,
  schema: z.string(),
  name: NonEmptyString,
  type: NonEmptyString,
  sections: z.array(z.object({ angle: z.enum(['business', 'technical']), text: NonEmptyString }).strict()),
  summary: z.string(),
  badge_label: NonEmptyString.optional(),
  reason_for_visit: NonEmptyString.optional(),
}).strict();

const MemorySnapshotSchema = z.object({
  userQuestion: z.string(),
  detailSlots: z.record(z.string(), DetailSlotSchema),
  slotCount: NonNegativeInt,
  missionBrief: z.string(),
  scopeNotes: z.array(z.string()).default([]),
  verdictCounts: z.object({
    analyze: NonNegativeInt,
    passthrough: NonNegativeInt,
    prune: NonNegativeInt,
  }).strict(),
  recentRejections: z.array(z.object({
    nodeId: NonEmptyString,
    reason: NonEmptyString,
    atHop: NonNegativeInt,
  }).strict()).max(5),
}).strict();

const BbTaskSchema = z.object({
  id: NonEmptyString,
  kind: z.enum(['root', 'analytical']),
  source: z.enum(['mission', 'model', 'engine']),
  question: z.string(),
  nodeId: NonEmptyString.optional(),
  parentTaskId: NonEmptyString.optional(),
  traversalSide: z.enum(['upstream', 'downstream']).optional(),
  status: z.enum(['pending', 'active', 'resolved', 'deferred']),
  createdHop: NonNegativeInt,
  resolvedHop: NonNegativeInt.optional(),
  callerContext: z.object({ node: NonEmptyString, col: NonEmptyString, callerTaskId: NonEmptyString, ddlHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
}).strict();

const ScalarReturnTargetSchema = z.object({ node: NonEmptyString, col: NonEmptyString }).strict();
const ScalarReturnTargetsSchema = z.array(ScalarReturnTargetSchema).min(1);

const CtTaskSchema = z.object({
  id: NonEmptyString,
  kind: z.literal('column_lineage'),
  source: z.enum(['mission', 'model', 'engine']),
  question: z.string(),
  nodeId: NonEmptyString.optional(),
  parentTaskId: NonEmptyString.optional(),
  traversalSide: z.enum(['upstream', 'downstream']).optional(),
  activeColumns: NonEmptyStringTuple,
  sourceRefs: z.array(ScalarReturnTargetSchema).min(1).optional(),
  returnTargets: ScalarReturnTargetsSchema.optional(),
  status: z.enum(['pending', 'active', 'resolved', 'deferred']),
  createdHop: NonNegativeInt,
  resolvedHop: NonNegativeInt.optional(),
  callerContext: z.object({ node: NonEmptyString, col: NonEmptyString, callerTaskId: NonEmptyString, ddlHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
}).strict();

const InvestigationTaskSchema = z.discriminatedUnion('kind', [BbTaskSchema, CtTaskSchema]);

const PendingLeadSchema = z.object({
  id: NonEmptyString,
  taskId: NonEmptyString,
  nodeId: NonEmptyString,
  fromNodeId: NonEmptyString,
  reason: z.enum(['schema_boundary', 'depth_boundary', 'contracted_scope', 'budget', 'insufficient_evidence', 'out_of_direction', 'excluded', 'pruned_by_ai']),
  schema: z.string().optional(),
  depth: NonNegativeInt.optional(),
  valueToUser: NonEmptyString,
  status: z.enum(['pending', 'scheduled', 'resolved', 'dismissed']),
  createdHop: NonNegativeInt,
}).strict();

const InitSnapshotSchema = z.discriminatedUnion('analysisMode', [
  z.object({
    question: z.string(),
    origin: NonEmptyString,
    analysisMode: z.literal('bb'),
    direction: z.enum(['upstream', 'downstream', 'bidirectional']),
    depthIntent: DepthIntentSchema,
    mission_brief: z.string().optional(),
  }).strict(),
  z.object({
    question: z.string(),
    origin: NonEmptyString,
    analysisMode: z.literal('ct'),
    targetColumns: NonEmptyStringTuple,
    direction: z.enum(['upstream', 'downstream', 'bidirectional']),
    depthIntent: DepthIntentSchema,
    mission_brief: z.string().optional(),
  }).strict(),
]);

const ColumnCarrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('carry'), columns: z.array(NonEmptyString) }).strict(),
  z.object({ kind: z.literal('row_role_only') }).strict(),
  z.object({ kind: z.literal('scalar_return'), outputs: ScalarReturnTargetsSchema }).strict(),
]);

const AgendaEntrySchema = z.object({
  taskIds: NonEmptyStrings,
  nodeId: NonEmptyString,
  priority: NonNegativeInt,
  depth: NonNegativeInt,
  activeColumns: z.array(NonEmptyString).optional(),
  columnCarry: ColumnCarrySchema.optional(),
  lineageQuestions: NonEmptyStrings.optional(),
}).strict();

const EngineInternalsSchema = z.object({
  originNodeId: NonEmptyString.nullable(),
  direction: z.enum(['upstream', 'downstream', 'bidirectional']),
  depthBudget: NonNegativeInt.nullable(),
  depthEnforcement: z.enum(['strict', 'silent']),
  depthLimits: z.object({
    upstream: NonNegativeInt.nullable(),
    downstream: NonNegativeInt.nullable(),
  }).strict().optional(),
  depthFromOrigin: z.array(z.tuple([NonEmptyString, NonNegativeInt])),
  extendedDepthCap: NonNegativeInt.optional(),
  budgetExpansions: z.array(z.object({ nodeId: NonEmptyString, depth: NonNegativeInt, atHop: NonNegativeInt }).strict()),
  bodiedScopeSize: NonNegativeInt,
  totalNodes: NonNegativeInt,
  userSchemas: z.array(z.string()),
  sessionAllowedSchemas: z.array(z.string()),
  sessionAllowedNodeIds: z.array(NonEmptyString).optional(),
  excludedTypes: z.array(NonEmptyString),
  excludedSchemas: z.array(NonEmptyString),
  excludedNodeIds: z.array(NonEmptyString),
  guiHiddenTypes: z.array(NonEmptyString),
  passNodeIds: z.array(NonEmptyString),
  currentFocusQuestion: z.string().nullable(),
  currentFocusTaskIds: z.array(NonEmptyString),
  lastCurrentTask: z.string(),
  discoverySummary: z.string().nullable(),
  archiveChars: NonNegativeInt,
  qualityGuards: z.boolean().optional(),
  lastHopDetailChars: NonNegativeInt,
  lastHopSummaryChars: NonNegativeInt,
  lastHopVerdict: z.enum(['analyze', 'passthrough', 'prune']).nullable(),
  lastHopColumnFlowEntries: NonNegativeInt,
  lastRoutedNew: NonNegativeInt,
  lastRoutedRejected: NonNegativeInt,
  lastRoutedDeferred: NonNegativeInt,
  investigationTasks: z.array(InvestigationTaskSchema),
  pendingLeads: z.array(PendingLeadSchema),
  initSnapshot: InitSnapshotSchema.nullable(),
  continuationVersion: z.literal(1).optional(),
  supplementNodeIds: z.array(NonEmptyString).optional(),
  pruneBallots: z.array(z.object({ nodeId: NonEmptyString,
    votes: z.array(z.object({ senderId: NonEmptyString, vote: z.enum(['prune', 'keep']) }).strict()).min(1),
  }).strict()).optional(),
  heldFinding: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('bb'), focusId: NonEmptyString, hop: NonNegativeInt, failed: z.array(NonEmptyString), finding: heldHopFindingSchemaForMode('bb') }).strict(),
    z.object({ mode: z.literal('ct'), focusId: NonEmptyString, hop: NonNegativeInt, failed: z.array(NonEmptyString), finding: heldHopFindingSchemaForMode('ct') }).strict(),
  ]).nullable().optional(),
}).strict().transform(({
  qualityGuards: _legacyQualityGuards,
  extendedDepthCap: _legacyExtendedDepthCap,
  sessionAllowedNodeIds: _legacySessionAllowedNodeIds,
  ...internals
}) => internals);

/** Shape contract of the serialized NavigationEngine projection: the state dump and the saved run's snapshot. */
export const NavigationSnapshotSchema: z.ZodType<SmState> = z.object({
  snapshotVersion: z.union([z.literal(1), z.literal(2)]),
  identifierCaseSensitive: z.boolean().optional(),
  columnAspect: ColumnAspectSchema.nullable(),
  status: z.enum(['created', 'initialized', 'exploring', 'awaiting_findings', 'complete', 'error']),
  hopCount: NonNegativeInt,
  scopeSize: NonNegativeInt,
  scopeNodeIds: z.array(NonEmptyString),
  visited: z.array(NonEmptyString),
  removedSet: z.array(NonEmptyString),
  nodeStates: z.array(NodeStateSchema),
  agendaSize: NonNegativeInt,
  agenda: z.array(AgendaEntrySchema),
  currentFocusNodeId: NonEmptyString.nullable(),
  memory: MemorySnapshotSchema,
  engineInternals: EngineInternalsSchema,
  lineageQuestionsLastHop: z.array(NonEmptyString).optional(),
  ctPrunedNodeIds: z.array(NonEmptyString).optional(),
  ctDeclaredRouteIds: z.array(NonEmptyString).optional(),
  renderDroppedNodeIds: z.array(NonEmptyString).optional(),
}).strict();

/**
 * A strongly typed snapshot of an active NavigationEngine session.
 */
type NavigationSnapshot = z.infer<typeof NavigationSnapshotSchema>;

/**
 * Validates the engine's serialized projection against the persistence shape without repairing or
 * migrating it.
 *
 * @remarks
 * A version-1 projection never carries an agenda entry for an already visited node, so such an
 * entry is dropped and `agendaSize` follows.
 *
 * @param input - Serialized engine projection to validate.
 * @returns The strictly parsed navigation snapshot.
 * @throws {@link InvalidEngineCheckpointError} when `input` fails schema validation.
 */
export function parseNavigationSnapshot(input: unknown): NavigationSnapshot {
  const result = NavigationSnapshotSchema.safeParse(input);
  if (result.success) {
    if (result.data.snapshotVersion === 1) {
      const visited = new Set(result.data.visited);
      result.data.agenda = result.data.agenda.filter(a => !visited.has(a.nodeId));
      result.data.agendaSize = result.data.agenda.length;
    }
    return result.data;
  }
  const paths = Array.from(new Set(result.error.issues.map(issue => issue.path.join('.') || '(root)'))).slice(0, 3);
  throw new InvalidEngineCheckpointError(paths, { cause: result.error });
}
