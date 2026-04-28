
export type ObjectType = 'table' | 'view' | 'procedure' | 'function' | 'external';

/**
 * Represents a single node in the lineage graph.
 * 
 * @remarks
 * A node can represent a physical table, a view, a procedure, or a virtual object 
 * like a cross-database reference or an external file.
 */
export interface LineageNode {
  /** 
   * Unique identifier for the node. 
   * Format: `[schema].[name]` (local), `[db].[schema].[name]` (cross-DB), or `[__ext__].[hash]` (file).
   */
  id: string;
  /** SQL schema name (e.g., "dbo", "SalesLT"). Empty for virtual nodes. */
  schema: string;
  /** Short object name without delimiters or schema. */
  name: string;
  /** Full schema-qualified name as found in the source (e.g., `[dbo].[Table]`). */
  fullName: string;
  /** The specific type of the database object. */
  type: ObjectType;
  /** True if the ColumnStore contains DDL source for this node. */
  hasDdl?: boolean;
  /** 
   * Raw SQL body script. 
   * Temporarily held during extraction before being moved to persistent storage.
   */
  bodyScript?: string;
  /** True if the ColumnStore contains column metadata for this node. */
  hasColumns?: boolean;
  /** 
   * List of column definitions. 
   * Temporarily held during extraction before being moved to persistent storage.
   */
  columns?: ColumnDef[];
  /** Foreign key constraints (applicable to tables and external tables). */
  fks?: ForeignKeyInfo[];
  /** Sub-classification for external objects. */
  externalType?: 'et' | 'file' | 'db';
  /** Full URL for file-based virtual nodes, shown in UI tooltips. */
  externalUrl?: string;
  /** Database name for cross-database virtual nodes, shown in UI tooltips. */
  externalDatabase?: string;
}

/**
 * Represents a directed dependency between two nodes in the graph.
 */
export interface LineageEdge {
  /** The identifier of the source node (the object being depended upon). */
  source: string;
  /** The identifier of the target node (the dependent object). */
  target: string;
  /** 
   * The type of dependency:
   * - `body`: Referenced in a FROM, JOIN, or DML statement.
   * - `exec`: Referenced in an EXEC/EXECUTE call.
   */
  type: 'body' | 'exec';
}

/**
 * Summary information for a single SQL schema.
 */
export interface SchemaInfo {
  /** The schema name. */
  name: string;
  /** Total number of nodes belonging to this schema in the current model. */
  nodeCount: number;
  /** Breakdown of object counts grouped by their type. */
  types: Record<ObjectType, number>;
}

/**
 * Detailed parsing metrics for a single scripted object (procedure, view, function).
 */
export interface SpParseDetail {
  /** Full schema-qualified name of the object. */
  name: string;
  /** Count of successfully resolved source (read) references. */
  inCount: number;
  /** Count of successfully resolved target (write/exec) references. */
  outCount: number;
  /** List of resolved source reference names. */
  inRefs?: string[];
  /** List of resolved target/exec reference names. */
  outRefs?: string[];
  /** References that were schema-qualified but not found in the active catalog. */
  unrelated: string[];
  /** Unqualified references that were skipped before catalog resolution. */
  skippedRefs?: string[];
  /** References that were explicitly removed by user-defined exclusion patterns. */
  excluded?: string[];
}

/**
 * Aggregated statistics for the model construction and parsing phase.
 */
export interface ParseStats {
  /** Total number of potential object references discovered by regex. */
  parsedRefs: number;
  /** Number of references successfully matched against the source catalog. */
  resolvedEdges: number;
  /** References discovered but dropped (e.g., CTEs, internal aliases). */
  droppedRefs: string[];
  /** Detailed breakdown for each analyzed script. */
  spDetails: SpParseDetail[];
}

/** 
 * Lightweight entry for the global object catalog. 
 */
export type CatalogEntry = { 
  /** SQL schema name. */
  schema: string; 
  /** Short object name. */
  name: string; 
  /** Object classification. */
  type: ObjectType; 
  /** External classification if applicable. */
  externalType?: 'et' | 'file' | 'db' 
};

/**
 * O(1) adjacency list for graph navigation.
 * 
 * @remarks
 * Keyed by node ID. Maps to upstream (`in`) and downstream (`out`) neighbors.
 * Used for high-performance interactive tracing and pathfinding.
 */
export type NeighborIndex = Record<string, { in: string[]; out: string[] }>;

/**
 * The unified database model representing all nodes, edges, and metadata.
 */
export interface DatabaseModel {
  /** All objects (nodes) included in the model. */
  nodes: LineageNode[];
  /** All discovered dependencies (edges). */
  edges: LineageEdge[];
  /** Summary of schemas found in the model. */
  schemas: SchemaInfo[];
  /** 
   * Global catalog of all known objects, including those not in the current graph. 
   * Keyed by normalized node ID.
   */
  catalog: Record<string, CatalogEntry>;
  /** High-performance neighbor lookup index. */
  neighborIndex: NeighborIndex;
  /** Metrics and details from the parsing phase. */
  parseStats?: ParseStats;
  /** Non-critical messages or issues encountered during model build. */
  warnings?: string[];
  /** 
   * Description of the source database platform. 
   * (e.g., "Azure SQL Database", "SQL Server 2022").
   */
  dbPlatform?: string;
}

/**
 * Metadata for a schema-level preview used in the project wizard.
 */
export interface SchemaPreview {
  /** Summary of all schemas available in the source. */
  schemas: SchemaInfo[];
  /** Total count of objects found across all schemas. */
  totalObjects: number;
  /** Warnings generated during the preview extraction. */
  warnings?: string[];
}


/**
 * Represents a generic XML element in a DACPAC model file.
 * Used during Phase 1 (preview) and Phase 2 (full extraction) to traverse the SQL model hierarchy.
 */
export interface XmlElement {
  /** The internal SQL object type (e.g., 'SqlTable'). */
  '@_Type': string;
  /** The name of the object. */
  '@_Name'?: string;
  /** Reference to an external source for cross-database or external table objects. */
  '@_ExternalSource'?: string;
  /** Optional metadata properties associated with the element. */
  Property?: XmlProperty | XmlProperty[];
  /** Structural relationships (e.g., 'Columns', 'PrimaryKeys') to other elements. */
  Relationship?: XmlRelationship | XmlRelationship[];
  /** Nested child elements for composite objects. */
  Element?: XmlElement | XmlElement[];
  /** Metadata annotations (e.g., 'SqlColumn.Type') providing additional type or constraint info. */
  Annotation?: XmlAnnotation | XmlAnnotation[];
}

/**
 * Metadata annotation attached to an XML element.
 * Often contains property values that define technical specifics like data types.
 */
export interface XmlAnnotation {
  /** The type of annotation (e.g., 'SqlColumn.Type'). */
  '@_Type': string;
  /** Optional name for identifying specific annotations. */
  '@_Name'?: string;
  /** Properties contained within the annotation. */
  Property?: XmlProperty | XmlProperty[];
}

/**
 * A key-value pair representing a property on an XML element or annotation.
 */
export interface XmlProperty {
  /** The unique name of the property. */
  '@_Name': string;
  /** The value of the property, if provided as an attribute. */
  '@_Value'?: string;
  /** The value of the property, if provided as an element text node. */
  Value?: string | { '#text': string };
}

/**
 * Defines a structural relationship between elements in the DACPAC XML.
 */
export interface XmlRelationship {
  /** The name of the relationship (e.g., 'Columns', 'QueryDependencies'). */
  '@_Name': string;
  /** The target entries participating in this relationship. */
  Entry?: XmlEntry | XmlEntry[];
}

/**
 * A single entry within a {@link XmlRelationship}.
 */
export interface XmlEntry {
  /** References to other top-level elements. */
  References?: XmlReference | XmlReference[];
  /** Inline child elements defined specifically for this entry. */
  Element?: XmlElement | XmlElement[];
}

/**
 * A reference pointer to another element in the SQL model.
 */
export interface XmlReference {
  /** The name of the referenced object. */
  '@_Name': string;
  /** The external source of the reference, if applicable. */
  '@_ExternalSource'?: string;
}


export const ELEMENT_TYPE_MAP: Record<string, ObjectType> = {
  SqlTable: 'table',
  SqlView: 'view',
  SqlProcedure: 'procedure',
  SqlScalarFunction: 'function',
  SqlInlineTableValuedFunction: 'function',
  SqlMultiStatementTableValuedFunction: 'function',
  SqlTableValuedFunction: 'function',
  SqlExternalTable: 'external',  // PolyBase / data virtualization ET in dacpac XML
};

export const TRACKED_ELEMENT_TYPES = new Set(Object.keys(ELEMENT_TYPE_MAP));


/**
 * Technical definition of a database column.
 * Used for rendering the "Column Mode" detail view and schema exploration.
 */
export interface ColumnDef {
  /** The display name of the column. */
  name: string;
  /** The formatted SQL data type (e.g., 'nvarchar(50)'). */
  type: string;
  /** Whether the column allows nulls ('NULL' or 'NOT NULL'). */
  nullable: string;
  /** Additional flags like 'IDENTITY' or 'COMPUTED'. */
  extra: string;
  /** Name of the unique constraint if the column participates in one. */
  unique?: string;
  /** Name of the check constraint if the column has one. */
  check?: string;
  /** Primary key ordinal (1-based) if the column is part of the PK. */
  pkOrdinal?: number;
}

/** Foreign key constraint metadata — attached to table ExtractedObject (dacpac + DMV paths). */
export interface ForeignKeyInfo {
  /** The name of the foreign key constraint. */
  name: string;
  /** The list of column names in the child table. */
  columns: string[];
  /** The schema of the referenced (parent) table. */
  refSchema: string;
  /** The name of the referenced (parent) table. */
  refTable: string;
  /** The list of column names in the parent table. */
  refColumns: string[];
  /** The referential action (e.g., 'CASCADE', 'SET NULL') on deletion. */
  onDelete: string;
}


/**
 * Format a SQL type name with length/precision/scale modifiers.
 * Handles nvarchar/nchar byte→char conversion and fixed-type detection.
 */
export function formatColumnType(
  typeName: string, maxLength: string, precision: string, scale: string
): string {
  const t = typeName.toLowerCase();

  // Types that never need length/precision
  if (['int', 'bigint', 'smallint', 'tinyint', 'bit', 'float', 'real',
    'money', 'smallmoney', 'date', 'datetime', 'datetime2', 'smalldatetime',
    'datetimeoffset', 'time', 'timestamp', 'uniqueidentifier', 'xml',
    'text', 'ntext', 'image', 'sql_variant', 'geography', 'geometry',
    'hierarchyid', 'sysname'].includes(t)) {
    return typeName;
  }

  // String/binary types: use max_length (-1 = max)
  if (['varchar', 'nvarchar', 'char', 'nchar', 'varbinary', 'binary'].includes(t)) {
    if (maxLength === '-1') return `${typeName}(max)`;
    // nvarchar/nchar store 2 bytes per char — display char count
    const len = (t.startsWith('n') && maxLength) ? String(Math.floor(parseInt(maxLength, 10) / 2)) : maxLength;
    return len ? `${typeName}(${len})` : typeName;
  }

  // Decimal/numeric: precision,scale
  if (['decimal', 'numeric'].includes(t)) {
    if (precision && scale) return `${typeName}(${precision},${scale})`;
    if (precision) return `${typeName}(${precision})`;
    return typeName;
  }

  return typeName;
}

/** Build a ColumnDef from raw metadata — single code path for both dacpac and DMV. */
export function buildColumnDef(
  name: string,
  typeName: string,
  nullable: boolean,
  isIdentity: boolean,
  isComputed: boolean,
  maxLength?: string,
  precision?: string,
  scale?: string,
): ColumnDef {
  return {
    name,
    type: isComputed
      ? (typeName !== '?' ? formatColumnType(typeName, maxLength ?? '', precision ?? '', scale ?? '') : '—')
      : formatColumnType(typeName, maxLength ?? '', precision ?? '', scale ?? ''),
    nullable: nullable ? 'NULL' : 'NOT NULL',
    extra: isIdentity ? 'IDENTITY' : isComputed ? 'COMPUTED' : '',
  };
}


export interface ConstraintMaps {
  /** Key: "schema.table.column" (lowercase) → UQ constraint name */
  uqColMap: Map<string, string>;
  /** Key: "schema.table.column" (lowercase) → CK constraint name */
  ckColMap: Map<string, string>;
  /** Key: "schema.table" (lowercase) → FK list */
  fkMap: Map<string, ForeignKeyInfo[]>;
  /** Key: "schema.table.column" (lowercase) → PK ordinal (1-based) */
  pkOrdinalMap: Map<string, number>;
}

/** Enrich columns with UQ/CK/PK flags and return FK list for a table. */
export function enrichColumnsWithConstraints(
  columns: ColumnDef[], tableKey: string, maps: ConstraintMaps
): ForeignKeyInfo[] {
  for (const col of columns) {
    const colKey = `${tableKey}.${col.name}`.toLowerCase();
    col.unique    = maps.uqColMap.get(colKey) ?? '';
    col.check     = maps.ckColMap.get(colKey) ?? '';
    const pk      = maps.pkOrdinalMap.get(colKey);
    if (pk !== undefined) col.pkOrdinal = pk;
  }
  return maps.fkMap.get(tableKey) ?? [];
}

/**
 * Factory for empty SchemaInfo — single source of truth for the zero-count init.
 *
 * @param name - The schema name.
 * @returns A pristine SchemaInfo object initialized to zero.
 */
export function createEmptySchemaInfo(name: string): SchemaInfo {
  return { name, nodeCount: 0, types: { table: 0, view: 0, procedure: 0, function: 0, external: 0 } };
}

/**
 * Represents a database object extracted during Phase 2.
 * Includes structural metadata like columns and foreign keys.
 */
export interface ExtractedObject {
  /** Full schema-qualified name (e.g., "[dbo].[Table]"). */
  fullName: string;
  /** The specific type of the database object. */
  type: ObjectType;
  /** The raw SQL DDL or body script of the object. */
  bodyScript?: string;
  /** List of column definitions belonging to the object. */
  columns?: ColumnDef[];
  /** Foreign key constraints for tables and external tables. */
  fks?: ForeignKeyInfo[];
  /** Sub-classification for external references. */
  externalType?: 'et' | 'file' | 'db';
}

/**
 * Represents a raw dependency discovered during parsing.
 */
export interface ExtractedDependency {
  /** Normalized name of the referencing object. */
  sourceName: string;
  /** Normalized name of the referenced object. */
  targetName: string;
}

/** External file/URL reference detected by pre-cleansing regex pass. */
export interface ExternalRef {
  /** The full URL or file path. */
  url: string;
  /** The classification of the reference (e.g., 'datalake', 'blob'). */
  kind: string;
}


export const DMV_TYPE_MAP: Record<string, ObjectType> = {
  'U':  'table',
  'V':  'view',
  'P':  'procedure',
  'FN': 'function',
  'IF': 'function',
  'TF': 'function',
  'ET': 'external',  // External Table (PolyBase / data virtualization)
};

/**
 * Configuration for graph layout algorithms (dagre).
 */
export interface LayoutConfig {
  /** The flow direction of the graph: Top-to-Bottom (TB) or Left-to-Right (LR). */
  direction: 'TB' | 'LR';
  /** Spacing between hierarchical ranks. */
  rankSeparation: number;
  /** Spacing between nodes within the same rank. */
  nodeSeparation: number;
  /** Whether to animate edge transitions. */
  edgeAnimation: boolean;
  /** Whether to animate node highlights. */
  highlightAnimation: boolean;
  /** Whether the minimap is enabled in the UI. */
  minimapEnabled: boolean;
  /** The visual style of edges (e.g., smooth curves or orthogonal steps). */
  edgeStyle: EdgeStyle;
}

export type EdgeStyle = 'default' | 'smoothstep' | 'step' | 'straight';

/**
 * Configuration for interactive lineage tracing.
 */
export interface TraceConfig {
  /** Default number of upstream levels to explore. */
  defaultUpstreamLevels: number;
  /** Default number of downstream levels to explore. */
  defaultDownstreamLevels: number;
}

/**
 * Configuration for graph analysis tools (hubs, islands, cycles).
 */
export interface AnalysisConfig {
  /** Minimum degree (in+out) for a node to be classified as a hub. */
  hubMinDegree: number;
  /** Maximum node count for a connected component to be classified as an island. */
  islandMaxSize: number;
  /** Minimum node count for a path to be classified as a "long path". */
  longestPathMinNodes: number;
}

/**
 * Configuration for the table profiling/statistics engine.
 */
export interface TableStatsConfig {
  /** Whether profiling is enabled. */
  enabled: boolean;
  /** Whether standard profiling (row counts, nullability) is active. */
  standardModeEnabled: boolean;
  /** Whether to skip profiling for external tables. */
  excludeExternalTables: boolean;
  /** Maximum number of columns to profile per table. */
  maxColumns: number;
  /** Threshold above which sampling is used instead of a full scan. */
  sampleThreshold: number;
  /** The number of rows to sample if the threshold is exceeded. */
  sampleSize: number;
  /** Whether to use APPROX_COUNT_DISTINCT for performance on compatible platforms. */
  useApproxDistinct: boolean;
  /** Maximum duration (in seconds) allowed for a single profiling query. */
  queryTimeout: number;
}

/**
 * Configuration for external reference detection and display.
 */
export interface ExternalRefsConfig {
  /** Whether to detect and display cross-database and file-based references. */
  enabled: boolean;
}

/**
 * Configuration for the schema-level overview mode.
 */
export interface OverviewConfig {
  /** When false, schema overview mode is completely disabled — graph always shows full object view. */
  enabled: boolean;
  /** Node count above which overview auto-activates on initial load (post-filter).
   *  Also used as the dagre-skip threshold — no point computing layout for nodes shown as schema bubbles. */
  threshold: number;
}

/**
 * The unified extension configuration object.
 * Maps directly to the `dataLineageViz.*` settings in package.json.
 */
export interface ExtensionConfig {
  /** Optional custom regex rules for SQL parsing. */
  parseRules?: import('./sqlBodyParser').ParseRulesConfig;
  /** Glob patterns for objects or schemas to exclude from the model. */
  excludePatterns: string[];
  /** Maximum number of objects allowed in a single model extraction. */
  maxNodes: number;
  /** Maximum duration (in seconds) for DMV metadata queries. */
  dmvQueryTimeout: number;
  /** Visual layout settings. */
  layout: LayoutConfig;
  /** Lineage tracing settings. */
  trace: TraceConfig;
  /** Graph analysis settings. */
  analysis: AnalysisConfig;
  /** Profiling and statistics settings. */
  tableStatistics: TableStatsConfig;
  /** External reference settings. */
  externalRefs: ExternalRefsConfig;
  /** Overview mode settings. */
  overview: OverviewConfig;
  /** Max rendered nodes before showing a limit-reached warning instead of the graph. */
  renderLimit: number;
}

/** Fabric Data Warehouse engineEditionId — used for platform-specific query branching. */
export const ENGINE_EDITION_FABRIC = 11;

export const DEFAULT_CONFIG = {
  excludePatterns: [],
  maxNodes: 750,
  layout: { direction: 'LR' as const, rankSeparation: 120, nodeSeparation: 30, edgeAnimation: true, highlightAnimation: false, minimapEnabled: true, edgeStyle: 'default' as const },
  trace: { defaultUpstreamLevels: 3, defaultDownstreamLevels: 3 },
  analysis: { hubMinDegree: 8, islandMaxSize: 500, longestPathMinNodes: 5 },
  tableStatistics: { enabled: true, standardModeEnabled: true, excludeExternalTables: true, maxColumns: 50, sampleThreshold: 100000, sampleSize: 10000, useApproxDistinct: true, queryTimeout: 60 },
  dmvQueryTimeout: 120,
  externalRefs: { enabled: true },
  overview: { enabled: true, threshold: 150 },
  renderLimit: 750,
} satisfies ExtensionConfig;


export type GraphMode = 'full' | 'overview';

/** Data for a schema-level super-node rendered in overview mode. */
export interface SchemaNodeData extends Record<string, unknown> {
  schemaName: string;
  objectCount: number;
  typeBreakdown: Partial<Record<ObjectType, number>>;
  color: string;
}

export interface FilterState {
  schemas: Set<string>;
  types: Set<ObjectType>;
  searchTerm: string;
  hideIsolated: boolean;
  focusSchemas: Set<string>;
  showExternalRefs: boolean;
  externalRefTypes: Set<'file' | 'db'>;
  exclusionPatterns: string[];
  /**
   * Allowlist: when non-empty, only these node IDs are shown (applied after all other filters).
   * Empty/absent = no restriction. Set by advanced bookmarks (trace-save, analysis-save, AI view).
   */
  allowlistNodeIds?: Set<string>;
}

export interface TraceState {
  mode: 'none' | 'configuring' | 'applied' | 'filtered' | 'pathfinding' | 'path-applied' | 'analysis';
  analysisType?: AnalysisType;
  selectedNodeId: string | null;
  targetNodeId: string | null;
  upstreamLevels: number;
  downstreamLevels: number;
  tracedNodeIds: Set<string>;
  tracedEdgeIds: Set<string>;
  /** BFS auto-promoted to fullGraph because the target node was filtered out. */
  autoPromoted?: boolean;
}


export type AnalysisType = 'islands' | 'hubs' | 'orphans' | 'longest-path' | 'cycles' | 'external-refs';

export interface AnalysisGroup {
  id: string;
  label: string;
  nodeIds: string[];
  meta?: Record<string, string | number>;
}

export interface AnalysisResult {
  type: AnalysisType;
  groups: AnalysisGroup[];
  summary: string;
}

export interface AnalysisMode {
  type: AnalysisType;
  result: AnalysisResult;
  activeGroupId: string | null;
}


export type ExtensionMessage =
  | { type: 'config-only'; config: ExtensionConfig }
  | { type: 'projects-list'; projects: import('./projectStore').Project[]; lastOpenedId: string | null }
  | { type: 'dacpac-schema-preview'; preview: SchemaPreview; config: ExtensionConfig; sourceName: string; filePath?: string }
  | { type: 'dacpac-model'; model: DatabaseModel; config: ExtensionConfig; sourceName: string; autoVisualize?: boolean }
  | { type: 'last-dacpac-gone' }
  | { type: 'themeChanged'; kind: string }
  | { type: 'mssql-status'; available: boolean }
  | { type: 'db-progress'; step: number; total: number; label: string }
  | { type: 'db-schema-preview'; preview: SchemaPreview; config: ExtensionConfig; sourceName: string }
  | { type: 'db-model'; model: DatabaseModel; config: ExtensionConfig; sourceName: string }
  | { type: 'db-error'; message: string; phase: string }
  | { type: 'db-cancelled' }
  | { type: 'table-stats-result'; stats: import('../engine/profilingEngine').TableStats; mode: import('../engine/profilingEngine').StatsMode }
  | { type: 'table-stats-error'; message: string }
  | { type: 'toggle-overview' }
  /** Sent by extension after AI creates and persists an advanced bookmark. Webview applies it. */
  | { type: 'ai-view-activate'; profileId: string };
