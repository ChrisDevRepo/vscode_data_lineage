// ─── Core Types ──────────────────────────────────────────────────────────────

export type ObjectType = 'table' | 'view' | 'procedure' | 'function' | 'external';

export interface LineageNode {
  id: string;            // "[schema].[name]"
  schema: string;        // "dbo", "SalesLT", etc.
  name: string;          // object name without brackets/schema
  fullName: string;      // "[schema].[name]" as in dacpac
  type: ObjectType;
  bodyScript?: string;   // SQL body for SPs/Views/UDFs
  externalKind?: 'et' | 'openrowset' | 'cross_db'; // set for type === 'external'
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
export type CatalogEntry = { schema: string; name: string; type: ObjectType };

/**
 * O(1) neighbor lookup keyed by node ID.
 * Built once in buildModel() from model.edges.
 * Plain Record (not Map) so it survives JSON serialization across postMessage.
 * `in`  = upstream   nodes (data flows INTO this node)
 * `out` = downstream nodes (data flows OUT of this node)
 */
export type NeighborIndex = Record<string, { in: string[]; out: string[] }>;

export interface DacpacModel {
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
  // 'SqlExternalTable': 'external',  // dacpac v2 — element name TBC, needs test dacpac with ET
};

export const TRACKED_ELEMENT_TYPES = new Set(Object.keys(ELEMENT_TYPE_MAP));

// ─── Intermediate extraction format (shared by dacpac + DMV extractors) ──────

export interface ColumnDef {
  name: string;
  type: string;
  nullable: string;
  extra: string;
  unique?: string;  // UQ constraint name when column participates; display shows "UQ" flag
  check?: string;   // CK constraint name for column-level check; display shows "CK" flag
}

/** Foreign key constraint metadata — attached to table ExtractedObject (DMV path). */
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
    type: isComputed ? '(computed)' : formatColumnType(typeName, maxLength ?? '', precision ?? '', scale ?? ''),
    nullable: nullable ? 'NULL' : 'NOT NULL',
    extra: isIdentity ? 'IDENTITY' : isComputed ? 'COMPUTED' : '',
  };
}

export interface ExtractedObject {
  fullName: string;       // "[Schema].[Name]"
  type: ObjectType;
  bodyScript?: string;
  columns?: ColumnDef[];          // table column metadata (for table design view)
  fks?: ForeignKeyInfo[];         // FK constraints (DMV path only; undefined on dacpac path)
  externalKind?: 'et' | 'openrowset' | 'cross_db'; // set when type === 'external'
}

export interface ExtractedDependency {
  sourceName: string;     // "[Schema].[Name]" of referencing object
  targetName: string;     // "[Schema].[Name]" of referenced object
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
}

export type EdgeStyle = 'default' | 'smoothstep' | 'step' | 'straight';

export interface TraceConfig {
  defaultUpstreamLevels: number;
  defaultDownstreamLevels: number;
  hideCoWriters: boolean;
}

export interface AnalysisConfig {
  hubMinDegree: number;
  islandMaxSize: number;
  longestPathMinNodes: number;
}

export interface ExtensionConfig {
  parseRules?: import('./sqlBodyParser').ParseRulesConfig;
  excludePatterns: string[];
  maxNodes: number;
  layout: LayoutConfig;
  edgeStyle: EdgeStyle;
  trace: TraceConfig;
  analysis: AnalysisConfig;
}

export const DEFAULT_CONFIG = {
  excludePatterns: [],
  maxNodes: 500,
  layout: { direction: 'LR' as const, rankSeparation: 120, nodeSeparation: 30, edgeAnimation: true, highlightAnimation: false, minimapEnabled: true },
  edgeStyle: 'default' as const,
  trace: { defaultUpstreamLevels: 3, defaultDownstreamLevels: 3, hideCoWriters: true },
  analysis: { hubMinDegree: 8, islandMaxSize: 2, longestPathMinNodes: 5 },
} satisfies ExtensionConfig;

// ─── UI Types ───────────────────────────────────────────────────────────────

export interface FilterState {
  schemas: Set<string>;
  types: Set<ObjectType>;
  searchTerm: string;
  hideIsolated: boolean;
  focusSchemas: Set<string>;
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
}

// ─── Graph Analysis Types ────────────────────────────────────────────────────

export type AnalysisType = 'islands' | 'hubs' | 'orphans' | 'longest-path' | 'cycles';

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
  | { type: 'config-only'; config: ExtensionConfig; lastSource?: { type: 'dacpac' | 'database'; name: string } }
  | { type: 'dacpac-data'; data: number[]; fileName: string; config: ExtensionConfig; lastDeselectedSchemas?: string[]; autoVisualize?: boolean }
  | { type: 'last-dacpac-gone' }
  | { type: 'themeChanged'; kind: string }
  | { type: 'mssql-status'; available: boolean }
  | { type: 'db-progress'; step: number; total: number; label: string }
  | { type: 'db-schema-preview'; preview: SchemaPreview; config: ExtensionConfig; sourceName: string; lastDeselectedSchemas?: string[] }
  | { type: 'db-model'; model: DacpacModel; config: ExtensionConfig; sourceName: string; lastDeselectedSchemas?: string[] }
  | { type: 'db-error'; message: string; phase: string }
  | { type: 'db-cancelled' };
