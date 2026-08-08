import { z } from 'zod';
import { ExplorationDepthSelectionSchema } from './explorationDepthContract';
import { OBJECT_TYPES, type ExtensionConfig } from '../types';

/**
 * ─── Bridge Contract ────────────────────────────────────────────────────────
 *
 * This module defines the strict type-safe contract for all IPC messages
 * between the Extension Host and the Webview.
 *
 * @packageDocumentation
 */

/**
 * Zod schema defining the valid types of database objects in the lineage graph.
 *
 * @remarks
 * Supports the primary SQL Server object types used in lineage analysis.
 * - `table`: Physical data storage
 * - `view`: Virtual table based on a query
 * - `procedure`: Stored procedure containing logic
 * - `function`: User-defined function
 * - `external`: Reference to an object outside the current model
 *
 * @example
 * ```typescript
 * const type = ObjectTypeSchema.parse('table');
 * ```
 */
export const ObjectTypeSchema = z.enum(OBJECT_TYPES);

/** Upper bound on scope arrays carried across the bridge (DoS / payload guard). */
export const AI_MAX_SCOPE_NODE_IDS = 500;

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
 * Zod schema mirroring the runtime {@link import('../types').ColumnDef} shape.
 *
 * @remarks
 * Field names and types must stay aligned with `engine/types.ts#ColumnDef`.
 * `nullable` and `extra` are string columns carrying raw metadata from the
 * dacpac / DMV extractors; primary-key participation is signalled by
 * `pkOrdinal`, not a boolean.
 */
export const ColumnDefSchema = z.object({
  name: z.string(),
  type: z.string(),
  nullable: z.string(),
  extra: z.string(),
  unique: z.string().optional(),
  check: z.string().optional(),
  pkOrdinal: z.number().optional(),
});

/** Strict IPC boundary schema for lineage nodes sent between the extension host and webview. */
export const LineageNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  schema: z.string(),
  fullName: z.string(),
  type: ObjectTypeSchema,
  columns: z.array(ColumnDefSchema).optional(),
  bodyScript: z.string().optional(),
});

/**
 * Zod schema defining the structure of a lineage edge (directed link) in the graph.
 *
 * @remarks
 * Represents a dependency or execution relationship between two lineage nodes.
 *
 * @property {string} source - The ID of the source node.
 * @property {string} target - The ID of the target node.
 * @property {'body' | 'dependency' | 'exec'} [type] - The nature of the relationship.
 */
export const LineageEdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  type: z.enum(['body', 'dependency', 'exec']).optional(),
});

/**
 * Zod schema defining the summary information for a database schema.
 *
 * @remarks
 * Tracks node counts and object types categorized by schema name for UI filtering.
 *
 * @property {string} name - The name of the schema.
 * @property {number} nodeCount - Total number of objects in this schema.
 * @property {Record<string, number>} types - Count of each object type within the schema.
 */
export const SchemaInfoSchema = z.object({
  name: z.string(),
  nodeCount: z.number(),
  types: z.record(ObjectTypeSchema, z.number()),
});

/**
 * Zod schema defining a catalog entry for tracking nodes in the global index.
 *
 * @remarks
 * Helps map object namespaces to physical representations during resolution.
 *
 * @property {string} schema - The schema of the object.
 * @property {string} name - The name of the object.
 * @property {z.infer<typeof ObjectTypeSchema>} type - The classification of the object.
 * @property {'et' | 'file' | 'db'} [externalType] - The source type for external refs.
 */
export const CatalogEntrySchema = z.object({
  schema: z.string(),
  name: z.string(),
  type: ObjectTypeSchema,
  externalType: z.enum(['et', 'file', 'db']).optional(),
});

/** Strict IPC boundary schema for DatabaseModel payloads crossing between the host and webview. */
export const DatabaseModelSchema = z.object({
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
 * to `any`. `Partial` is the honest shape: `buildExtensionConfig` reads only the settings the
 * webview renders from, and the receiver layers the rest over `DEFAULT_CONFIG`. Field-level
 * validation matches the rest of the bridge cage — the host is the sole producer, so a mismatch
 * here is a host refactor bug that must fail at the boundary, not as a downstream `undefined`.
 * `parseRules` alone stays structural: `loadRules` is its per-rule validator on the host side and
 * the webview never executes rules.
 */
export const ExtensionConfigSchema: z.ZodType<Partial<ExtensionConfig>> = z.object({
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
export const SerializedFilterStateSchema = z.object({
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

export type SerializedFilterState = z.infer<typeof SerializedFilterStateSchema>;

export const AIHighlightColorSchema = z.enum(['source', 'transform', 'target', 'good', 'warn', 'fail']);

export type AIHighlightColor = z.infer<typeof AIHighlightColorSchema>;

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
 * Zod schema defining AI-generated metadata for enhancing the lineage graph UI.
 *
 * @remarks
 * Contains custom grouping, badging, highlighting, and descriptive text generated by the AI agent.
 */
export const AIViewMetadataSchema = z.object({
  summary: z.string().optional(),
  description: z.string().optional(),
  createdAt: z.string(),
  modelName: z.string(),
  highlightGroups: z.array(AIHighlightGroupSchema),
  badges: z.array(AINodeTextSchema),
  notes: z.array(AINodeTextSchema).optional(),
  layoutDirection: z.enum(['LR', 'TB']).optional(),
  /** Column trace edges. Each edge carries the analyzing hop node plus source/destination so every result node can show column flow data. Only present during CT sessions. */
  columnAspect: z.object({
    edges: z.array(z.object({
      hopNode:  z.string(),
      fromNode: z.string(),
      toNode:   z.string(),
      fromCol:  z.string(),
      toCol:    z.string(),
    }).strict()),
  }).strict().optional(),
}).strict();

export type AIViewMetadata = z.infer<typeof AIViewMetadataSchema>;

/**
 * Zod schema defining a saved filter profile snapshot.
 *
 * @remarks
 * Stores layout coordinates, zoom state, filter rules, and optional AI enhancements.
 */
export const FilterProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  filter: SerializedFilterStateSchema,
  source: z.enum(['user', 'trace', 'analysis', 'ai']).optional(),
  positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() }).strict()).optional(),
  viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }).strict().optional(),
  aiMetadata: AIViewMetadataSchema.optional(),
}).strict();

export type FilterProfile = z.infer<typeof FilterProfileSchema>;

/**
 * Stored MSSQL connection metadata.
 *
 * @remarks
 * `.strict()` is load-bearing and must stay: unknown fields — a leaked `password` above all —
 * are rejected rather than persisted or replayed to the webview.
 *
 * Tolerance is granted per named field only, because this schema also gates *reading* records
 * written by older builds and `migrateProjectStore` discards whatever fails it. Integrated and
 * Entra connections carry no SQL `user`, older serializations omitted `authenticationType`, and
 * some persisted `port` as a string. Requiring those three silently deleted saved projects.
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

export type StoredConnectionInfo = z.infer<typeof StoredConnectionInfoSchema>;

export const DacpacConnectionSchema = z.object({
  type: z.literal('dacpac'),
  path: z.string(),
  displayName: z.string(),
  schemas: z.array(z.string()),
}).strict();

export type DacpacConnection = z.infer<typeof DacpacConnectionSchema>;

export const DatabaseConnectionSchema = z.object({
  type: z.literal('database'),
  connectionInfo: StoredConnectionInfoSchema,
  sourceName: z.string(),
  schemas: z.array(z.string()),
}).strict();

export type DatabaseConnection = z.infer<typeof DatabaseConnectionSchema>;

export const ProjectConnectionSchema = z.discriminatedUnion('type', [
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

export type Project = z.infer<typeof ProjectSchema>;

/**
 * Envelope version stamped on every host→webview frame by the `postValidated` send choke point.
 *
 * @remarks
 * Deliberately an *envelope* field, not a schema field: it is added after Zod validation and read
 * before it, so the message unions below stay untouched and no handler has to thread it through.
 * Bump it whenever a message shape changes in a way an older peer bundle would misread — a stale
 * webview then fails loudly at the receive site instead of silently mis-rendering.
 */
export const BRIDGE_PROTOCOL_VERSION = 1;

/** Envelope shape read at receive sites before the payload union is parsed. */
export type BridgeEnvelope = { protocolVersion?: unknown };

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
  z.object({ type: z.literal('auto-visualize-start') }),
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
export const WebviewErrorMessageSchema = z.object({
  type: z.literal('error'),
  error: z.string(),
  stack: z.string().optional(),
  componentStack: z.string().optional(),
  source: z.enum(['error-boundary', 'window-error', 'unhandled-rejection']).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  timestamp: z.number().optional(),
});

/** User warning request accepted from both primary and detail panels. */
export const WebviewWarningMessageSchema = z.object({
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
  // `uiState` is a structurally-accessed passthrough buffer mirrored verbatim onto the session for
  // debug dumps; the webview owns its shape. `renderState` is stored opaquely and cast at the dump
  // site, so `unknown` (not `any`) keeps it from leaking untyped access elsewhere.
  z.object({ type: z.literal('filter-changed'), uiState: z.any() }),
  z.object({ type: z.literal('render-state'), renderState: z.unknown() }),
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
