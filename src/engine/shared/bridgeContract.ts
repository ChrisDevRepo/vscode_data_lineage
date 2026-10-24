import { z } from 'zod';
import { ExplorationDepthSelectionSchema } from './explorationDepthContract';
import { OBJECT_TYPES, type ExtensionConfig, type SchemaPreview, type TraceAffordanceSnapshot } from '../types';

/** ─── Bridge Contract ──────────────────────────────────────────────────────── */

/** Zod schema defining the valid types of database objects in the lineage graph. */
const ObjectTypeSchema = z.enum(OBJECT_TYPES);

/** Upper bound on a list of object ids carried in a tool call or across the bridge — an input-size check, never a scope limit. */
export const MAX_ID_LIST_LENGTH = 500;

/** Upper bound, in characters, on the assembled AI report markdown the webview hands back to the host for "Open in editor". */
export const AI_REPORT_MARKDOWN_MAX_CHARS = 200_000;

/** Link destination scheme of the engine-assembled object links in AI report markdown: `[label](#focus-node:<encoded id>)`. It resolves only inside the graph webview's click handler. */
export const FOCUS_NODE_HREF_PREFIX = '#focus-node:';

const FOCUS_NODE_LINK_RE = new RegExp(String.raw`\[([^\]]*)\]\(${FOCUS_NODE_HREF_PREFIX}[^)]*\)`, 'g');

/** Rewrites every `[label](#focus-node:<id>)` to plain `label`, for a surface outside the graph webview where the scheme has no target. */
export function stripFocusNodeLinks(markdown: string): string {
  return markdown.replace(FOCUS_NODE_LINK_RE, '$1');
}

/** Maximum object ids one screen-state list carries: the cap the presenter applies when it renders a screen-fact id list (the overflow is reported as a count) and, identically, the cap on the ids a `lineage_get_screen_state` recall may name — a recall reads back what the screen card listed, so one governor sizes both ends. `package.json`'s `maxItems` is generated from the schema by `scripts/generate-tool-manifest.mjs`, never maintained by hand. */
export const SCREEN_STATE_MAX_IDS = 20;

/** Sentinel `upstreamLevels`/`downstreamLevels` value meaning "every level", not a literal depth. */
export const TRACE_ALL_LEVELS = Number.MAX_SAFE_INTEGER;

const AiScopeListSchema = z.array(z.string()).max(MAX_ID_LIST_LENGTH);

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

/** Zod schema mirroring the runtime `ColumnDef` shape (`src/engine/types.ts`). */
const ColumnDefSchema = z.object({
  name: z.string(),
  type: z.string(),
  nullable: z.string(),
  extra: z.string(),
  expressionDependencies: z.array(z.object({
    reference: z.string().refine(value => value.trim().length > 0),
    sourceElementType: z.string().optional(),
    externalSource: z.string().optional(),
  })).optional(),
  unique: z.string().optional(),
  check: z.string().optional(),
  pkOrdinal: z.number().optional(),
});

/** Zod schema for a table's foreign key constraint, mirroring `ForeignKeyInfo`. */
const ForeignKeyInfoSchema = z.object({
  name: z.string(),
  columns: z.array(z.string()),
  refSchema: z.string(),
  refTable: z.string(),
  refColumns: z.array(z.string()),
  onDelete: z.string(),
});

/** Strict IPC boundary schema for lineage nodes sent between the extension host and webview. */
const LineageNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  schema: z.string(),
  fullName: z.string(),
  type: ObjectTypeSchema,
  hasDdl: z.boolean().optional(),
  bodyScript: z.string().optional(),
  hasColumns: z.boolean().optional(),
  columns: z.array(ColumnDefSchema).optional(),
  fks: z.array(ForeignKeyInfoSchema).optional(),
  externalType: z.enum(['et', 'file', 'db']).optional(),
  externalUrl: z.string().optional(),
  externalDatabase: z.string().optional(),
  definitionUnreadable: z.boolean().optional(),
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

/** Validated phase-one metadata; checked catalog policy survives the host/webview boundary. */
const SchemaPreviewSchema: z.ZodType<SchemaPreview> = z.object({
  identifierCaseSensitive: z.boolean().optional(),
  schemas: z.array(SchemaInfoSchema),
  totalObjects: z.number(),
  warnings: z.array(z.string()).optional(),
}).strict();

/** Zod schema for a catalog entry mapping an object namespace to its physical representation. */
const CatalogEntrySchema = z.object({
  schema: z.string(),
  name: z.string(),
  type: ObjectTypeSchema,
  externalType: z.enum(['et', 'file', 'db']).optional(),
});

const SpParseDetailSchema = z.object({
  name: z.string(),
  inCount: z.number(),
  outCount: z.number(),
  inRefs: z.array(z.string()).optional(),
  outRefs: z.array(z.string()).optional(),
  unrelated: z.array(z.string()),
  excluded: z.array(z.string()).optional(),
}).strict();

/** Strict IPC boundary schema for DatabaseModel payloads crossing between the host and webview. */
const DatabaseModelSchema = z.object({
  identifierCaseSensitive: z.boolean().optional(),
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
    spDetails: z.array(SpParseDetailSchema),
  }).optional(),
  warnings: z.array(z.string()).optional(),
  dbPlatform: z.string().optional(),
  source: z.enum(['dacpac', 'database']).optional(),
});

/** Zod schema carrying the host's settings snapshot across the bridge. */
const ExtensionConfigSchema: z.ZodType<Partial<ExtensionConfig>> = z.object({
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

/** Bidirectional shape equality, used only by {@link extensionConfigSchemaMatchesInterface} below. Tuple-wrapped (`[A] extends [B]`) so the comparison covers the whole object shape at once instead of TS distributing the check per-property over a union. */
type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Compile-time drift guard for {@link ExtensionConfigSchema}: fails to typecheck the moment the schema's inferred shape and `Partial<ExtensionConfig>` (declared in `../types`, not owned here) diverge in either direction — a field added, removed, or retyped on one side without the other. The one-directional `z.ZodType<Partial<ExtensionConfig>>` annotation on the schema itself already catches the schema being too loose; this also catches the schema being too narrow (missing a field the interface has). */
const extensionConfigSchemaMatchesInterface: AssertExact<z.infer<typeof ExtensionConfigSchema>, Partial<ExtensionConfig>> = true;
void extensionConfigSchemaMatchesInterface;

/** Zod schema defining the serialized visual filter configuration state. */
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

/** Column-transform classes carried on a column-lineage edge. */
export const COLUMN_TRANSFORM_CLASSES = ['pass_through', 'compute', 'aggregate', 'combine', 'filter'] as const;

/** One column-transform class from {@link COLUMN_TRANSFORM_CLASSES}. */
export type ColumnTransformClass = typeof COLUMN_TRANSFORM_CLASSES[number];

/** Whether a transform class carries the upstream value into the output (DIRECT) or only shaped which rows appear (INDIRECT). */
export const COLUMN_TRANSFORM_DIRECTION: Readonly<Record<ColumnTransformClass, 'DIRECT' | 'INDIRECT'>> = {
  pass_through: 'DIRECT',
  compute:      'DIRECT',
  aggregate:    'DIRECT',
  combine:      'INDIRECT',
  filter:       'INDIRECT',
};

/** Whether a classified column only shaped which rows appear — every class is INDIRECT. */
export function isIndirectOnly(transforms: readonly ColumnTransformClass[] | undefined): boolean {
  return !!transforms?.length && transforms.every(c => COLUMN_TRANSFORM_DIRECTION[c] === 'INDIRECT');
}

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
  /** Optional one-clause model note for the edge ("SUM of line totals"), absent whenever the model offered none. Surface text only: the webview prints it in the edge tooltip and nothing parses it, so an old edge without one reads the structural description instead. */
  note: z.string().optional(),
}).strict();

/** Inferred shape of {@link ColumnAspectEdgeSchema}. */
export type ColumnAspectEdge = z.infer<typeof ColumnAspectEdgeSchema>;

const ColumnAspectSchema = z.object({
  /** Frozen asked identities for preview rows; absent in older saved views. */
  requested: z.object({ node: z.string(), columns: z.array(z.string()) }).strict().optional(),
  edges: z.array(ColumnAspectEdgeSchema),
}).strict();

const NodeVerdictSchema = z.object({
  nodeId: z.string(),
  verdict: z.enum(['analyze', 'passthrough', 'prune']),
}).strict();

/** Zod schema defining AI-generated metadata for enhancing the lineage graph UI. */
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

const ExpandedSchemaViewSchema = z.object({
  focusNodeId: z.string().nullable(),
  expandedSchemas: z.array(z.string()),
}).strict();

/** Zod schema defining a saved filter profile snapshot. */
const FilterProfileSchema = z.object({
  id: z.string(),
  /** Absent on legacy views; current encoding preserves literal identifier delimiters and URL identity. */
  nodeIdEncodingVersion: z.literal(2).optional(),
  name: z.string(),
  createdAt: z.string(),
  filter: SerializedFilterStateSchema,
  source: z.enum(['user', 'trace', 'analysis', 'ai']).optional(),
  aiMetadata: AIViewMetadataSchema.optional(),
  graphMode: z.enum(['overview', 'full']).optional(),
  expandedSchemaView: ExpandedSchemaViewSchema.optional(),
  showExpandedSchemaClusters: z.boolean().optional(),
}).strict();

/** A saved filter profile snapshot: view shape, filter rules, and optional AI metadata. */
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

/** Stored database connection metadata. */
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
  connectionId: z.string().optional(),
}).strict();

/** Stored database connection metadata. See {@link StoredConnectionInfoSchema} for the persistence-tolerance contract. */
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

/** Zod schema defining a workspace project configuration. */
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

/** Reading counterpart of {@link ProjectSchema} for records already on disk. */
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
  aiMetadata: AIViewMetadataReadSchema.optional(),
  expandedSchemaView: z.object(ExpandedSchemaViewSchema.shape).optional(),
});

/** Persisted-record counterpart of {@link ProjectSchema}; invalid optional views are skipped individually. */
export const ProjectReadSchema = z.object({
  ...ProjectSchema.shape,
  connection: ProjectConnectionReadSchema,
  filterProfiles: z.array(z.unknown()).transform(profiles => profiles.flatMap(profile => {
    const parsed = FilterProfileReadSchema.safeParse(profile);
    return parsed.success ? [parsed.data] : [];
  })).optional(),
});

/** Envelope version stamped on every host→webview frame by the `postValidated` send choke point. */
export const BRIDGE_PROTOCOL_VERSION = 2;

/** Envelope shape read at receive sites before the payload union is parsed. */
export type BridgeEnvelope = { protocolVersion?: unknown };

/** Validated host→webview frame: either the parsed payload or a classified rejection. */
export type ValidatedBridgeFrame<S extends z.ZodTypeAny> =
  | { ok: true; data: z.infer<S>; msgType: string }
  | { ok: false; reason: 'parse' | 'version'; msgType: string; version: unknown; issues?: z.ZodIssue[] };

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
    return { ok: false, reason: 'parse', msgType, version, issues: parsed.error.issues };
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

/** Zod schema of the `render-state` buffer the main webview mirrors to the host after each render. */
const RenderStateSnapshotSchema = z.looseObject({
  highlightedNodeId: z.string().nullable().optional(),
  affordances: TraceAffordanceSnapshotSchema.nullable().optional(),
  traceScope: RenderTraceScopeSchema.nullable().optional(),
  connectivity: RenderConnectivitySchema.optional(),
});

/** Validated `render-state` buffer: highlighted node, affordances, trace scope and connectivity. */
export type RenderStateSnapshot = z.infer<typeof RenderStateSnapshotSchema>;

/** Zod schema of the analytics/bookmark extras carried on `uiState.screenState`, not in `render-state`. */
const ScreenStateExtrasSchema = z.looseObject({
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

/** Zod schema of the `filter-changed` ui-state buffer the main webview posts on every view change. */
const UiStateSnapshotSchema = z.looseObject({
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

/** Zod schema representing the complete discriminated union of message types sent from the VS Code Extension Host to the React Webview. */
export const ExtensionToWebviewMsgSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('dacpac-model'), model: DatabaseModelSchema, config: ExtensionConfigSchema, sourceName: z.string(), autoVisualize: z.boolean().optional(), isDemo: z.boolean().optional() }),
  z.object({ type: z.literal('db-model'), model: DatabaseModelSchema, config: ExtensionConfigSchema, sourceName: z.string() }),
  z.object({ type: z.literal('projects-list'), projects: z.array(ProjectSchema), lastOpenedId: z.string().nullable(), lastWizardView: z.enum(['main', 'projects']).optional() }),
  z.object({ type: z.literal('detail-closed') }),
  z.object({ type: z.literal('dacpac-schema-preview'), preview: SchemaPreviewSchema, config: ExtensionConfigSchema, sourceName: z.string(), filePath: z.string().optional() }),
  z.object({ type: z.literal('db-schema-preview'), preview: SchemaPreviewSchema, config: ExtensionConfigSchema, sourceName: z.string() }),
  z.object({ type: z.literal('db-progress'), step: z.number(), total: z.number(), label: z.string() }),
  z.object({ type: z.literal('load-started') }),
  z.object({ type: z.literal('load-cancelled') }),
  z.object({ type: z.literal('db-cancelled') }),
  z.object({ type: z.literal('db-error'), message: z.string(), phase: z.string() }),
  z.object({ type: z.literal('last-dacpac-gone') }),
  z.object({ type: z.literal('rebuild-config'), config: ExtensionConfigSchema }),
  z.object({ type: z.literal('focus-object'), schema: z.string(), name: z.string() }),
  z.object({ type: z.literal('reload-source') }),
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

/** TypeScript type inferred from the ExtensionToWebviewMsgSchema. Represents all valid messages dispatched to the Webview. */
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

/** Zod schema for messages sent from the primary lineage-graph webview to the extension host. */
export const MainPanelToExtensionMsgSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('show-detail'), node: LineageNodeSchema.optional(), findQuery: z.string().optional() }),
  z.object({ type: z.literal('update-detail'), node: LineageNodeSchema.optional(), findQuery: z.string().optional() }),
  z.object({ type: z.literal('cancel-load') }),
  z.object({ type: z.literal('open-dacpac') }),
  z.object({ type: z.literal('load-project'), id: z.string() }),
  z.object({ type: z.literal('save-project'), project: ProjectSchema }),
  z.object({ type: z.literal('delete-project'), id: z.string() }),
  z.object({ type: z.literal('load-demo') }),
  z.object({ type: z.literal('dacpac-visualize'), schemas: z.array(z.string()).max(MAX_ID_LIST_LENGTH), projectName: z.string().optional() }),
  z.object({ type: z.literal('db-visualize'), schemas: z.array(z.string()).max(MAX_ID_LIST_LENGTH), projectName: z.string().optional() }),
  z.object({ type: z.literal('filter-changed'), uiState: UiStateSnapshotSchema }),
  z.object({ type: z.literal('render-state'), renderState: RenderStateSnapshotSchema }),
  z.object({ type: z.literal('db-connect') }),
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
  z.object({ type: z.literal('export-file'), defaultName: z.string(), data: z.string().max(50_000_000) }),
  z.object({ type: z.literal('ai-open-in-editor'), markdown: z.string().max(AI_REPORT_MARKDOWN_MAX_CHARS) }),
  z.object({ type: z.literal('log'), level: z.enum(['info', 'warn', 'debug']).optional(), text: z.string().max(100_000) }),
  WebviewErrorMessageSchema,
  WebviewWarningMessageSchema,
  z.object({ type: z.literal('view-render-result'), rendered: z.number(), of: z.number(), unresolved: z.array(z.string()) }),
]);

/** Messages sent from the main lineage-graph webview to the extension host. */
export type MainPanelToExtensionMsg = z.infer<typeof MainPanelToExtensionMsgSchema>;

/** Zod schema for messages sent from the detail-panel webview to the extension host. */
export const DetailPanelToExtensionMsgSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('detail-ready'), findQuery: z.string().optional() }),
  z.object({ type: z.literal('table-stats-request'), schema: z.string(), objectName: z.string(), mode: z.enum(['quick', 'standard']), columns: z.array(ColumnDefSchema) }),
  z.object({ type: z.literal('close-detail') }),
  WebviewErrorMessageSchema,
  WebviewWarningMessageSchema,
]);

/** Messages sent from the detail-panel webview to the extension host. */
export type DetailPanelToExtensionMsg = z.infer<typeof DetailPanelToExtensionMsgSchema>;

/** Every message either webview may post to the extension host. */
export type WebviewToExtensionMsg = MainPanelToExtensionMsg | DetailPanelToExtensionMsg;

/** Zod schema for messages sent from the extension host **to the detail-panel webview**. */
export const ExtensionToDetailMsgSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('detail-update'), node: LineageNodeSchema, findQuery: z.string().optional(), config: z.any() }),
  z.object({ type: z.literal('detail-clear') }),
  z.object({ type: z.literal('table-stats-result'), objectRef: z.object({ schema: z.string(), objectName: z.string() }), stats: z.any(), mode: z.enum(['quick', 'standard']) }),
  z.object({ type: z.literal('table-stats-error'), objectRef: z.object({ schema: z.string(), objectName: z.string() }), message: z.string() }),
]);

/** Messages sent from the extension host to the detail-panel webview. */
export type ExtensionToDetailMsg = z.infer<typeof ExtensionToDetailMsgSchema>;
