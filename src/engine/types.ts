
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


export interface XmlElement {
  '@_Type': string;
  '@_Name'?: string;
  '@_ExternalSource'?: string;
  Property?: XmlProperty | XmlProperty[];
  Relationship?: XmlRelationship | XmlRelationship[];
  Element?: XmlElement | XmlElement[];
  Annotation?: XmlAnnotation | XmlAnnotation[];
}

export interface XmlAnnotation {
  '@_Type': string;
  '@_Name'?: string;
  Property?: XmlProperty | XmlProperty[];
}

export interface XmlProperty {
  '@_Name': string;
  '@_Value'?: string;
  Value?: string | { '#text': string };
}

export interface XmlRelationship {
  '@_Name': string;
  Entry?: XmlEntry | XmlEntry[];
}

export interface XmlEntry {
  References?: XmlReference | XmlReference[];
  Element?: XmlElement | XmlElement[];
}

export interface XmlReference {
  '@_Name': string;
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


export interface ColumnDef {
  name: string;
  type: string;
  nullable: string;
  extra: string;
  unique?: string;     // UQ constraint name when column participates; display shows "UQ" flag
  check?: string;      // CK constraint name for column-level check; display shows "CK" flag
  pkOrdinal?: number;  // PK ordinal (1-based); set for every column in the primary key
}

/** Foreign key constraint metadata — attached to table ExtractedObject (dacpac + DMV paths). */
export interface ForeignKeyInfo {
  name: string;          // constraint name (display casing)
  columns: string[];     // parent column names (multi-col FK in column_ordinal order)
  refSchema: string;     // referenced schema
  refTable: string;      // referenced table
  refColumns: string[];  // referenced column names (same order as columns[])
  onDelete: string;      // referential action: NO ACTION | CASCADE | SET NULL | SET DEFAULT
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

export interface ExtractedObject {
  fullName: string;       // "[Schema].[Name]"
  type: ObjectType;
  bodyScript?: string;
  columns?: ColumnDef[];          // table column metadata (for table design view)
  fks?: ForeignKeyInfo[];         // FK constraints (dacpac + DMV paths; undefined only when not extracted)
  externalType?: 'et' | 'file' | 'db'; // set when type === 'external'
}

export interface ExtractedDependency {
  sourceName: string;     // "[Schema].[Name]" of referencing object
  targetName: string;     // "[Schema].[Name]" of referenced object — 3-part "[DB].[Schema].[Name]" for cross-DB
}

/** External file/URL reference detected by pre-cleansing regex pass. */
export interface ExternalRef {
  url: string;
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


export interface LayoutConfig {
  direction: 'TB' | 'LR';
  rankSeparation: number;
  nodeSeparation: number;
  edgeAnimation: boolean;
  highlightAnimation: boolean;
  minimapEnabled: boolean;
  edgeStyle: EdgeStyle;
}

export type EdgeStyle = 'default' | 'smoothstep' | 'step' | 'straight';

export interface TraceConfig {
  defaultUpstreamLevels: number;
  defaultDownstreamLevels: number;
}

export interface AnalysisConfig {
  hubMinDegree: number;
  islandMaxSize: number;
  longestPathMinNodes: number;
}

export interface TableStatsConfig {
  enabled: boolean;
  standardModeEnabled: boolean;
  excludeExternalTables: boolean;
  maxColumns: number;
  sampleThreshold: number;
  sampleSize: number;
  useApproxDistinct: boolean;
  queryTimeout: number;
}

export interface ExternalRefsConfig {
  enabled: boolean;
}

export interface OverviewConfig {
  /** When false, schema overview mode is completely disabled — graph always shows full object view. */
  enabled: boolean;
  /** Node count above which overview auto-activates on initial load (post-filter).
   *  Also used as the dagre-skip threshold — no point computing layout for nodes shown as schema bubbles. */
  threshold: number;
}

export interface ExtensionConfig {
  parseRules?: import('./sqlBodyParser').ParseRulesConfig;
  excludePatterns: string[];
  maxNodes: number;
  dmvQueryTimeout: number;
  layout: LayoutConfig;
  trace: TraceConfig;
  analysis: AnalysisConfig;
  tableStatistics: TableStatsConfig;
  externalRefs: ExternalRefsConfig;
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
