import { z } from 'zod';

/**
 * ─── Bridge Contract ────────────────────────────────────────────────────────
 *
 * This module defines the strict type-safe contract for all IPC messages
 * between the Extension Host and the Webview.
 */

// ─── Shared Sub-Schemas ─────────────────────────────────────────────────────

export const ObjectTypeSchema = z.enum(['table', 'view', 'procedure', 'function', 'external']);

export const ColumnDefSchema = z.object({
  name: z.string(),
  type: z.string(),
  isPrimaryKey: z.boolean().optional(),
  isForeignKey: z.boolean().optional(),
  isNullable: z.boolean().optional(),
});

export const LineageNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  schema: z.string(),
  type: ObjectTypeSchema,
  isVirtual: z.boolean().optional(),
  isExternal: z.boolean().optional(),
  columns: z.array(ColumnDefSchema).optional(),
  bodyScript: z.string().optional(),
});

export const LineageEdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  type: z.enum(['body', 'dependency', 'exec']).optional(),
});

export const SchemaInfoSchema = z.object({
  name: z.string(),
  nodeCount: z.number(),
  types: z.record(ObjectTypeSchema, z.number()),
});

export const CatalogEntrySchema = z.object({
  schema: z.string(),
  name: z.string(),
  type: ObjectTypeSchema,
  externalType: z.enum(['et', 'file', 'db']).optional(),
});

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

export const ExtensionConfigSchema = z.record(z.string(), z.any());

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
});

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

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  updatedAt: z.string(),
  connection: z.any(), // Keeping connection generic for now to avoid deep MS-SQL types
  filterProfiles: z.array(FilterProfileSchema).optional(),
});

// ─── Incoming Messages (Extension -> Webview) ───────────────────────────────

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
  z.object({ type: z.literal('error'), error: z.string() }),
  z.object({ type: z.literal('toggle-overview') }),
  z.object({ type: z.literal('ai-view-activate'), profileId: z.string() }),
]);

export type ExtensionToWebviewMsg = z.infer<typeof ExtensionToWebviewMsgSchema>;

// ─── Outgoing Messages (Webview -> Extension) ───────────────────────────────

export const WebviewToExtensionMsgSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('detail-ready'), findQuery: z.string().optional() }),
  z.object({ type: z.literal('show-detail'), node: LineageNodeSchema.optional(), findQuery: z.string().optional() }),
  z.object({ type: z.literal('update-detail'), node: LineageNodeSchema.optional(), findQuery: z.string().optional() }),
  z.object({ type: z.literal('open-dacpac') }),
  z.object({ type: z.literal('load-project'), id: z.string() }),
  z.object({ type: z.literal('save-project'), project: z.any() }),
  z.object({ type: z.literal('delete-project'), id: z.string() }),
  z.object({ type: z.literal('load-demo') }),
  z.object({ type: z.literal('dacpac-visualize'), schemas: z.array(z.string()), projectName: z.string().optional() }),
  z.object({ type: z.literal('db-visualize'), schemas: z.array(z.string()), projectName: z.string().optional() }),
  z.object({ type: z.literal('filter-changed'), filter: z.any(), savedViews: z.any(), filteredCount: z.number().optional(), renderLimitHit: z.number().optional() }),
  z.object({ type: z.literal('db-connect') }),
  z.object({ type: z.literal('check-mssql') }),
  z.object({ type: z.literal('save-view'), projectId: z.string(), profile: z.any() }),
  z.object({ type: z.literal('save-wizard-view'), view: z.string() }),
  z.object({ type: z.literal('delete-view'), projectId: z.string(), profileId: z.string() }),
  z.object({ type: z.literal('rebuild') }),
  z.object({ type: z.literal('reload') }),
  z.object({ type: z.literal('request-projects') }),
  z.object({ type: z.literal('open-external'), url: z.string() }),
  z.object({ type: z.literal('open-settings') }),
  z.object({ type: z.literal('export-file'), defaultName: z.string(), data: z.string() }),
  z.object({ type: z.literal('overview-mode-changed'), mode: z.enum(['full', 'overview']) }),
  z.object({ type: z.literal('log'), level: z.enum(['info', 'warn', 'error', 'debug']).optional(), text: z.string() }),
  z.object({ type: z.literal('error'), error: z.string() }),
  z.object({ type: z.literal('table-stats-request'), schema: z.string(), objectName: z.string(), mode: z.any(), columns: z.array(z.any()) }),
  z.object({ type: z.literal('close-detail') }),
]);

export type WebviewToExtensionMsg = z.infer<typeof WebviewToExtensionMsgSchema>;
