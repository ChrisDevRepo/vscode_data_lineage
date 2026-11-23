import { z } from 'zod';
import { ExplorationDepthSelectionSchema } from './explorationDepthContract';
import { OBJECT_TYPES, type ExtensionConfig, type SchemaPreview, type TraceAffordanceSnapshot } from '../types';

/**
 * Bridge contract: the strict, type-safe contract for every IPC message between the Extension Host
 * and the Webview.
 *
 * @packageDocumentation
 */

const ObjectTypeSchema = z.enum(OBJECT_TYPES);

/** Upper bound on object ids in a tool call or bridge message: an input-size check, not a scope. */
export const MAX_ID_LIST_LENGTH = 500;

/**
 * Upper bound, in characters, on the AI report markdown the webview hands back for "Open in
 * editor". The `ai-open-in-editor` payload is otherwise the one unbounded string the webview can
 * post (no field cap composes into a total); a report is one model turn's prose, so a larger
 * payload is a malformed or hostile frame.
 * @internal
 */
export const AI_REPORT_MARKDOWN_MAX_CHARS = 200_000;

/**
 * Upper bound, in characters, on the file text the webview hands to the host for `export-file`.
 * Draw.io export measured about 1.6 KB per object (236,627 chars for 148 nodes and 164 edges,
 * 396,332 for 249 and 303): 8-10 MB at the 5000-object limit, so 50 MB keeps at least 5x margin.
 * @internal
 */
export const EXPORT_FILE_MAX_CHARS = 50 * 1024 * 1024;

/** Upper bound, in characters, on one webview `log` line; real lines are a few hundred. */
const WEBVIEW_LOG_MAX_CHARS = 100_000;

/**
 * Link scheme of the engine-assembled object links in AI report markdown,
 * `[label](#focus-node:<encoded id>)`; resolves only inside the graph webview's click handler.
 */
export const FOCUS_NODE_HREF_PREFIX = '#focus-node:';

const FOCUS_NODE_LINK_RE = new RegExp(String.raw`\[([^\]]*)\]\(${FOCUS_NODE_HREF_PREFIX}[^)]*\)`, 'g');

/**
 * Rewrites every `[label](#focus-node:<id>)` to plain `label` for a surface outside the graph
 * webview, where the scheme has no target; other links are untouched.
 */
export function stripFocusNodeLinks(markdown: string): string {
  return markdown.replace(FOCUS_NODE_LINK_RE, '$1');
}

/**
 * Maximum object ids one screen-state list carries: the cap the presenter applies when rendering a
 * screen-fact id list (overflow is reported as a count) and, identically, the cap on the ids a
 * `lineage_get_screen_state` recall may name, so one governor sizes both ends. `package.json`'s
 * `maxItems` is generated from the schema by `scripts/generate-tool-manifest.mjs`, never by hand.
 */
export const SCREEN_STATE_MAX_IDS = 20;

/**
 * Sentinel `upstreamLevels`/`downstreamLevels` value meaning "every level", not a literal depth.
 * The trace controls encode an unbounded side as this value and the banner decodes it to "All", so
 * it crosses the bridge as an ordinary number. Every producer and consumer must use this constant:
 * a surface treating it as a depth reports nine quadrillion levels.
 */
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

/**
 * Zod schema mirroring the runtime `ColumnDef` (`engine/types.ts`); names and types must stay
 * aligned with it. `nullable` and `extra` are string columns of raw extractor metadata; primary-key
 * participation is `pkOrdinal`, not a boolean.
 */
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

/**
 * Strict IPC boundary schema for lineage nodes. Declares every `LineageNode` field: Zod strips
 * undeclared keys, so a field missing here is silently dropped from every model the host sends
 * (external-reference icons, detail-panel FKs).
 */
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

/** Zod schema of a directed dependency or execution relationship between two lineage nodes. */
const LineageEdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  type: z.enum(['body', 'dependency', 'exec']).optional(),
});

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
}).passthrough();

/** Zod schema for a catalog entry mapping an object namespace to its physical representation. */
const CatalogEntrySchema = z.object({
  schema: z.string(),
  name: z.string(),
  type: ObjectTypeSchema,
  externalType: z.enum(['et', 'file', 'db']).optional(),
});

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
    spDetails: z.array(z.any()),
  }).optional(),
  warnings: z.array(z.string()).optional(),
  dbPlatform: z.string().optional(),
  source: z.enum(['dacpac', 'database']).optional(),
});

/**
 * Zod schema carrying the host's settings snapshot across the bridge, pinned to
 * {@link ExtensionConfig} so a parsed message keeps its field types instead of degrading to `any`.
 * `Partial` is the honest shape: the host is the sole producer, so a mismatch is a host refactor
 * bug that must fail at the boundary.
 */
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

/**
 * Bidirectional shape equality for {@link extensionConfigSchemaMatchesInterface}; tuple-wrapped
 * (`[A] extends [B]`) so the whole object shape is compared instead of distributing per property
 * over a union.
 */
type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Compile-time drift guard for {@link ExtensionConfigSchema}: fails to typecheck when the schema's
 * inferred shape and `Partial<ExtensionConfig>` diverge in either direction. The one-directional
 * `z.ZodType<...>` annotation catches a schema too loose; this also catches one too narrow (missing
 * a field the interface has).
 */
const extensionConfigSchemaMatchesInterface: AssertExact<z.infer<typeof ExtensionConfigSchema>, Partial<ExtensionConfig>> = true;
void extensionConfigSchemaMatchesInterface;

/**
 * Zod schema of the serialized visual filter configuration (inclusion/exclusion parameters for
 * graph nodes), used to persist and restore view states.
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
 * Column-transform classes carried on a column-lineage edge, aligned to OpenLineage's
 * `ColumnLineageDatasetFacet` transformation types so an exported facet needs no translation table.
 * Multi-select: one edge is routinely several at once (an aggregate over a computed expression).
 * The single home for the value set (ai, engine and webview all read it here), so no surface
 * carries a value the others reject.
 */
export const COLUMN_TRANSFORM_CLASSES = ['pass_through', 'compute', 'aggregate', 'combine', 'filter'] as const;

export type ColumnTransformClass = typeof COLUMN_TRANSFORM_CLASSES[number];

/**
 * Whether a transform class carries the upstream value into the output (DIRECT) or only shaped
 * which rows appear (INDIRECT), in OpenLineage's terms. Exhaustive and load-bearing: no class is
 * both, so a renderer can key a distinct edge treatment off this map alone; a class added to
 * {@link COLUMN_TRANSFORM_CLASSES} without an entry fails to typecheck.
 */
export const COLUMN_TRANSFORM_DIRECTION: Readonly<Record<ColumnTransformClass, 'DIRECT' | 'INDIRECT'>> = {
  pass_through: 'DIRECT',
  compute:      'DIRECT',
  aggregate:    'DIRECT',
  combine:      'INDIRECT',
  filter:       'INDIRECT',
};

/**
 * Whether a classified column only shaped which rows appear (every class INDIRECT). `transforms`
 * absent or empty means unclassified; `true` only for a non-empty list with no DIRECT class.
 */
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
  /** Absent whenever the model did not classify the edge; the engine never guesses one. */
  transforms: z.array(ColumnTransformClassSchema).optional(),
  /**
   * Optional one-clause model note for the edge ("SUM of line totals"). Surface text only: the
   * webview prints it in the edge tooltip and nothing parses it, so an edge without one reads the
   * structural description.
   */
  note: z.string().optional(),
}).strict();

export type ColumnAspectEdge = z.infer<typeof ColumnAspectEdgeSchema>;

const ColumnAspectSchema = z.object({
  edges: z.array(ColumnAspectEdgeSchema),
}).strict();

const NodeVerdictSchema = z.object({
  nodeId: z.string(),
  verdict: z.enum(['analyze', 'passthrough', 'prune']),
}).strict();

export type NodeVerdict = z.infer<typeof NodeVerdictSchema>;

/** Zod schema of AI-generated lineage metadata: grouping, badging, highlighting, descriptions. */
const AIViewMetadataSchema = z.object({
  summary: z.string().optional(),
  description: z.string().optional(),
  createdAt: z.string(),
  modelName: z.string(),
  /** Id of the AI run that authored the view; pairs the bookmark with its persisted run record. */
  runId: z.string().optional(),
  highlightGroups: z.array(AIHighlightGroupSchema),
  badges: z.array(AINodeTextSchema),
  notes: z.array(AINodeTextSchema).optional(),
  layoutDirection: z.enum(['LR', 'TB']).optional(),
  /**
   * Column trace edges. Each edge carries the analyzing hop node plus source/destination so every
   * result node can show column flow data. Only present during CT sessions.
   */
  columnAspect: ColumnAspectSchema.optional(),
  /** Per-node CT verdict so the webview marks column lines without an AI-contract change. */
  nodeVerdicts: z.array(NodeVerdictSchema).optional(),
}).strict();

export type AIViewMetadata = z.infer<typeof AIViewMetadataSchema>;

const ExpandedSchemaViewSchema = z.object({
  focusNodeId: z.string().nullable(),
  expandedSchemas: z.array(z.string()),
}).strict();

/**
 * Zod schema of a saved filter profile snapshot. `graphMode`, `expandedSchemaView` and
 * `showExpandedSchemaClusters` are the view shape (schema clusters, individual objects, or a mix);
 * they stay optional so a profile missing them still restores.
 */
const FilterProfileSchema = z.object({
  id: z.string(),
  /**
   * Absent on legacy views; current encoding preserves literal identifier delimiters and URL
   * identity.
   */
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

/** A saved filter profile snapshot: layout, filter rules, and optional AI metadata. */
export type FilterProfile = z.infer<typeof FilterProfileSchema>;

/** Labels of bookmark-view sources; the single owner, read by the banner and the info card. */
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
 * Identifier of the implementation that opens database connections. `mssqlExtension` is read only
 * to detect a project saved with the retired mssql extension connection.
 */
const ConnectionProviderIdSchema = z.enum(['mssqlExtension', 'builtIn']);
export type ConnectionProviderId = z.infer<typeof ConnectionProviderIdSchema>;

/**
 * Stored database connection metadata. `provider` and `connectionId` identify how it is reopened: a
 * record without `provider` was written for the mssql extension and reads as `mssqlExtension`;
 * `connectionId` names a `dataLineageViz.database.connections` entry and never carries a
 * credential.
 *
 * `.strict()` is load-bearing: unknown fields (a leaked `password` above all) are rejected rather
 * than persisted or replayed to the webview. Tolerance is granted per named field only, because
 * `migrateProjectStore` discards any record that fails this schema, and Integrated, Entra and
 * legacy connections omit `user`/`authenticationType`/typed `port` respectively.
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
  provider: ConnectionProviderIdSchema.optional(),
  connectionId: z.string().optional(),
}).strict();

/** Stored database connection metadata; see {@link StoredConnectionInfoSchema} for tolerance. */
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

/** Zod schema of a workspace project: related database connections plus filter profiles. */
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
 * The project a `save-project` frame carries. The webview saves only dacpac projects; a database
 * connection record is written by the host alone, through `stripSensitiveFields`.
 */
const DacpacProjectSchema = ProjectSchema.extend({ connection: DacpacConnectionSchema });

/**
 * Reading counterpart of {@link ProjectSchema} for records already on disk. Same fields, but
 * unknown ones are dropped instead of rejecting the record: an older build's record legitimately
 * carries keys this one never declared, and discarding the whole project over one is silent
 * user-data loss. Rebuilt level by level from the strict schemas' shapes, so an added field needs
 * no second declaration.
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
  aiMetadata: AIViewMetadataReadSchema.optional(),
  expandedSchemaView: z.object(ExpandedSchemaViewSchema.shape).optional(),
});

/**
 * Persisted counterpart of {@link ProjectSchema}; see {@link StoredConnectionInfoReadSchema}. A
 * saved view that fails its schema is skipped alone, so one unreadable view never drops its
 * project.
 */
export const ProjectReadSchema = z.object({
  ...ProjectSchema.shape,
  connection: ProjectConnectionReadSchema,
  filterProfiles: z.array(z.unknown()).transform(profiles => profiles.flatMap(profile => {
    const parsed = FilterProfileReadSchema.safeParse(profile);
    return parsed.success ? [parsed.data] : [];
  })).optional(),
});

/**
 * Envelope version stamped on every host→webview frame by the `postValidated` choke point. An
 * *envelope* field, not a schema field, so the message unions stay untouched. Bump it when a
 * message shape changes in a way an older peer bundle would misread; a stale webview then fails
 * loudly at the receive site instead of silently mis-rendering.
 */
export const BRIDGE_PROTOCOL_VERSION = 2;

/** Envelope shape read at receive sites before the payload union is parsed. */
export type BridgeEnvelope = { protocolVersion?: unknown };

/**
 * Validated host→webview frame: the parsed payload or a classified rejection. The single owner of
 * the receive-side seam both webviews repeat: Zod-parse the raw frame, then compare the envelope
 * version. A parse failure carries its Zod issues; a version mismatch means a stale bundle.
 */
export type ValidatedBridgeFrame<S extends z.ZodTypeAny> =
  | { ok: true; data: z.infer<S>; msgType: string }
  | { ok: false; reason: 'parse'; msgType: string; version: unknown; issues: z.core.$ZodIssue[] }
  | { ok: false; reason: 'version'; msgType: string; version: unknown };

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

/**
 * Host-log lines for a frame that failed the Zod parse, in the webview `log` message shape. The
 * warn line carries the message type and the distinct issue codes; the key paths and issue texts,
 * which name payload fields, go to the debug line only.
 */
export function parseRejectionLogs(
  tag: string,
  frame: { msgType: string; issues: readonly z.core.$ZodIssue[] },
): Array<{ type: 'log'; level: 'warn' | 'debug'; text: string }> {
  const codes = [...new Set(frame.issues.map((issue) => issue.code))].join(',');
  const paths = frame.issues.slice(0, 5).map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
  return [
    { type: 'log', level: 'warn', text: `[${tag}] Host message "${frame.msgType}" rejected — issues=${codes}` },
    { type: 'log', level: 'debug', text: `[${tag}] Host message "${frame.msgType}" issue paths — ${paths.join('; ')}` },
  ];
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
 * Fields a host reader walks structurally (highlighted node, its add/prune affordances, trace scope
 * id lists, rendered connectivity) are typed; every other key the webview adds is kept literally,
 * so an unrecognized field never fails the frame. A frame whose walked fields are malformed is
 * rejected and logged at the receive site and never reaches a reader.
 */
const RenderStateSnapshotSchema = z.looseObject({
  highlightedNodeId: z.string().nullable().optional(),
  affordances: TraceAffordanceSnapshotSchema.nullable().optional(),
  traceScope: RenderTraceScopeSchema.nullable().optional(),
  connectivity: RenderConnectivitySchema.optional(),
});

/** Validated `render-state` buffer: highlighted node, affordances, trace scope and connectivity. */
export type RenderStateSnapshot = z.infer<typeof RenderStateSnapshotSchema>;

/**
 * Zod schema of the analytics/bookmark extras on `uiState.screenState`, not in `render-state`. Same
 * tolerance as {@link RenderStateSnapshotSchema}: walked fields typed, extras kept.
 */
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

/**
 * Zod schema of the `filter-changed` ui-state buffer posted on every view change. The host lifts
 * `filter`, `graphMode`, `filteredCount` and `renderLimitHit` onto typed session fields and the
 * screen-state readers walk `trace` and `screenState`, so those are typed; the filter reuses the
 * persisted {@link SerializedFilterState} contract. Unknown keys are kept literally.
 */
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

/**
 * Host→webview message types that answer one load and so carry that load's `loadId`. The webview
 * names a load with the `loadId` on its request; the host stamps results with it and
 * `cancel-load{loadId}` stops it. The webview drops a result of a load it cancelled or replaced.
 * The id is optional on the wire: a request without one is answered unstamped, and a result the
 * host posts on its own (session restore, the external-project command) names no load and always
 * applies.
 */
export const LOAD_RESULT_TYPES = [
  'dacpac-schema-preview', 'dacpac-model', 'db-schema-preview', 'db-model',
  'db-progress', 'db-error', 'db-cancelled', 'last-dacpac-gone',
] as const;

/**
 * Zod schema of the discriminated union of messages from the Extension Host to the React Webview;
 * all outgoing communication is validated against it.
 */
export const ExtensionToWebviewMsgSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('dacpac-model'), model: DatabaseModelSchema, config: ExtensionConfigSchema, sourceName: z.string(), autoVisualize: z.boolean().optional(), isDemo: z.boolean().optional(), loadId: z.string().optional(), projectId: z.string().optional() }),
  z.object({ type: z.literal('db-model'), model: DatabaseModelSchema, config: ExtensionConfigSchema, sourceName: z.string(), loadId: z.string().optional(), projectId: z.string().optional() }),
  z.object({ type: z.literal('projects-list'), projects: z.array(ProjectSchema), lastOpenedId: z.string().nullable(), lastWizardView: z.enum(['main', 'projects']).nullish() }),
  z.object({ type: z.literal('detail-closed') }),
  z.object({ type: z.literal('dacpac-schema-preview'), preview: SchemaPreviewSchema, config: ExtensionConfigSchema, sourceName: z.string(), filePath: z.string().optional(), loadId: z.string().optional() }),
  z.object({ type: z.literal('db-schema-preview'), preview: SchemaPreviewSchema, config: ExtensionConfigSchema, sourceName: z.string(), loadId: z.string().optional() }),
  z.object({ type: z.literal('db-progress'), step: z.number().optional(), total: z.number().optional(), label: z.string(), loadId: z.string().optional() }),
  z.object({ type: z.literal('db-cancelled'), loadId: z.string().optional() }),
  z.object({ type: z.literal('db-error'), message: z.string(), loadId: z.string().optional(), transient: z.boolean().optional() }),
  z.object({ type: z.literal('last-dacpac-gone'), loadId: z.string().optional() }),
  z.object({ type: z.literal('rebuild-config'), config: ExtensionConfigSchema }),
  z.object({ type: z.literal('focus-object'), schema: z.string(), name: z.string() }),
  z.object({ type: z.literal('reload-source') }),
  /**
   * Open Wizard while a graph is loaded: runs the toolbar Back action, with its unsaved-changes
   * bar.
   */
  z.object({ type: z.literal('request-back') }),
  z.object({ type: z.literal('ai-view-preview'), name: z.string(), nodeIds: z.array(z.string()), aiMetadata: AIViewMetadataSchema }),
  z.object({ type: z.literal('ai-view-clear') }),
]);

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
 * Zod schema for messages from the primary lineage-graph webview to the host. The detail-panel
 * webview runs in a separate process with its own schema ({@link DetailPanelToExtensionMsgSchema});
 * separate unions let each dispatcher be exhaustive over its own variants.
 */
export const MainPanelToExtensionMsgSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('show-detail'), node: LineageNodeSchema.optional(), findQuery: z.string().optional() }),
  z.object({ type: z.literal('update-detail'), node: LineageNodeSchema.optional(), findQuery: z.string().optional() }),
  z.object({ type: z.literal('open-dacpac'), loadId: z.string().optional() }),
  z.object({ type: z.literal('load-project'), id: z.string(), loadId: z.string().optional() }),
  z.object({ type: z.literal('save-project'), project: DacpacProjectSchema }),
  z.object({ type: z.literal('delete-project'), id: z.string() }),
  z.object({ type: z.literal('load-demo'), loadId: z.string().optional() }),
  z.object({ type: z.literal('dacpac-visualize'), schemas: z.array(z.string()), projectName: z.string().optional(), projectId: z.string().optional(), loadId: z.string().optional() }),
  z.object({ type: z.literal('db-visualize'), schemas: z.array(z.string()), projectName: z.string().optional(), loadId: z.string().optional() }),
  z.object({ type: z.literal('filter-changed'), uiState: UiStateSnapshotSchema }),
  z.object({ type: z.literal('render-state'), renderState: RenderStateSnapshotSchema }),
  z.object({ type: z.literal('db-connect'), loadId: z.string().optional() }),
  z.object({ type: z.literal('cancel-load'), loadId: z.string() }),
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
  z.object({ type: z.literal('export-file'), defaultName: z.string(), data: z.string().max(EXPORT_FILE_MAX_CHARS) }),
  z.object({ type: z.literal('ai-open-in-editor'), markdown: z.string().max(AI_REPORT_MARKDOWN_MAX_CHARS) }),
  z.object({ type: z.literal('log'), level: z.enum(['info', 'warn', 'error', 'debug']).optional(), text: z.string().max(WEBVIEW_LOG_MAX_CHARS) }),
  WebviewErrorMessageSchema,
  WebviewWarningMessageSchema,
  z.object({ type: z.literal('view-render-result'), rendered: z.number(), of: z.number(), unresolved: z.array(z.string()) }),
]);

/** Messages sent from the main lineage-graph webview to the extension host. */
export type MainPanelToExtensionMsg = z.infer<typeof MainPanelToExtensionMsgSchema>;

/** Zod schema for messages from the detail-panel webview to the host. */
export const DetailPanelToExtensionMsgSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('detail-ready'), findQuery: z.string().optional() }),
  z.object({ type: z.literal('table-stats-request'), schema: z.string(), objectName: z.string(), mode: z.enum(['quick', 'standard']), columns: z.array(ColumnDefSchema) }),
  z.object({ type: z.literal('close-detail') }),
  WebviewErrorMessageSchema,
  WebviewWarningMessageSchema,
]);

/** Messages sent from the detail-panel webview to the extension host. @public */
export type DetailPanelToExtensionMsg = z.infer<typeof DetailPanelToExtensionMsgSchema>;

/**
 * Every message either webview may post to the host. The two panels keep separate dispatch unions
 * so each dispatcher stays exhaustive. One `acquireVsCodeApi()` handle type serves both bundles, so
 * `postMessage` is typed with this union: a shape neither dispatcher can receive fails to compile
 * instead of being dropped at the Zod seam.
 * @public
 */
export type WebviewToExtensionMsg = MainPanelToExtensionMsg | DetailPanelToExtensionMsg;

/** Settings the detail panel reads, synchronized from VS Code settings and the active session. */
const DetailConfigSchema = z.object({
  isDbMode: z.boolean(),
  statsEnabled: z.boolean(),
  excludeExternalTables: z.boolean(),
  standardModeEnabled: z.boolean(),
});

/** Detail-panel settings carried by `detail-update`. */
export type DetailConfig = z.infer<typeof DetailConfigSchema>;

/** Statistical profile for a single column. */
const ColumnStatsSchema = z.object({
  /** The original column name. */
  name: z.string(),
  /** The SQL data type (e.g., 'nvarchar(50)'). */
  type: z.string(),
  /** Number of unique values (may be approximated). */
  distinctCount: z.number(),
  nullCount: z.number().nullable(),
  /** Percentage of rows containing NULL. */
  nullPercent: z.number().nullable(),
  /** Ratio of non-NULL values to total rows. */
  completeness: z.number(),
  /** Ratio of distinct values to total rows. */
  uniqueness: z.number(),
  /** Minimum value (formatted as string). */
  min: z.string().optional(),
  /** Maximum value (formatted as string). */
  max: z.string().optional(),
  mean: z.number().optional(),
  /** Sample standard deviation (`STDEV`). */
  stdDev: z.number().optional(),
  minLength: z.number().optional(),
  maxLength: z.number().optional(),
  /** Count of values equal to 0 (numeric only). */
  zeroCount: z.number().optional(),
  /** Count of empty strings (string only). */
  emptyCount: z.number().optional(),
  /** Whether profiling was skipped (e.g., for XML/LOB types). */
  skipped: z.boolean().optional(),
});

/** Statistical profile for a single column; one schema serves the host build and the panel. */
export type ColumnStats = z.infer<typeof ColumnStatsSchema>;

/** Comprehensive statistical profile for a database table. */
const TableStatsSchema = z.object({
  /** Total rows evaluated (or sampled). */
  rowCount: z.number(),
  columns: z.array(ColumnStatsSchema),
  /** Whether the data was sampled or fully scanned. */
  sampled: z.boolean(),
  /** The percentage of the table that was sampled. */
  samplePercent: z.number().optional(),
  warnings: z.array(z.string()).optional(),
});

export type TableStats = z.infer<typeof TableStatsSchema>;

/** The object a table-stats reply answers, so the panel applies it only to that node. */
const TableStatsObjectRefSchema = z.object({ schema: z.string(), objectName: z.string() });

/**
 * Zod schema for messages from the host **to the detail-panel webview**, mirroring
 * {@link DetailPanelToExtensionMsgSchema} for the reverse direction. Sends go through the
 * `postToDetail` sink so they are validated like the main panel's `postToWebview`; never a raw
 * `detailPanel.webview.postMessage`.
 */
export const ExtensionToDetailMsgSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('detail-update'), node: LineageNodeSchema, findQuery: z.string().optional(), config: DetailConfigSchema }),
  z.object({ type: z.literal('detail-clear') }),
  z.object({ type: z.literal('table-stats-result'), objectRef: TableStatsObjectRefSchema, stats: TableStatsSchema, mode: z.enum(['quick', 'standard']) }),
  z.object({ type: z.literal('table-stats-error'), objectRef: TableStatsObjectRefSchema, message: z.string() }),
]);

/** Messages sent from the extension host to the detail-panel webview. */
export type ExtensionToDetailMsg = z.infer<typeof ExtensionToDetailMsgSchema>;
