// ─── Core Types ──────────────────────────────────────────────────────────────

export type ObjectType = 'table' | 'view' | 'procedure' | 'function' | 'external';

export interface LineageNode {
  id: string;            // "[schema].[name]" (2-part local), "[db].[schema].[name]" (3-part cross-DB), "[__ext__].[hash]" (file)
  schema: string;        // "dbo", "SalesLT", etc. — empty string for virtual nodes (file/db)
  name: string;          // object name without brackets/schema
  fullName: string;      // "[schema].[name]" as in dacpac
  type: ObjectType;
  hasDdl?: boolean;       // true when ColumnStore holds DDL for this node
  bodyScript?: string;   // SQL body for SPs/Views/UDFs — populated during extraction, moved to ColumnStore after model build
  hasColumns?: boolean;  // true when ColumnStore holds columns for this node
  columns?: ColumnDef[]; // column metadata — populated during extraction, moved to ColumnStore after model build
  fks?: ForeignKeyInfo[];// FK constraints (tables/externals only)
  externalType?: 'et' | 'file' | 'db'; // set for type === 'external'
  externalUrl?: string;       // full URL for file virtual nodes (tooltip)
  externalDatabase?: string;  // DB name for cross-DB virtual nodes (tooltip)
}

export interface LineageEdge {
  source: string;        // node id (the dependency)
  target: string;        // node id (the dependent object)
  type: 'body' | 'exec'; // body = FROM/JOIN ref, exec = EXEC call
}

export interface SchemaInfo {
  name: string;
  nodeCount: number;
  types: Record<ObjectType, number>;
}

export interface SpParseDetail {
  name: string;             // schema.object
  inCount: number;          // resolved source refs
  outCount: number;         // resolved target/exec refs
  inRefs?: string[];        // resolved source ref names (regex-matched)
  outRefs?: string[];       // resolved target/exec ref names (regex-matched)
  unrelated: string[];      // schema-qualified refs not in catalog
  skippedRefs?: string[];   // unqualified refs (no dot) skipped before catalog lookup
  excluded?: string[];      // refs removed by exclusion patterns
}

export interface ParseStats {
  parsedRefs: number;       // total refs found by regex
  resolvedEdges: number;    // matched dacpac catalog
  droppedRefs: string[];    // not in catalog, not external (CTEs, ghost refs)
  spDetails: SpParseDetail[];  // per-SP breakdown
}

/** Per-object display entry — covers ALL known objects including cross-schema ones. */
export type CatalogEntry = { schema: string; name: string; type: ObjectType; externalType?: 'et' | 'file' | 'db' };

/**
 * O(1) neighbor lookup keyed by node ID.
 * Built once in buildModel() from model.edges.
 * Plain Record (not Map) so it survives JSON serialization across postMessage.
 * `in`  = upstream   nodes (data flows INTO this node)
 * `out` = downstream nodes (data flows OUT of this node)
 */
export type NeighborIndex = Record<string, { in: string[]; out: string[] }>;

export interface DatabaseModel {
  nodes: LineageNode[];
  edges: LineageEdge[];
  schemas: SchemaInfo[];
  /**
   * Display catalog covering all known objects (including cross-schema ones not
   * visible in the current graph). Keyed by normalized node ID "[schema].[name]".
   */
  catalog: Record<string, CatalogEntry>;
  /** O(1) in/out neighbor lookup derived from model.edges. */
  neighborIndex: NeighborIndex;
  parseStats?: ParseStats;
  warnings?: string[];
  /** Human-readable database platform string, e.g. "Azure SQL Database" or "SQL Server 2022". */
  dbPlatform?: string;
}

export interface SchemaPreview {
  schemas: SchemaInfo[];
  totalObjects: number;
  warnings?: string[];
}

// ─── XML Parsing Types (fast-xml-parser output) ─────────────────────────────

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

// ─── Element type mapping ───────────────────────────────────────────────────

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

// ─── Intermediate extraction format (shared by dacpac + DMV extractors) ──────

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

// ─── Shared Column Helpers (used by both dacpac + DMV extractors) ────────────

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

// ─── Constraint Maps (shared by dacpac + DMV extractors) ─────────────────────

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

/** Factory for empty SchemaInfo — single source of truth for the zero-count init. */
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

// ─── DMV type mapping (sys.objects.type codes → ObjectType) ─────────────────

export const DMV_TYPE_MAP: Record<string, ObjectType> = {
  'U':  'table',
  'V':  'view',
  'P':  'procedure',
  'FN': 'function',
  'IF': 'function',
  'TF': 'function',
  'ET': 'external',  // External Table (PolyBase / data virtualization)
};

// ─── Extension Config (from VS Code settings) ──────────────────────────────

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
  /** Node count above which overview auto-activates on initial load (post-filter). */
  threshold: number;
  /** Node count above which overview is forced even after manual toggle (soft guard). */
  forceOverviewThreshold: number;
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
  overview: { enabled: true, threshold: 150, forceOverviewThreshold: 300 },
  renderLimit: 750,
} satisfies ExtensionConfig;

// ─── UI Types ───────────────────────────────────────────────────────────────

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
  /** Node count from BFS on unfiltered model (undefined = not computed). */
  fullTraceNodeCount?: number;
  /** Per-node count of trace neighbors hidden by filters. Only set when gaps exist. */
  filteredNeighborGaps?: Map<string, { hidden: number; total: number }>;
  /** When true, trace BFS used the unfiltered model graph. */
  useFullGraph?: boolean;
}

// ─── Graph Analysis Types ────────────────────────────────────────────────────

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

// ─── Extension → Webview Messages ───────────────────────────────────────────

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
