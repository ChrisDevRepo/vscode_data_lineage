import { z } from 'zod';
import type { SmState } from './smTypes';

/** Stable restore failure raised only by the strict navigation-checkpoint boundary. */
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

const DepthIntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('explicit'), levels: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('full_frontier') }).strict(),
  // Per-side 0 is valid (a single-direction asymmetric proposal, e.g. {upstream:2,downstream:0});
  // both sides 0 is rejected, mirroring the boundary check in explorationDepthContract.ts.
  z.object({
    kind: z.literal('asymmetric'),
    upstream: z.union([z.number().int().nonnegative(), z.literal('all')]),
    downstream: z.union([z.number().int().nonnegative(), z.literal('all')]),
  }).strict().superRefine((data, ctx) => {
    if (data.upstream === 0 && data.downstream === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Asymmetric depth cannot be 0 in both directions.' });
    }
  }),
  z.object({ kind: z.literal('default_start') }).strict(),
]);

const ColumnEdgeSchema = z.object({
  hop_node: NonEmptyString,
  hop: NonNegativeInt,
  from_node: NonEmptyString,
  from_col: NonEmptyString,
  to_node: NonEmptyString,
  to_col: NonEmptyString,
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
  // Optional so a checkpoint written before scope notes existed still restores (tolerant read).
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
  status: z.enum(['pending', 'active', 'resolved', 'deferred']),
  createdHop: NonNegativeInt,
  resolvedHop: NonNegativeInt.optional(),
}).strict();

const CtTaskSchema = z.object({
  id: NonEmptyString,
  kind: z.literal('column_lineage'),
  source: z.enum(['mission', 'model', 'engine']),
  question: z.string(),
  nodeId: NonEmptyString.optional(),
  parentTaskId: NonEmptyString.optional(),
  activeColumns: NonEmptyStringTuple,
  status: z.enum(['pending', 'active', 'resolved', 'deferred']),
  createdHop: NonNegativeInt,
  resolvedHop: NonNegativeInt.optional(),
}).strict();

const InvestigationTaskSchema = z.discriminatedUnion('kind', [BbTaskSchema, CtTaskSchema]);

const PendingLeadSchema = z.object({
  id: NonEmptyString,
  taskId: NonEmptyString,
  nodeId: NonEmptyString,
  fromNodeId: NonEmptyString,
  reason: z.enum(['schema_boundary', 'depth_boundary', 'contracted_scope', 'budget', 'insufficient_evidence']),
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

const AgendaEntrySchema = z.object({
  taskIds: NonEmptyStrings,
  nodeId: NonEmptyString,
  priority: NonNegativeInt,
  depth: NonNegativeInt,
  activeColumns: NonEmptyStrings.optional(),
}).strict();

const EngineInternalsSchema = z.object({
  originNodeId: NonEmptyString.nullable(),
  direction: z.enum(['upstream', 'downstream', 'bidirectional']),
  depthBudget: NonNegativeInt.nullable(),
  depthEnforcement: z.enum(['strict', 'soft', 'silent']),
  // Per-side ceilings; `null` on a side means unbounded, since `Infinity` has no JSON form.
  // Absent in a v1 checkpoint, which restores to seed-only routing instead.
  depthLimits: z.object({
    upstream: NonNegativeInt.nullable(),
    downstream: NonNegativeInt.nullable(),
  }).strict().optional(),
  depthFromOrigin: z.array(z.tuple([NonEmptyString, NonNegativeInt])),
  extendedDepthCap: NonNegativeInt,
  budgetExpansions: z.array(z.object({ nodeId: NonEmptyString, depth: NonNegativeInt, atHop: NonNegativeInt }).strict()),
  bodiedScopeSize: NonNegativeInt,
  totalNodes: NonNegativeInt,
  userSchemas: z.array(z.string()),
  sessionAllowedSchemas: z.array(z.string()),
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
  // Accepted only for v1 checkpoint compatibility; transformed away before restore.
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
}).strict().transform(({ qualityGuards: _legacyQualityGuards, ...internals }) => internals);

/** Current fail-closed NavigationEngine persistence contract. */
const NavigationSnapshotSchema: z.ZodType<SmState> = z.object({
  snapshotVersion: z.literal(1),
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
}).strict().superRefine((snapshot, ctx) => {
  const issue = (message: string, path: Array<string | number>) => ctx.addIssue({ code: 'custom', message, path });
  const unique = (values: ReadonlyArray<string>, path: Array<string | number>) => {
    if (new Set(values).size !== values.length) issue('values must be unique', path);
  };

  if (snapshot.scopeSize !== snapshot.scopeNodeIds.length) issue('scopeSize must equal scopeNodeIds.length', ['scopeSize']);
  if (snapshot.agendaSize !== snapshot.agenda.length) issue('agendaSize must equal agenda.length', ['agendaSize']);
  if (snapshot.memory.slotCount !== Object.keys(snapshot.memory.detailSlots).length) issue('slotCount must equal detailSlots cardinality', ['memory', 'slotCount']);
  unique(snapshot.scopeNodeIds, ['scopeNodeIds']);
  unique(snapshot.visited, ['visited']);
  unique(snapshot.removedSet, ['removedSet']);
  unique(snapshot.nodeStates.map(state => state.nodeId), ['nodeStates']);
  unique(snapshot.engineInternals.investigationTasks.map(task => task.id), ['engineInternals', 'investigationTasks']);
  unique(snapshot.engineInternals.pendingLeads.map(lead => lead.id), ['engineInternals', 'pendingLeads']);

  const removed = new Set(snapshot.removedSet);
  const scope = new Set(snapshot.scopeNodeIds);
  const tasks = new Map(snapshot.engineInternals.investigationTasks.map(task => [task.id, task]));
  for (let i = 0; i < snapshot.agenda.length; i++) {
    const entry = snapshot.agenda[i];
    if (!scope.has(entry.nodeId)) issue('agenda node must belong to scope', ['agenda', i, 'nodeId']);
    if (removed.has(entry.nodeId)) issue('agenda node must not be removed', ['agenda', i, 'nodeId']);
    unique(entry.taskIds, ['agenda', i, 'taskIds']);
    entry.taskIds.forEach((taskId, taskIndex) => {
      const task = tasks.get(taskId);
      if (!task) issue('agenda task reference does not exist', ['agenda', i, 'taskIds', taskIndex]);
      else if (task.nodeId !== entry.nodeId) issue('agenda task node must match agenda node', ['agenda', i, 'taskIds', taskIndex]);
    });
  }

  const currentIds = snapshot.engineInternals.currentFocusTaskIds;
  if (snapshot.currentFocusNodeId === null) {
    if (currentIds.length > 0) issue('currentFocusTaskIds must be empty without a current focus', ['engineInternals', 'currentFocusTaskIds']);
    if (snapshot.engineInternals.currentFocusQuestion !== null) issue('currentFocusQuestion must be null without a current focus', ['engineInternals', 'currentFocusQuestion']);
  } else {
    if (currentIds.length === 0) issue('currentFocusTaskIds must identify the current focus work', ['engineInternals', 'currentFocusTaskIds']);
    currentIds.forEach((taskId, i) => {
      const task = tasks.get(taskId);
      if (!task) issue('current focus task reference does not exist', ['engineInternals', 'currentFocusTaskIds', i]);
      else if (task.nodeId !== snapshot.currentFocusNodeId) issue('current focus task node must match currentFocusNodeId', ['engineInternals', 'currentFocusTaskIds', i]);
    });
  }

  for (let i = 0; i < snapshot.engineInternals.investigationTasks.length; i++) {
    const task = snapshot.engineInternals.investigationTasks[i];
    if (task.parentTaskId) {
      if (task.parentTaskId === task.id) issue('task must not parent itself', ['engineInternals', 'investigationTasks', i, 'parentTaskId']);
      else if (!tasks.has(task.parentTaskId)) issue('parent task reference does not exist', ['engineInternals', 'investigationTasks', i, 'parentTaskId']);
    }
    if (task.status === 'resolved' && task.resolvedHop === undefined) issue('resolved task requires resolvedHop', ['engineInternals', 'investigationTasks', i, 'resolvedHop']);
    if (task.status !== 'resolved' && task.resolvedHop !== undefined) issue('only resolved tasks may carry resolvedHop', ['engineInternals', 'investigationTasks', i, 'resolvedHop']);
  }
  for (const task of snapshot.engineInternals.investigationTasks) {
    const seen = new Set<string>([task.id]);
    let parentId = task.parentTaskId;
    while (parentId) {
      if (seen.has(parentId)) { issue('task parent graph must be acyclic', ['engineInternals', 'investigationTasks']); break; }
      seen.add(parentId);
      parentId = tasks.get(parentId)?.parentTaskId;
    }
  }

  for (let i = 0; i < snapshot.engineInternals.pendingLeads.length; i++) {
    const lead = snapshot.engineInternals.pendingLeads[i];
    const task = tasks.get(lead.taskId);
    if (!task) issue('pending lead task reference does not exist', ['engineInternals', 'pendingLeads', i, 'taskId']);
    else if (lead.status === 'pending' && task.status !== 'deferred') issue('pending lead requires a deferred task', ['engineInternals', 'pendingLeads', i, 'status']);
    else if (lead.status === 'scheduled' && !['pending', 'active'].includes(task.status)) issue('scheduled lead requires pending or active task', ['engineInternals', 'pendingLeads', i, 'status']);
    else if (lead.status === 'resolved' && task.status !== 'resolved') issue('resolved lead requires resolved task', ['engineInternals', 'pendingLeads', i, 'status']);
  }

  const init = snapshot.engineInternals.initSnapshot;
  if (snapshot.columnAspect === null) {
    if (init?.analysisMode === 'ct') issue('BB snapshot cannot carry CT init mode', ['engineInternals', 'initSnapshot', 'analysisMode']);
    if (snapshot.lineageQuestionsLastHop !== undefined) issue('BB snapshot cannot carry lineage questions', ['lineageQuestionsLastHop']);
    if (snapshot.ctPrunedNodeIds !== undefined) issue('BB snapshot cannot carry CT pruned nodes', ['ctPrunedNodeIds']);
    snapshot.engineInternals.investigationTasks.forEach((task, i) => {
      if (task.kind === 'column_lineage') issue('BB snapshot cannot carry column-lineage tasks', ['engineInternals', 'investigationTasks', i, 'kind']);
    });
    snapshot.nodeStates.forEach((state, i) => {
      if (state.columns !== undefined) issue('BB node state cannot carry column state', ['nodeStates', i, 'columns']);
    });
    snapshot.agenda.forEach((entry, i) => {
      if (entry.activeColumns !== undefined) issue('BB agenda cannot carry active columns', ['agenda', i, 'activeColumns']);
    });
  } else {
    if (init?.analysisMode !== 'ct') issue('CT snapshot requires CT init mode', ['engineInternals', 'initSnapshot', 'analysisMode']);
    if (init?.analysisMode === 'ct' && JSON.stringify(init.targetColumns) !== JSON.stringify(snapshot.columnAspect.target_columns)) issue('CT init targets must equal columnAspect targets', ['engineInternals', 'initSnapshot', 'targetColumns']);
    snapshot.engineInternals.investigationTasks.forEach((task, i) => {
      if (task.kind !== 'column_lineage') issue('CT snapshot requires column-lineage tasks', ['engineInternals', 'investigationTasks', i, 'kind']);
    });
    snapshot.agenda.forEach((entry, i) => {
      if (entry.activeColumns === undefined) issue('CT agenda requires activeColumns projection', ['agenda', i, 'activeColumns']);
    });
  }
});

/**
 * A strongly typed snapshot of an active NavigationEngine session.
 */
type NavigationSnapshot = z.infer<typeof NavigationSnapshotSchema>;

/**
 * Parses one current-format checkpoint without repairing, migrating, or logging its content.
 *
 * @param input - Untrusted checkpoint payload to validate.
 * @returns A strict current-format navigation snapshot.
 */
export function parseNavigationSnapshot(input: unknown): NavigationSnapshot {
  const result = NavigationSnapshotSchema.safeParse(input);
  if (result.success) return result.data;
  const paths = Array.from(new Set(result.error.issues.map(issue => issue.path.join('.') || '(root)'))).slice(0, 3);
  throw new InvalidEngineCheckpointError(paths, { cause: result.error });
}
