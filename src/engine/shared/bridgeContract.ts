import { z } from 'zod';

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
export const ObjectTypeSchema = z.enum(['table', 'view', 'procedure', 'function', 'external']);

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

/**
 * Zod schema defining the structure of a lineage node (vertex) in the graph.
 * 
 * @remarks
 * Represents a single database object such as a table, view, or stored procedure.
 * 
 * @property {string} id - Unique identifier for the node (usually schema.name).
 * @property {string} name - The object name.
 * @property {string} schema - The database schema name.
 * @property {z.infer<typeof ObjectTypeSchema>} type - The classification of the object.
 * @property {boolean} [isVirtual] - Whether the node is a CTE or temporary structure.
 * @property {boolean} [isExternal] - Whether the node exists outside the analyzed project.
 * @property {z.infer<typeof ColumnDefSchema>[]} [columns] - List of columns if available.
 * @property {string} [bodyScript] - The raw SQL DDL or body of the object.
 */
export const LineageNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  schema: z.string(),
  fullName: z.string(),
  type: ObjectTypeSchema,
  isVirtual: z.boolean().optional(),
  isExternal: z.boolean().optional(),
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

/**
 * Zod schema defining the complete database lineage model state.
 * 
 * @remarks
 * The source of truth for the lineage graph, containing all nodes, edges, and metadata.
 * 
 * @property {z.infer<typeof LineageNodeSchema>[]} nodes - All vertices in the graph.
 * @property {z.infer<typeof LineageEdgeSchema>[]} edges - All directed links in the graph.
 * @property {z.infer<typeof SchemaInfoSchema>[]} schemas - Summary info for all schemas.
 * @property {Record<string, { in: string[], out: string[] }>} neighborIndex - Fast lookup for adjacency.
 * @property {Record<string, z.infer<typeof CatalogEntrySchema>>} catalog - Global index for node resolution.
 * @property {object} [parseStats] - Metadata about the parsing process.
 * @property {string} [dbPlatform] - The targeted database platform (e.g., 'SQLServer').
 */
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
  dbPlatform: z.string().optional(),
});

/**
 * Zod schema for dynamically-typed extension configuration properties.
 * 
 * @remarks
 * Maps setting keys to their current values for UI synchronization.
 */
export const ExtensionConfigSchema = z.record(z.string(), z.any());

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
});

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
  highlightGroups: z.array(z.object({
    label: z.string(),
    color: z.enum(['source', 'transform', 'target', 'good', 'warn', 'fail']),
    nodeIds: z.array(z.string()),
  })),
  badges: z.array(z.object({
    nodeId: z.string(),
    text: z.string(),
  })),
  notes: z.array(z.object({
    nodeId: z.string(),
    text: z.string(),
  })).optional(),
  layoutDirection: z.enum(['LR', 'TB']).optional(),
  /** Column trace edges keyed by the hop node that analyzed them. Only present during CT sessions. */
  columnAspect: z.object({
    edges: z.array(z.object({
      hopNode: z.string(),
      fromCol: z.string(),
      toCol: z.string(),
    })),
  }).optional(),
});

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
  positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).optional(),
  viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }).optional(),
  aiMetadata: AIViewMetadataSchema.optional(),
});

/**
 * Zod schema defining a workspace project configuration.
 * 
 * @remarks
 * Groups related database connections and persistent filter profiles together.
 */
export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  updatedAt: z.string(),
  connection: z.any(), // Keeping connection generic for now to avoid deep MS-SQL types
  filterProfiles: z.array(FilterProfileSchema).optional(),
});

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
  z.object({ type: z.literal('detail-update'), node: LineageNodeSchema, findQuery: z.string().optional(), config: z.any() }),
  z.object({ type: z.literal('detail-closed') }),
  z.object({ type: z.literal('dacpac-schema-preview'), preview: z.any(), config: ExtensionConfigSchema, sourceName: z.string(), filePath: z.string().optional() }),
  z.object({ type: z.literal('db-schema-preview'), preview: z.any(), config: ExtensionConfigSchema, sourceName: z.string() }),
  z.object({ type: z.literal('db-progress'), step: z.number(), total: z.number(), label: z.string() }),
  z.object({ type: z.literal('db-cancelled') }),
  z.object({ type: z.literal('db-error'), message: z.string(), phase: z.string() }),
  z.object({ type: z.literal('last-dacpac-gone') }),
  z.object({ type: z.literal('mssql-status'), available: z.boolean() }),
  z.object({ type: z.literal('rebuild-config'), config: ExtensionConfigSchema }),
  z.object({ type: z.literal('table-stats-result'), stats: z.any(), mode: z.string() }),
  z.object({ type: z.literal('table-stats-error'), message: z.string() }),
  z.object({ type: z.literal('auto-visualize-start') }),
  z.object({
    type: z.literal('error'),
    error: z.string(),
    stack: z.string().optional(),
    componentStack: z.string().optional(),
    source: z.enum(['error-boundary', 'window-error', 'unhandled-rejection']).optional(),
    timestamp: z.number().optional(),
  }),
  z.object({ type: z.literal('toggle-overview') }),
]);

/**
 * TypeScript type inferred from the ExtensionToWebviewMsgSchema.
 * Represents all valid messages dispatched to the Webview.
 */
export type ExtensionToWebviewMsg = z.infer<typeof ExtensionToWebviewMsgSchema>;

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
  z.object({ type: z.literal('save-project'), project: z.any() }),
  z.object({ type: z.literal('delete-project'), id: z.string() }),
  z.object({ type: z.literal('load-demo') }),
  z.object({ type: z.literal('dacpac-visualize'), schemas: z.array(z.string()), projectName: z.string().optional() }),
  z.object({ type: z.literal('db-visualize'), schemas: z.array(z.string()), projectName: z.string().optional() }),
  z.object({ type: z.literal('filter-changed'), uiState: z.any() }),
  z.object({ type: z.literal('db-connect') }),
  z.object({ type: z.literal('check-mssql') }),
  z.object({ type: z.literal('save-view'), projectId: z.string(), profile: z.any() }),
  z.object({ type: z.literal('save-wizard-view'), view: z.enum(['main', 'projects']) }),
  z.object({ type: z.literal('delete-view'), projectId: z.string(), profileId: z.string() }),
  z.object({ type: z.literal('rebuild') }),
  z.object({ type: z.literal('reload') }),
  z.object({ type: z.literal('request-projects') }),
  z.object({ type: z.literal('open-external'), url: z.string() }),
  z.object({ type: z.literal('open-settings') }),
  z.object({ type: z.literal('export-file'), defaultName: z.string(), data: z.string() }),
  z.object({
    type: z.literal('overview-mode-changed'),
    mode: z.enum(['full', 'overview']),
    enteredFocusFromOverview: z.boolean().optional(),
  }),
  z.object({ type: z.literal('log'), level: z.enum(['info', 'warn', 'error', 'debug']).optional(), text: z.string() }),
  z.object({
    type: z.literal('error'),
    error: z.string(),
    stack: z.string().optional(),
    componentStack: z.string().optional(),
    source: z.enum(['error-boundary', 'window-error', 'unhandled-rejection']).optional(),
    timestamp: z.number().optional(),
  }),
  z.object({ type: z.literal('show-warning'), text: z.string() }),
]);

/** Messages sent from the main lineage-graph webview to the extension host. */
export type MainPanelToExtensionMsg = z.infer<typeof MainPanelToExtensionMsgSchema>;

/**
 * Zod schema for messages sent from the detail-panel webview to the extension
 * host.
 */
export const DetailPanelToExtensionMsgSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('detail-ready'), findQuery: z.string().optional() }),
  z.object({ type: z.literal('table-stats-request'), schema: z.string(), objectName: z.string(), mode: z.any(), columns: z.array(z.any()) }),
  z.object({ type: z.literal('close-detail') }),
]);

/** Messages sent from the detail-panel webview to the extension host. */
export type DetailPanelToExtensionMsg = z.infer<typeof DetailPanelToExtensionMsgSchema>;

/**
 * Legacy full union of every webview→extension message type across both
 * webviews. Prefer {@link MainPanelToExtensionMsgSchema} or
 * {@link DetailPanelToExtensionMsgSchema} for boundary validation.
 */
export const WebviewToExtensionMsgSchema = z.discriminatedUnion('type', [
  ...MainPanelToExtensionMsgSchema.options,
  ...DetailPanelToExtensionMsgSchema.options,
]);

/** Inferred type of the legacy combined webview→extension union. */
export type WebviewToExtensionMsg = z.infer<typeof WebviewToExtensionMsgSchema>;
