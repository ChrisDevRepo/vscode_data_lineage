import { z } from 'zod';
import { ExplorationDepthSelectionSchema } from './explorationDepthContract';
import { OBJECT_TYPES, type ExtensionConfig, type TraceAffordanceSnapshot } from '../types';

/**
 * ─── Bridge Contract ────────────────────────────────────────────────────────
 *
 * This module defines the strict type-safe contract for all IPC messages
 * between the Extension Host and the Webview.
 *
 * @packageDocumentation
 */

/** Zod schema defining the valid types of database objects in the lineage graph. */
const ObjectTypeSchema = z.enum(OBJECT_TYPES);

/** Upper bound on scope arrays carried across the bridge (DoS / payload guard). */
export const AI_MAX_SCOPE_NODE_IDS = 500;

/**
 * Upper bound, in characters, on the assembled AI report markdown the webview hands back to the
 * host for "Open in editor".
 *
 * @remarks
 * Bounds the `ai-open-in-editor` payload, which is otherwise the one unbounded string the webview
 * can post — no field-level cap composes into a total. A report is the prose of a single
 * language-model turn; a payload above this ceiling is a malformed or hostile frame, not a long answer.
 */
export const AI_REPORT_MARKDOWN_MAX_CHARS = 200_000;

/**
 * Link destination scheme of the engine-assembled object links in AI report markdown:
 * `[label](#focus-node:<encoded id>)`. It resolves only inside the graph webview's click handler.
 */
export const FOCUS_NODE_HREF_PREFIX = '#focus-node:';

const FOCUS_NODE_LINK_RE = new RegExp(String.raw`\[([^\]]*)\]\(${FOCUS_NODE_HREF_PREFIX}[^)]*\)`, 'g');

/**
 * Rewrites every `[label](#focus-node:<id>)` to plain `label`, for a surface outside the graph
 * webview where the scheme has no target.
 *
 * @param markdown - AI report markdown.
 * @returns The markdown with every focus-node link reduced to its label; other links untouched.
 */
export function stripFocusNodeLinks(markdown: string): string {
  return markdown.replace(FOCUS_NODE_LINK_RE, '$1');
}

/**
 * Maximum object ids one screen-state list carries: the cap the presenter applies when it renders
 * a screen-fact id list (the overflow is reported as a count) and, identically, the cap on the ids
 * a `lineage_get_screen_state` recall may name — a recall reads back what the screen card listed,
 * so one governor sizes both ends. `package.json`'s `maxItems` is generated from the schema by
 * `scripts/generate-tool-manifest.mjs`, never maintained by hand.
 */
export const SCREEN_STATE_MAX_IDS = 20;

/**
 * Sentinel `upstreamLevels`/`downstreamLevels` value meaning "every level", not a literal depth.
 *
 * @remarks
 * The trace controls encode an unbounded side as this value and the banner decodes it back to
 * "All", so it crosses the bridge as an ordinary number. Every producer and consumer must use
 * this constant: a surface that treats it as a depth reports nine quadrillion levels.
 */
export const TRACE_ALL_LEVELS = Number.MAX_SAFE_INTEGER;

const AiScopeListSchema = z.array(z.string()).max(AI_MAX_SCOPE_NODE_IDS);

/** Typed structural and free-text edits accepted when revising a pending exploration gate. */
export const AiGateRefineSchema = z.object({
  origin: z.string().min(1).optional(),
  direction: z.enum(['upstream', 'downstream', 'bidirectional']).optional(),
  depth: ExplorationDepthSelectionSchema.optional(),
  excludeTypes: AiScopeListSchema.optional(),
  excludeSchemas: AiScopeListSchema.optional(),
  excludeNodeIds: AiScopeListSchema.optional(),
  passNodeIds: AiScopeListSchema.optional(),
  analysisMode: z.enum(['bb', 'ct']).optional(),
  targetColumns: AiScopeListSchema.optional(),
  classification: z.enum(['business', 'technical', 'both']).optional(),
  instruction: z.string().optional(),
}).strict().superRefine((data, ctx) => {
  if (data.analysisMode === 'bb' && data.targetColumns?.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targetColumns'], message: 'BB refinement cannot include named target columns.' });
  }
  if (data.analysisMode === 'ct' && !data.targetColumns?.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targetColumns'], message: 'CT refinement requires at least one named target column.' });
  }
});

/** The edited-scope payload of a revision-bound refine gate decision. */
export type AiGateRefine = z.infer<typeof AiGateRefineSchema>;

/**
 * Zod schema mirroring the runtime `ColumnDef` shape (`src/engine/types.ts`).
 *
 * @remarks
 * Field names and types must stay aligned with `engine/types.ts#ColumnDef`. `nullable` and `extra`
 * are string columns carrying raw extractor metadata; primary-key participation is signalled by
 * `pkOrdinal`, not a boolean.
 */
const ColumnDefSchema = z.object({
  name: z.string(),
  type: z.string(),
  nullable: z.string(),
  extra: z.string(),
  unique: z.string().optional(),
  check: z.string().optional(),
  pkOrdinal: z.number().optional(),
});

/** Strict IPC boundary schema for lineage nodes sent between the extension host and webview. */
const LineageNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  schema: z.string(),
  fullName: z.string(),
  type: ObjectTypeSchema,
  columns: z.array(ColumnDefSchema).optional(),
  bodyScript: z.string().optional(),
});

/** Zod schema defining a directed dependency or execution relationship between two lineage nodes. */
const LineageEdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  type: z.enum(['body', 'dependency', 'exec']).optional(),
});

/** Zod schema for a schema's node counts and object-type breakdown, used for UI filtering. */
const SchemaInfoSchema = z.object({
  name: z.string(),
  nodeCount: z.number(),
  types: z.record(ObjectTypeSchema, z.number()),
});

/** Zod schema for a catalog entry mapping an object namespace to its physical representation. */
const CatalogEntrySchema = z.object({
  schema: z.string(),
  name: z.string(),
  type: ObjectTypeSchema,
  externalType: z.enum(['et', 'file', 'db']).optional(),
});

/** Strict IPC boundary schema for DatabaseModel payloads crossing between the host and webview. */
const DatabaseModelSchema = z.object({
  nodes: z.array(LineageNodeSchema),
  edges: z.array(LineageEdgeSchema),
  schemas: z.array(SchemaInfoSchema),
  neighborIndex: z.record(z.string(), z.object({
    in: z.array(z.string()),
    out: z.array(z.string()),
  })),
  catalog: z.record(z.string(), CatalogEntrySchema),
  parseStats: z.object({
    parsedRefs: z.number(),
    resolvedEdges: z.number(),
    droppedRefs: z.array(z.string()),
    spDetails: z.array(z.any()),
  }).optional(),
  warnings: z.array(z.string()).optional(),
  dbPlatform: z.string().optional(),
  source: z.enum(['dacpac', 'database']).optional(),
});

/**
 * Zod schema carrying the host's settings snapshot across the bridge.
 *
 * @remarks
 * Pinned to {@link ExtensionConfig} so a parsed message keeps its field types instead of degrading
 * to `any`. `Partial` is the honest shape: the host is the sole producer, so a mismatch here is a
 * host refactor bug that must fail at the boundary. `parseRules` alone stays structural.
 */
const ExtensionConfigSchema: z.ZodType<Partial<ExtensionConfig>> = z.object({
  parseRules: z.custom<NonNullable<ExtensionConfig['parseRules']>>(
    (v) => typeof v === 'object' && v !== null && Array.isArray((v as { rules?: unknown }).rules),
  ).optional(),
  excludePatterns: z.array(z.string()).optional(),
  maxNodes: z.number().optional(),
  dmvQueryTimeout: z.number().optional(),
  layout: z.object({
    direction: z.enum(['TB', 'LR']),
    rankSeparation: z.number(),
    nodeSeparation: z.number(),
    edgeAnimation: z.boolean(),
    highlightAnimation: z.boolean(),
    minimapEnabled: z.boolean(),
    edgeStyle: z.enum(['default', 'smoothstep', 'step', 'straight']),
  }).optional(),
  trace: z.object({
    defaultUpstreamLevels: z.number(),
    defaultDownstreamLevels: z.number(),
  }).optional(),
  analysis: z.object({
    hubMinDegree: z.number(),
    islandMaxSize: z.number(),
    longestPathMinNodes: z.number(),
  }).optional(),
  tableStatistics: z.object({
    enabled: z.boolean(),
    standardModeEnabled: z.boolean(),
    excludeExternalTables: z.boolean(),
    maxColumns: z.number(),
    sampleThreshold: z.number(),
    sampleSize: z.number(),
    useApproxDistinct: z.boolean(),
    queryTimeout: z.number(),
  }).optional(),
  externalRefs: z.object({
    enabled: z.boolean(),
  }).optional(),
  overview: z.object({
    enabled: z.boolean(),
    threshold: z.number(),
    schemaDoubleClickBehavior: z.enum(['expand', 'expandOnly']),
  }).optional(),
  renderLimit: z.number().optional(),
});

/**
 * Bidirectional shape equality, used only by {@link extensionConfigSchemaMatchesInterface} below.
 * Tuple-wrapped (`[A] extends [B]`) so the comparison covers the whole object shape at once instead
 * of TS distributing the check per-property over a union.
 */
type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Compile-time drift guard for {@link ExtensionConfigSchema}: fails to typecheck the moment the
 * schema's inferred shape and `Partial<ExtensionConfig>` (declared in `../types`, not owned here)
 * diverge in either direction — a field added, removed, or retyped on one side without the other.
 * The one-directional `z.ZodType<Partial<ExtensionConfig>>` annotation on the schema itself already
 * catches the schema being too loose; this also catches the schema being too narrow (missing a field
 * the interface has).
 */
const extensionConfigSchemaMatchesInterface: AssertExact<z.infer<typeof ExtensionConfigSchema>, Partial<ExtensionConfig>> = true;
void extensionConfigSchemaMatchesInterface;

/**
 * Zod schema defining the serialized visual filter configuration state.
 *
 * @remarks
 * Specifies inclusion and exclusion parameters for rendering graph nodes.
 * Used for persisting and restoring view states.
 */
const SerializedFilterStateSchema = z.object({
  schemas: z.array(z.string()),
  types: z.array(z.string()),
  searchTerm: z.string().optional(),
  hideIsolated: z.boolean(),
  focusSchemas: z.array(z.string()),
  showExternalRefs: z.boolean(),
  externalRefTypes: z.array(z.string()),
  exclusionPatterns: z.array(z.string()).optional(),
  allowlistNodeIds: z.array(z.string()).optional(),
}).strict();

/** Serialized visual filter configuration state, persisted and restored across sessions. */
export type SerializedFilterState = z.infer<typeof SerializedFilterStateSchema>;

/** Semantic highlight color applied to an AI-flagged node or edge. */
const AIHighlightColorSchema = z.enum(['source', 'transform', 'target', 'good', 'warn', 'fail']);

const AIHighlightGroupSchema = z.object({
  label: z.string(),
  color: AIHighlightColorSchema,
  nodeIds: z.array(z.string()),
}).strict();

const AINodeTextSchema = z.object({
  nodeId: z.string(),
  text: z.string(),
}).strict();

/**
 * Column-transform classes carried on a column-lineage edge.
 *
 * @remarks
 * Aligned to OpenLineage's `ColumnLineageDatasetFacet` transformation types so an exported facet
 * needs no translation table. Multi-select, because one edge is routinely several at once (an
 * aggregate over a computed expression). The single home for the value set — ai, engine and webview
 * all read it here, so no surface can carry a value the others reject.
 */
export const COLUMN_TRANSFORM_CLASSES = ['pass_through', 'compute', 'aggregate', 'combine', 'filter'] as const;

/** One column-transform class from {@link COLUMN_TRANSFORM_CLASSES}. */
export type ColumnTransformClass = typeof COLUMN_TRANSFORM_CLASSES[number];

/**
 * Whether a transform class carries the upstream value into the output (DIRECT) or only shaped
 * which rows appear (INDIRECT), in OpenLineage's own terms.
 *
 * @remarks
 * Load-bearing and exhaustive: no class is both, so a renderer can key a distinct edge treatment
 * off this map alone. Adding a class to {@link COLUMN_TRANSFORM_CLASSES} without an entry here
 * fails to typecheck.
 */
export const COLUMN_TRANSFORM_DIRECTION: Readonly<Record<ColumnTransformClass, 'DIRECT' | 'INDIRECT'>> = {
  pass_through: 'DIRECT',
  compute:      'DIRECT',
  aggregate:    'DIRECT',
  combine:      'INDIRECT',
  filter:       'INDIRECT',
};

/** Zod form of {@link COLUMN_TRANSFORM_CLASSES}, shared by every schema that carries the field. */
export const ColumnTransformClassSchema = z.enum(COLUMN_TRANSFORM_CLASSES);

const ColumnAspectEdgeSchema = z.object({
  hopNode:  z.string(),
  fromNode: z.string(),
  toNode:   z.string(),
  fromCol:  z.string(),
  toCol:    z.string(),
  /** Absent whenever the model did not classify the edge; the engine never fills it in with a guess. */
  transforms: z.array(ColumnTransformClassSchema).optional(),
  /**
   * Optional one-clause model note for the edge ("SUM of line totals"), absent whenever the model
   * offered none. Surface text only: the webview prints it in the edge tooltip and nothing parses
   * it, so an old edge without one reads the structural description instead.
   */
  note: z.string().optional(),
}).strict();

/** Inferred shape of {@link ColumnAspectEdgeSchema}. */
export type ColumnAspectEdge = z.infer<typeof ColumnAspectEdgeSchema>;

const ColumnAspectSchema = z.object({
  edges: z.array(ColumnAspectEdgeSchema),
}).strict();

const NodeVerdictSchema = z.object({
  nodeId: z.string(),
  verdict: z.enum(['analyze', 'passthrough', 'prune']),
}).strict();

/** Inferred shape of {@link NodeVerdictSchema}. */
export type NodeVerdict = z.infer<typeof NodeVerdictSchema>;

/**
 * Zod schema defining AI-generated metadata for enhancing the lineage graph UI.
 *
 * @remarks
 * Contains custom grouping, badging, highlighting, and descriptive text generated by the AI agent.
 */
const AIViewMetadataSchema = z.object({
  summary: z.string().optional(),
  description: z.string().optional(),
  createdAt: z.string(),
  modelName: z.string(),
  /** Identifier of the AI run that authored the view; pairs the bookmark with its persisted run record. */
  runId: z.string().optional(),
  highlightGroups: z.array(AIHighlightGroupSchema),
  badges: z.array(AINodeTextSchema),
  notes: z.array(AINodeTextSchema).optional(),
  layoutDirection: z.enum(['LR', 'TB']).optional(),
  /** Column trace edges. Each edge carries the analyzing hop node plus source/destination so every result node can show column flow data. Only present during CT sessions. */
  columnAspect: ColumnAspectSchema.optional(),
  /** Per-node CT verdict, so the webview can mark column lines without an AI-contract change. Only present during CT sessions. */
  nodeVerdicts: z.array(NodeVerdictSchema).optional(),
}).strict();

/** AI-generated metadata layered onto the lineage graph UI: grouping, badges, highlights, and descriptive text. */
export type AIViewMetadata = z.infer<typeof AIViewMetadataSchema>;

const NodePositionSchema = z.object({ x: z.number(), y: z.number() }).strict();

const ExpandedSchemaViewSchema = z.object({
  focusNodeId: z.string().nullable(),
  expandedSchemas: z.array(z.string()),
}).strict();

/**
 * Zod schema defining a saved filter profile snapshot.
 *
 * @remarks
 * `graphMode`, `expandedSchemaView` and `showExpandedSchemaClusters` are the view shape — schema
 * clusters, individual objects, or the mixed state where some schemas are expanded. They stay
 * optional so a profile missing them still restores.
 */
const FilterProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  filter: SerializedFilterStateSchema,
  source: z.enum(['user', 'trace', 'analysis', 'ai']).optional(),
  positions: z.record(z.string(), NodePositionSchema).optional(),
  aiMetadata: AIViewMetadataSchema.optional(),
  graphMode: z.enum(['overview', 'full']).optional(),
  expandedSchemaView: ExpandedSchemaViewSchema.optional(),
  showExpandedSchemaClusters: z.boolean().optional(),
}).strict();

/** A saved filter profile snapshot: layout, filter rules, and optional AI metadata. */
export type FilterProfile = z.infer<typeof FilterProfileSchema>;

/** Human-readable labels for bookmark-view sources. Single owner; banner + info card both read it. */
export const BOOKMARK_SOURCE_LABELS: Record<NonNullable<FilterProfile['source']>, string> = {
  ai: 'AI',
  trace: 'Trace',
  analysis: 'Analysis',
  user: 'View',
};

/** Border/text colors for bookmark-view sources. Single owner; banner + info card both read it. */
export const BOOKMARK_SOURCE_COLORS: Record<NonNullable<FilterProfile['source']>, string> = {
  ai: 'var(--ln-analysis-border)',
  trace: 'var(--ln-warning-border)',
  analysis: 'var(--ln-analysis-border)',
  user: 'var(--ln-border)',
};

/** Descriptive text for bookmark-view sources. Single owner; the info card reads it. */
export const BOOKMARK_SOURCE_DESCRIPTIONS: Record<NonNullable<FilterProfile['source']>, string> = {
  ai: 'AI-generated by @lineage',
  trace: 'From trace',
  analysis: 'From analysis',
  user: 'Saved view',
};

/**
 * Stored MSSQL connection metadata.
 *
 * @remarks
 * `.strict()` is load-bearing: unknown fields — a leaked `password` above all — are rejected
 * rather than persisted or replayed to the webview. Tolerance is granted per named field only,
 * because `migrateProjectStore` discards any stored record that fails this schema, and Integrated,
 * Entra and legacy connections omit `user`/`authenticationType`/typed `port` respectively.
 */
export const StoredConnectionInfoSchema = z.object({
  server: z.string(),
  database: z.string(),
  user: z.string().optional(),
  authenticationType: z.string().optional(),
  email: z.string().optional(),
  accountId: z.string().optional(),
  tenantId: z.string().optional(),
  port: z.coerce.number().optional(),
  encrypt: z.union([z.string(), z.boolean()]).optional(),
  trustServerCertificate: z.boolean().optional(),
}).strict();

/** Stored MSSQL connection metadata. See {@link StoredConnectionInfoSchema} for the persistence-tolerance contract. */
export type StoredConnectionInfo = z.infer<typeof StoredConnectionInfoSchema>;

const DacpacConnectionSchema = z.object({
  type: z.literal('dacpac'),
  path: z.string(),
  displayName: z.string(),
  schemas: z.array(z.string()),
}).strict();

/** A project connection backed by a static DACPAC file. */
export type DacpacConnection = z.infer<typeof DacpacConnectionSchema>;

const DatabaseConnectionSchema = z.object({
  type: z.literal('database'),
  connectionInfo: StoredConnectionInfoSchema,
  sourceName: z.string(),
  schemas: z.array(z.string()),
}).strict();

/** A project connection backed by a live database (server/DB or DMV source). */
export type DatabaseConnection = z.infer<typeof DatabaseConnectionSchema>;

const ProjectConnectionSchema = z.discriminatedUnion('type', [
  DacpacConnectionSchema,
  DatabaseConnectionSchema,
]);

/**
 * Zod schema defining a workspace project configuration.
 *
 * @remarks
 * Groups related database connections and persistent filter profiles together.
 */
export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  connection: ProjectConnectionSchema,
  filterProfiles: z.array(FilterProfileSchema).optional(),
}).strict();

/** A workspace project: its connection and any saved filter profiles. */
export type Project = z.infer<typeof ProjectSchema>;

/**
 * Reading counterpart of {@link ProjectSchema} for records already on disk.
 *
 * @remarks
 * Same fields, but unknown ones are dropped instead of rejecting the record: a record written by an
 * older build legitimately carries keys this one never declared, and discarding the whole project
 * over one of them is silent user-data loss. Rebuilt level by level from the strict schemas' own
 * shapes, so a field added above is carried here without a second declaration to keep in step.
 */
const StoredConnectionInfoReadSchema = z.object(StoredConnectionInfoSchema.shape);

const ProjectConnectionReadSchema = z.discriminatedUnion('type', [
  z.object(DacpacConnectionSchema.shape),
  z.object({ ...DatabaseConnectionSchema.shape, connectionInfo: StoredConnectionInfoReadSchema }),
]);

const AIViewMetadataReadSchema = z.object({
  ...AIViewMetadataSchema.shape,
  highlightGroups: z.array(z.object(AIHighlightGroupSchema.shape)),
  badges: z.array(z.object(AINodeTextSchema.shape)),
  notes: z.array(z.object(AINodeTextSchema.shape)).optional(),
  columnAspect: z.object({
    ...ColumnAspectSchema.shape,
    edges: z.array(z.object(ColumnAspectEdgeSchema.shape)),
  }).optional(),
  nodeVerdicts: z.array(z.object(NodeVerdictSchema.shape)).optional(),
});

const FilterProfileReadSchema = z.object({
  ...FilterProfileSchema.shape,
  filter: z.object(SerializedFilterStateSchema.shape),
  positions: z.record(z.string(), z.object(NodePositionSchema.shape)).optional(),
  aiMetadata: AIViewMetadataReadSchema.optional(),
  expandedSchemaView: z.object(ExpandedSchemaViewSchema.shape).optional(),
});

/** Persisted-record counterpart of {@link ProjectSchema}; see {@link StoredConnectionInfoReadSchema}. */
export const ProjectReadSchema = z.object({
  ...ProjectSchema.shape,
  connection: ProjectConnectionReadSchema,
  filterProfiles: z.array(FilterProfileReadSchema).optional(),
});

/**
 * Envelope version stamped on every host→webview frame by the `postValidated` send choke point.
 *
 * @remarks
 * Deliberately an *envelope* field, not a schema field, so the message unions below stay untouched.
 * Bump it whenever a message shape changes in a way an older peer bundle would misread — a stale
 * webview then fails loudly at the receive site instead of silently mis-rendering.
 */
export const BRIDGE_PROTOCOL_VERSION = 1;

/** Envelope shape read at receive sites before the payload union is parsed. */
export type BridgeEnvelope = { protocolVersion?: unknown };

/**
 * Validated host→webview frame: either the parsed payload or a classified rejection.
 *
 * @remarks
 * Single owner for the receive-side seam both webviews repeat: Zod-parse the raw frame, then
 * compare the envelope version. Parse failures stay silent (foreign frames are ignored); version
 * mismatches are loud (stale bundle).
 */
export type ValidatedBridgeFrame<S extends z.ZodTypeAny> =
  | { ok: true; data: z.infer<S>; msgType: string }
  | { ok: false; reason: 'parse' | 'version'; msgType: string; version: unknown };

/** Validates one host→webview frame against `schema` plus {@link BRIDGE_PROTOCOL_VERSION}. */
export function validateBridgeFrame<S extends z.ZodTypeAny>(
  schema: S,
  raw: unknown,
): ValidatedBridgeFrame<S> {
  const parsed = schema.safeParse(raw);
  const version = (raw as BridgeEnvelope | undefined)?.protocolVersion;
  if (!parsed.success) {
    const msgType = typeof (raw as { type?: unknown } | undefined)?.type === 'string'
      ? String((raw as { type: string }).type)
      : '?';
    return { ok: false, reason: 'parse', msgType, version };
  }
  const msgType = String((parsed.data as { type: string }).type);
  if (version !== BRIDGE_PROTOCOL_VERSION) {
    return { ok: false, reason: 'version', msgType, version };
  }
  return { ok: true, data: parsed.data, msgType };
}

const TraceAffordanceSideSnapshotSchema = z.looseObject({
  add: z.array(z.string()),
  prune: z.array(z.string()),
  addDisabledReason: z.string(),
  pruneDisabledReason: z.string(),
  neighborCount: z.number(),
  visibleNeighborCount: z.number(),
});

const TraceAffordanceSnapshotSchema: z.ZodType<TraceAffordanceSnapshot> = z.looseObject({
  nodeId: z.string(),
  in: TraceAffordanceSideSnapshotSchema,
  out: TraceAffordanceSideSnapshotSchema,
});

const RenderConnectivitySchema = z.looseObject({
  nodeCount: z.number(),
  edgeCount: z.number(),
  componentCount: z.number(),
  components: z.array(z.looseObject({ size: z.number(), nodes: z.array(z.string()) })),
  isolatedNodes: z.array(z.string()),
});

const RenderTraceScopeSchema = z.looseObject({
  mode: z.string(),
  origin: z.string().nullable(),
  baseNodeIds: z.array(z.string()),
  manualAddedNodeIds: z.array(z.string()),
  manualPrunedNodeIds: z.array(z.string()),
  tracedNodeIds: z.array(z.string()),
});

/**
 * Zod schema of the `render-state` buffer the main webview mirrors to the host after each render.
 *
 * @remarks
 * Validated at the bridge like every other frame. Fields a host reader walks structurally — the
 * highlighted node, its add/prune affordances, the trace scope id lists, the rendered connectivity —
 * are typed; every other key the webview adds (graph error context) is kept literally, so an
 * unrecognized field never fails the frame. A frame whose walked fields are malformed is rejected
 * and logged at the receive site and never reaches a reader.
 */
export const RenderStateSnapshotSchema = z.looseObject({
  highlightedNodeId: z.string().nullable().optional(),
  affordances: TraceAffordanceSnapshotSchema.nullable().optional(),
  traceScope: RenderTraceScopeSchema.nullable().optional(),
  connectivity: RenderConnectivitySchema.optional(),
});

/** Validated `render-state` buffer: highlighted node, affordances, trace scope and connectivity. */
export type RenderStateSnapshot = z.infer<typeof RenderStateSnapshotSchema>;

/**
 * Zod schema of the analytics/bookmark extras carried on `uiState.screenState`, not in `render-state`.
 *
 * @remarks
 * Same tolerance terms as {@link RenderStateSnapshotSchema}: walked fields typed, extras kept.
 */
export const ScreenStateExtrasSchema = z.looseObject({
  analytics: z.looseObject({
    type: z.string(),
    activeGroupId: z.string().nullable(),
    groups: z.array(z.looseObject({ id: z.string(), label: z.string(), nodeIds: z.array(z.string()) })),
  }).nullable().optional(),
  bookmark: z.looseObject({
    id: z.string(),
    name: z.string(),
    source: z.string().nullable(),
    allowlistNodeIds: z.array(z.string()),
  }).nullable().optional(),
  detailOpen: z.boolean().optional(),
});

/** Validated analytics panel, applied bookmark and detail-panel flag of the current screen. */
export type ScreenStateExtras = z.infer<typeof ScreenStateExtrasSchema>;

/**
 * Zod schema of the `filter-changed` ui-state buffer the main webview posts on every view change.
 *
 * @remarks
 * The host lifts `filter`, `graphMode`, `filteredCount` and `renderLimitHit` onto typed session
 * fields, and the screen-state readers walk `trace` and `screenState`, so those are typed; the filter
 * reuses the persisted {@link SerializedFilterState} contract. Unknown keys are kept literally.
 */
export const UiStateSnapshotSchema = z.looseObject({
  filter: SerializedFilterStateSchema,
  expandedSchemaView: ExpandedSchemaViewSchema.nullable().optional(),
  trace: z.looseObject({
    mode: z.string(),
    selectedNodeId: z.string().nullable(),
    upstreamLevels: z.number(),
    downstreamLevels: z.number(),
  }),
  graphMode: z.enum(['overview', 'full']),
  filteredCount: z.number(),
  renderLimitHit: z.number(),
  screenState: ScreenStateExtrasSchema.optional(),
});

/** Validated `filter-changed` ui-state buffer. */
export type UiStateSnapshot = z.infer<typeof UiStateSnapshotSchema>;

/**
 * Zod schema representing the complete discriminated union of message types
 * sent from the VS Code Extension Host to the React Webview.
 *
 * @remarks
 * All outgoing communication from the extension is validated against this schema.
 */
export const ExtensionToWebviewMsgSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('dacpac-model'), model: DatabaseModelSchema, config: ExtensionConfigSchema, sourceName: z.string(), autoVisualize: z.boolean().optional() }),
  z.object({ type: z.literal('db-model'), model: DatabaseModelSchema, config: ExtensionConfigSchema, sourceName: z.string() }),
  z.object({ type: z.literal('projects-list'), projects: z.array(ProjectSchema), lastOpenedId: z.string().nullable(), lastWizardView: z.string().nullish() }),
  z.object({ type: z.literal('detail-closed') }),
  z.object({ type: z.literal('dacpac-schema-preview'), preview: z.any(), config: ExtensionConfigSchema, sourceName: z.string(), filePath: z.string().optional() }),
  z.object({ type: z.literal('db-schema-preview'), preview: z.any(), config: ExtensionConfigSchema, sourceName: z.string() }),
  z.object({ type: z.literal('db-progress'), step: z.number(), total: z.number(), label: z.string() }),
  z.object({ type: z.literal('db-cancelled') }),
  z.object({ type: z.literal('db-error'), message: z.string(), phase: z.string() }),
  z.object({ type: z.literal('last-dacpac-gone') }),
  z.object({ type: z.literal('mssql-status'), available: z.boolean() }),
  z.object({ type: z.literal('rebuild-config'), config: ExtensionConfigSchema }),
  z.object({ type: z.literal('focus-object'), schema: z.string(), name: z.string() }),
  z.object({ type: z.literal('ai-view-preview'), name: z.string(), nodeIds: z.array(z.string()), aiMetadata: AIViewMetadataSchema }),
  z.object({
    type: z.literal('error'),
    error: z.string(),
    stack: z.string().optional(),
    componentStack: z.string().optional(),
    source: z.enum(['error-boundary', 'window-error', 'unhandled-rejection']).optional(),
    context: z.record(z.string(), z.unknown()).optional(),
    timestamp: z.number().optional(),
  }),
]);

/**
 * TypeScript type inferred from the ExtensionToWebviewMsgSchema.
 * Represents all valid messages dispatched to the Webview.
 */
export type ExtensionToWebviewMsg = z.infer<typeof ExtensionToWebviewMsgSchema>;

/** Structured webview crash diagnostic accepted from both primary and detail panels. */
const WebviewErrorMessageSchema = z.object({
  type: z.literal('error'),
  error: z.string(),
  stack: z.string().optional(),
  componentStack: z.string().optional(),
  source: z.enum(['error-boundary', 'window-error', 'unhandled-rejection']).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  timestamp: z.number().optional(),
});

/** User warning request accepted from both primary and detail panels. */
const WebviewWarningMessageSchema = z.object({
  type: z.literal('show-warning'),
  text: z.string(),
});

/**
 * Zod schema for messages sent from the primary lineage-graph webview to the
 * extension host.
 *
 * @remarks
 * The detail-panel webview runs in a separate process and uses its own schema
 * ({@link DetailPanelToExtensionMsgSchema}). Keeping the two unions separate
 * lets each dispatcher exhaustively handle its own variants.
 */
export const MainPanelToExtensionMsgSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('show-detail'), node: LineageNodeSchema.optional(), findQuery: z.string().optional() }),
  z.object({ type: z.literal('update-detail'), node: LineageNodeSchema.optional(), findQuery: z.string().optional() }),
  z.object({ type: z.literal('open-dacpac') }),
  z.object({ type: z.literal('load-project'), id: z.string() }),
  z.object({ type: z.literal('save-project'), project: ProjectSchema }),
  z.object({ type: z.literal('delete-project'), id: z.string() }),
  z.object({ type: z.literal('load-demo') }),
  z.object({ type: z.literal('dacpac-visualize'), schemas: z.array(z.string()), projectName: z.string().optional() }),
  z.object({ type: z.literal('db-visualize'), schemas: z.array(z.string()), projectName: z.string().optional() }),
  z.object({ type: z.literal('filter-changed'), uiState: UiStateSnapshotSchema }),
  z.object({ type: z.literal('render-state'), renderState: RenderStateSnapshotSchema }),
  z.object({ type: z.literal('db-connect') }),
  z.object({ type: z.literal('check-mssql') }),
  z.object({
    type: z.literal('save-view'),
    projectId: z.string(),
    profile: FilterProfileSchema,
  }),
  z.object({ type: z.literal('save-wizard-view'), view: z.enum(['main', 'projects']) }),
  z.object({ type: z.literal('delete-view'), projectId: z.string(), profileId: z.string() }),
  z.object({ type: z.literal('rebuild') }),
  z.object({ type: z.literal('reload') }),
  z.object({ type: z.literal('request-projects') }),
  z.object({ type: z.literal('open-external'), url: z.string().url().refine(u => u.startsWith('http://') || u.startsWith('https://'), { message: 'Only HTTP/HTTPS URLs are allowed' }) }),
  z.object({ type: z.literal('open-settings') }),
  z.object({ type: z.literal('export-file'), defaultName: z.string(), data: z.string() }),
  z.object({ type: z.literal('ai-open-in-editor'), markdown: z.string().max(AI_REPORT_MARKDOWN_MAX_CHARS) }),
  z.object({ type: z.literal('log'), level: z.enum(['info', 'warn', 'debug']).optional(), text: z.string() }),
  WebviewErrorMessageSchema,
  WebviewWarningMessageSchema,
  z.object({ type: z.literal('view-render-result'), rendered: z.number(), of: z.number(), unresolved: z.array(z.string()) }),
]);

/** Messages sent from the main lineage-graph webview to the extension host. */
export type MainPanelToExtensionMsg = z.infer<typeof MainPanelToExtensionMsgSchema>;

/**
 * Zod schema for messages sent from the detail-panel webview to the extension
 * host.
 */
export const DetailPanelToExtensionMsgSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('detail-ready'), findQuery: z.string().optional() }),
  z.object({ type: z.literal('table-stats-request'), schema: z.string(), objectName: z.string(), mode: z.enum(['quick', 'standard']), columns: z.array(ColumnDefSchema) }),
  z.object({ type: z.literal('close-detail') }),
  WebviewErrorMessageSchema,
  WebviewWarningMessageSchema,
]);

/** Messages sent from the detail-panel webview to the extension host. */
export type DetailPanelToExtensionMsg = z.infer<typeof DetailPanelToExtensionMsgSchema>;

/**
 * Every message either webview may post to the extension host.
 *
 * @remarks
 * The two panels keep separate dispatch unions so each host-side dispatcher stays exhaustive over
 * its own variants. One `acquireVsCodeApi()` handle type serves both bundles, so the webview-facing
 * `postMessage` signature is typed with this union: a send of a shape neither host dispatcher can
 * receive then fails to compile instead of being dropped at the Zod seam at runtime.
 */
export type WebviewToExtensionMsg = MainPanelToExtensionMsg | DetailPanelToExtensionMsg;

/**
 * Zod schema for messages sent from the extension host **to the detail-panel webview**.
 *
 * @remarks
 * The detail panel is a separate webview with its own send schema (mirrors {@link DetailPanelToExtensionMsgSchema}
 * for the reverse direction). Host→detail sends go through the `postToDetail` sink so they are validated
 * exactly like the main panel's `postToWebview` — no raw `detailPanel.webview.postMessage`.
 */
export const ExtensionToDetailMsgSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('detail-update'), node: LineageNodeSchema, findQuery: z.string().optional(), config: z.any() }),
  z.object({ type: z.literal('detail-clear') }),
  z.object({ type: z.literal('table-stats-result'), stats: z.any(), mode: z.enum(['quick', 'standard']) }),
  z.object({ type: z.literal('table-stats-error'), message: z.string() }),
]);

/** Messages sent from the extension host to the detail-panel webview. */
export type ExtensionToDetailMsg = z.infer<typeof ExtensionToDetailMsgSchema>;
