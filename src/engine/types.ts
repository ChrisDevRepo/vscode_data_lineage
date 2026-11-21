
import type { ColumnLineState, ColumnTraceViewNode } from './columnTraceView';
import { schemaKey } from '../utils/sql';

/**
 * Canonical list of supported lineage object kinds. Single source of truth: {@link ObjectType} is
 * derived from it and the bridge contract's `ObjectTypeSchema` reuses it, so the runtime schema
 * cannot drift from the type.
 */
export const OBJECT_TYPES = ['table', 'view', 'procedure', 'function', 'external'] as const;

export type ObjectType = typeof OBJECT_TYPES[number];

/**
 * A single node in the lineage graph: a physical table, view, procedure, or a virtual object such
 * as a cross-database reference or an external file.
 */
export interface LineageNode {
  /**
   * Unique identifier: `[schema].[name]` (local), `[db].[schema].[name]` (cross-DB), or
   * `[__ext__].[hash]` (file; the hash is the SHA-256 hex of the URL).
   */
  id: string;
  /** SQL schema name (e.g., "dbo", "SalesLT"). Empty for virtual nodes. */
  schema: string;
  /** Short object name without delimiters or schema. */
  name: string;
  /** Full schema-qualified name as found in the source (e.g., `[dbo].[Table]`). */
  fullName: string;
  type: ObjectType;
  /** True if the ColumnStore contains DDL source for this node. */
  hasDdl?: boolean;
  /** Raw SQL body script; held during extraction before moving to persistent storage. */
  bodyScript?: string;
  /** True if the ColumnStore contains column metadata for this node. */
  hasColumns?: boolean;
  /** Column definitions; held during extraction before moving to persistent storage. */
  columns?: ColumnDef[];
  /** Foreign key constraints (applicable to tables and external tables). */
  fks?: ForeignKeyInfo[];
  /** Sub-classification for external objects. */
  externalType?: 'et' | 'file' | 'db';
  /** Full URL for file-based virtual nodes, shown in UI tooltips. */
  externalUrl?: string;
  /** Database name for cross-database virtual nodes, shown in UI tooltips. */
  externalDatabase?: string;
  /**
   * True for a stored procedure whose definition is not readable (encrypted or no permission). The
   * node loads without edges, since the catalog cannot give their direction; a view or function
   * keeps its catalog edges, whose direction needs no body.
   */
  definitionUnreadable?: boolean;
}

/** Represents a directed dependency between two nodes in the graph. */
export interface LineageEdge {
  /** The identifier of the source node (the object being depended upon). */
  source: string;
  /** The identifier of the target node (the dependent object). */
  target: string;
  /**
   * `body`: referenced in a FROM, JOIN or DML statement; `exec`: referenced in an EXEC/EXECUTE
   * call.
   */
  type: 'body' | 'exec';
  /**
   * Set only on a procedure's write edge whose every mutation of the target is a `DELETE` or
   * `TRUNCATE`: rows are removed and no column data supplied. Additive metadata; the edge, its
   * direction and the graph shape are unchanged.
   */
  deleteOnly?: true;
}

/** Summary information for a single SQL schema. */
export interface SchemaInfo {
  name: string;
  /** Total number of nodes belonging to this schema in the current model. */
  nodeCount: number;
  /** Breakdown of object counts grouped by their type. */
  types: Record<ObjectType, number>;
}

/** Detailed parsing metrics for a single scripted object (procedure, view, function). */
interface SpParseDetail {
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
  /** References that were explicitly removed by user-defined exclusion patterns. */
  excluded?: string[];
}

/** Aggregated statistics for the model construction and parsing phase. */
export interface ParseStats {
  /** Total number of potential object references discovered by regex. */
  parsedRefs: number;
  /** Number of references successfully matched against the source catalog. */
  resolvedEdges: number;
  /** References discovered but dropped (e.g., CTEs, internal aliases). */
  droppedRefs: string[];
  /** Detailed breakdown for each analyzed script. */
  spDetails: SpParseDetail[];
  /** Full names of modules loaded without edges because their definition is not readable. */
  unreadableDefinitions?: string[];
  /** Full names of modules per construct that is not fully supported, such as a cursor. */
  unsupported?: Record<string, string[]>;
}

/** Lightweight entry for the global object catalog. */
export type CatalogEntry = {
  schema: string;
  name: string;
  type: ObjectType;
  externalType?: 'et' | 'file' | 'db'
};

/** O(1) adjacency by node ID: upstream (`in`) and downstream (`out`) neighbors, for tracing. */
export type NeighborIndex = Record<string, { in: string[]; out: string[] }>;

/** The unified database model representing all nodes, edges, and metadata. */
export interface DatabaseModel {
  /** Checked source catalog metadata enables exact identifier comparison; else legacy CI. */
  identifierCaseSensitive?: boolean;
  /** All objects (nodes) included in the model. */
  nodes: LineageNode[];
  /** All discovered dependencies (edges). */
  edges: LineageEdge[];
  /** Summary of schemas found in the model. */
  schemas: SchemaInfo[];
  /** Catalog of all known objects, also those outside the graph, keyed by normalized node ID. */
  catalog: Record<string, CatalogEntry>;
  /** High-performance neighbor lookup index. */
  neighborIndex: NeighborIndex;
  /** Metrics and details from the parsing phase. */
  parseStats?: ParseStats;
  /** Non-critical messages or issues encountered during model build. */
  warnings?: string[];
  /** Source database platform, e.g. "Azure SQL Database", "SQL Server 2022". */
  dbPlatform?: string;
  /**
   * Which ingestion lane produced this model. Stamped by each extractor, not derived: platform
   * presence cannot stand in for provenance, since a DACPAC also carries a platform label from its
   * DSP. Optional so `buildModel` stays lane-agnostic; both production extractors always set it.
   */
  source?: ModelSource;
}

/** Ingestion lane that produced a {@link DatabaseModel}. */
type ModelSource = 'dacpac' | 'database';

/**
 * Label recorded when no source can identify the database platform. Single-sourced because it is
 * user-visible (status bar, project card) and model-visible (the `db_platform` tool field);
 * explicit rather than a `SQL Server` default, since the model must not reason from an invented
 * platform.
 */
export const UNKNOWN_DB_PLATFORM = 'Unknown database platform';

/** Metadata for a schema-level preview used in the project wizard. */
export interface SchemaPreview {
  /** Checked source catalog policy; absent preserves legacy case-insensitive identity. */
  identifierCaseSensitive?: boolean;
  /** Summary of all schemas available in the source. */
  schemas: SchemaInfo[];
  /** Total count of objects found across all schemas. */
  totalObjects: number;
  /** Warnings generated during the preview extraction. */
  warnings?: string[];
}


/** A generic XML element in a DACPAC model file, traversed in Phase 1 (preview) and Phase 2. */
export interface XmlElement {
  /** The internal SQL object type (e.g., 'SqlTable'). */
  '@_Type': string;
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

/** Metadata annotation on an XML element, often holding property values such as data types. */
interface XmlAnnotation {
  /** The type of annotation (e.g., 'SqlColumn.Type'). */
  '@_Type': string;
  /** Optional name for identifying specific annotations. */
  '@_Name'?: string;
  /** Properties contained within the annotation. */
  Property?: XmlProperty | XmlProperty[];
}

/** A key-value pair representing a property on an XML element or annotation. */
export interface XmlProperty {
  '@_Name': string;
  /** The value of the property, if provided as an attribute. */
  '@_Value'?: string;
  /** The value of the property, if provided as element text or CDATA (kept under `__cdata`). */
  Value?: string | { '#text'?: string; __cdata?: string | string[] };
}

/** Defines a structural relationship between elements in the DACPAC XML. */
interface XmlRelationship {
  /** The name of the relationship (e.g., 'Columns', 'QueryDependencies'). */
  '@_Name': string;
  /** The target entries participating in this relationship. */
  Entry?: XmlEntry | XmlEntry[];
}

/** A single entry within a {@link XmlRelationship}. */
interface XmlEntry {
  /** References to other top-level elements. */
  References?: XmlReference | XmlReference[];
  /** Inline child elements defined specifically for this entry. */
  Element?: XmlElement | XmlElement[];
}

/** A reference pointer to another element in the SQL model. */
export interface XmlReference {
  '@_Name': string;
  /** The external source of the reference, if applicable. */
  '@_ExternalSource'?: string;
}


/** Maps DACPAC element types to lineage object kinds. */
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

/** DACPAC element types that should produce lineage nodes. */
export const TRACKED_ELEMENT_TYPES = new Set(Object.keys(ELEMENT_TYPE_MAP));


/** Database column definition, used by the "Column Mode" detail view and schema exploration. */
export interface ColumnDef {
  name: string;
  /** The formatted SQL data type (e.g., 'nvarchar(50)'). */
  type: string;
  /** Whether the column allows nulls ('NULL' or 'NOT NULL'). */
  nullable: string;
  /** Additional flags like 'IDENTITY' or 'COMPUTED'. */
  extra: string;
  /** Compiler-declared expression references; their presence does not establish contribution. */
  expressionDependencies?: ColumnExpressionDependency[];
  /** Name of the unique constraint if the column participates in one. */
  unique?: string;
  /** Name of the check constraint if the column has one. */
  check?: string;
  /** Primary key ordinal (1-based) if the column is part of the PK. */
  pkOrdinal?: number;
}

/** Exact source metadata for a column expression reference, without inferred SQL semantics. */
interface ColumnExpressionDependency {
  /** Source reference identity with column qualification; DACPAC References.Name stays verbatim. */
  reference: string;
  /** Exact local source type: DACPAC XML Type or DMV sys.objects.type, when resolved. */
  sourceElementType?: string;
  /** External source identity; such a reference is not resolved against local elements. */
  externalSource?: string;
}

/** Foreign key constraint metadata — attached to table ExtractedObject (dacpac + DMV paths). */
export interface ForeignKeyInfo {
  name: string;
  /** The list of column names in the child table. */
  columns: string[];
  /** The schema of the referenced (parent) table. */
  refSchema: string;
  refTable: string;
  /** The list of column names in the parent table. */
  refColumns: string[];
  /** The referential action (e.g., 'CASCADE', 'SET NULL') on deletion. */
  onDelete: string;
}


/**
 * Formats a SQL type name with length/precision/scale modifiers, handling nvarchar/nchar byte→char
 * conversion and fixed-type detection.
 *
 * @param maxLength - Declared max length; unit depends on `lengthInChars`.
 * @param lengthInChars - True when `maxLength` is already a character count (dacpac
 *   `TypeSpecifier.Length`). False (default) when it is a byte count (DMV `max_length`), which
 *   nvarchar/nchar must still halve.
 */
export function formatColumnType(
  typeName: string, maxLength: string, precision: string, scale: string, lengthInChars = false
): string {
  const t = typeName.toLowerCase();

  if (['int', 'bigint', 'smallint', 'tinyint', 'bit', 'float', 'real',
    'money', 'smallmoney', 'date', 'datetime', 'datetime2', 'smalldatetime',
    'datetimeoffset', 'time', 'timestamp', 'uniqueidentifier', 'xml',
    'text', 'ntext', 'image', 'sql_variant', 'geography', 'geometry',
    'hierarchyid', 'sysname'].includes(t)) {
    return typeName;
  }

  if (['varchar', 'nvarchar', 'char', 'nchar', 'varbinary', 'binary'].includes(t)) {
    if (maxLength === '-1') return `${typeName}(max)`;
    const len = (t.startsWith('n') && maxLength && !lengthInChars)
      ? String(Math.floor(parseInt(maxLength, 10) / 2))
      : maxLength;
    return len ? `${typeName}(${len})` : typeName;
  }

  if (['decimal', 'numeric'].includes(t)) {
    if (precision && scale) return `${typeName}(${precision},${scale})`;
    if (precision) return `${typeName}(${precision})`;
    return typeName;
  }

  return typeName;
}

/**
 * The type a column shows when the source model declares none (a computed column whose expression
 * the model did not resolve). One home for the placeholder, so a later pass recognises its own
 * unresolved rows instead of string-matching a dash.
 */
export const UNRESOLVED_COLUMN_TYPE = '—';

/**
 * Builds a ColumnDef from raw metadata; the single code path for dacpac and DMV.
 *
 * @param lengthInChars - True when `maxLength` is a character count (dacpac); false (default) for a
 *   byte count (DMV), see `formatColumnType`.
 */
export function buildColumnDef(
  name: string,
  typeName: string,
  nullable: boolean,
  isIdentity: boolean,
  isComputed: boolean,
  maxLength?: string,
  precision?: string,
  scale?: string,
  lengthInChars = false,
): ColumnDef {
  return {
    name,
    type: isComputed
      ? (typeName !== '?' ? formatColumnType(typeName, maxLength ?? '', precision ?? '', scale ?? '', lengthInChars) : UNRESOLVED_COLUMN_TYPE)
      : formatColumnType(typeName, maxLength ?? '', precision ?? '', scale ?? '', lengthInChars),
    nullable: nullable ? 'NULL' : 'NOT NULL',
    extra: isIdentity ? 'IDENTITY' : isComputed ? 'COMPUTED' : '',
  };
}


/** Constraint lookups keyed by normalized table and column identifiers. */
export interface ConstraintMaps {
  /** Source-policy owner/column key → UQ constraint name. */
  uqColMap: Map<string, string>;
  /** Source-policy owner/column key → CK constraint name. */
  ckColMap: Map<string, string>;
  /** Source-policy owner key → FK list. */
  fkMap: Map<string, ForeignKeyInfo[]>;
  /** Source-policy owner/column key → PK ordinal (1-based). */
  pkOrdinalMap: Map<string, number>;
}

/**
 * Enriches columns with UQ/CK/PK flags and returns the foreign-key list for a table.
 *
 * @param identifierCaseSensitive - Checked source catalog policy for owner and column names.
 */
export function enrichColumnsWithConstraints(
  columns: ColumnDef[], tableKey: string, maps: ConstraintMaps, identifierCaseSensitive = false
): ForeignKeyInfo[] {
  for (const col of columns) {
    const colKey = schemaKey(`${tableKey}.${col.name}`, identifierCaseSensitive);
    col.unique    = maps.uqColMap.get(colKey) ?? '';
    col.check     = maps.ckColMap.get(colKey) ?? '';
    const pk      = maps.pkOrdinalMap.get(colKey);
    if (pk !== undefined) col.pkOrdinal = pk;
  }
  return maps.fkMap.get(tableKey) ?? [];
}

/** Factory for an empty SchemaInfo: the single source of truth for the zero-count init. */
export function createEmptySchemaInfo(name: string): SchemaInfo {
  return { name, nodeCount: 0, types: { table: 0, view: 0, procedure: 0, function: 0, external: 0 } };
}

/** A database object extracted in Phase 2, with structure such as columns and foreign keys. */
export interface ExtractedObject {
  /** Full schema-qualified name (e.g., "[dbo].[Table]"). */
  fullName: string;
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

/** Represents a raw dependency discovered during parsing. */
export interface ExtractedDependency {
  /** Normalized name of the referencing object. */
  sourceName: string;
  /** Normalized name of the referenced object. */
  targetName: string;
}

/** External file/URL reference detected by pre-cleansing regex pass. */
export interface ExternalRef {
  url: string;
  /** The classification of the reference (e.g., 'datalake', 'blob'). */
  kind: string;
}


/** Maps SQL Server DMV object codes to lineage object kinds. */
export const DMV_TYPE_MAP: Record<string, ObjectType> = {
  'U':  'table',
  'V':  'view',
  'P':  'procedure',
  'FN': 'function',
  'IF': 'function',
  'TF': 'function',
  'ET': 'external',  // External Table (PolyBase / data virtualization)
};

/** Configuration for graph layout algorithms (dagre). */
interface LayoutConfig {
  /** The flow direction of the graph: Top-to-Bottom (TB) or Left-to-Right (LR). */
  direction: 'TB' | 'LR';
  /** Spacing between hierarchical ranks. */
  rankSeparation: number;
  /** Spacing between nodes within the same rank. */
  nodeSeparation: number;
  edgeAnimation: boolean;
  highlightAnimation: boolean;
  minimapEnabled: boolean;
  edgeStyle: EdgeStyle;
}

type EdgeStyle = 'default' | 'smoothstep' | 'step' | 'straight';

/** Configuration for interactive lineage tracing. */
interface TraceConfig {
  defaultUpstreamLevels: number;
  defaultDownstreamLevels: number;
}

/** Configuration for graph analysis tools (hubs, islands, cycles). */
export interface AnalysisConfig {
  /** Minimum degree (in+out) for a node to be classified as a hub. */
  hubMinDegree: number;
  /** Maximum node count for a connected component to be classified as an island. */
  islandMaxSize: number;
  /** Minimum node count for a path to be classified as a "long path". */
  longestPathMinNodes: number;
}

/** Configuration for the table profiling/statistics engine. */
interface TableStatsConfig {
  enabled: boolean;
  /** Whether standard profiling (MIN/MAX, string length range, AVG, STDEV, empty counts) is on. */
  standardModeEnabled: boolean;
  excludeExternalTables: boolean;
  maxColumns: number;
  /** Threshold above which sampling is used instead of a full scan. */
  sampleThreshold: number;
  /** Target row count used to derive the platform-specific sampling clause. */
  sampleSize: number;
  /** Whether to use APPROX_COUNT_DISTINCT for performance on compatible platforms. */
  useApproxDistinct: boolean;
  /** Maximum duration (in seconds) allowed for a single profiling query. */
  queryTimeout: number;
}

/** Configuration for external reference detection and display. */
interface ExternalRefsConfig {
  /** Whether to detect and display cross-database and file-based references. */
  enabled: boolean;
}

/** Configuration for Schema View. */
interface OverviewConfig {
  /** When false, Schema View is off and new loads open in Object View until the hard limit. */
  enabled: boolean;
  /** Loaded-model object count above which the initial graph opens in Schema View. */
  threshold: number;
  schemaDoubleClickBehavior: 'expand' | 'expandOnly';
}

/**
 * Runtime configuration shared by model assembly, graph projection and the webview; host-only file
 * paths and AI settings stay at their owning boundaries.
 */
export interface ExtensionConfig {
  /** Regex patterns, with `%` wildcard compatibility, excluded from the webview model. */
  excludePatterns: string[];
  /** Hard cap on objects admitted to the working graph; a selection over it is refused, not cut. */
  maxNodes: number;
  /** Maximum duration (in seconds) for DMV metadata queries. */
  dmvQueryTimeout: number;
  layout: LayoutConfig;
  trace: TraceConfig;
  analysis: AnalysisConfig;
  tableStatistics: TableStatsConfig;
  externalRefs: ExternalRefsConfig;
  /** Schema View settings stored under the legacy `overview` configuration key. */
  overview: OverviewConfig;
  /** Max rendered nodes before showing a limit-reached warning instead of the graph. */
  renderLimit: number;
}

/** Fabric Data Warehouse engineEditionId — used for platform-specific query branching. */
export const ENGINE_EDITION_FABRIC = 11;

export const DEFAULT_CONFIG = {
  excludePatterns: [],
  maxNodes: 2000,
  layout: { direction: 'LR' as const, rankSeparation: 120, nodeSeparation: 30, edgeAnimation: true, highlightAnimation: false, minimapEnabled: true, edgeStyle: 'default' as const },
  trace: { defaultUpstreamLevels: 3, defaultDownstreamLevels: 3 },
  analysis: { hubMinDegree: 8, islandMaxSize: 500, longestPathMinNodes: 5 },
  tableStatistics: { enabled: true, standardModeEnabled: true, excludeExternalTables: true, maxColumns: 50, sampleThreshold: 100000, sampleSize: 10000, useApproxDistinct: true, queryTimeout: 60 },
  dmvQueryTimeout: 120,
  externalRefs: { enabled: true },
  overview: { enabled: true, threshold: 150, schemaDoubleClickBehavior: 'expandOnly' },
  renderLimit: 750,
} satisfies ExtensionConfig;


/** Supported top-level graph display modes for Object View and Schema View. */
export type GraphMode = 'full' | 'overview';

/** Data for a schema-level super-node rendered in Schema View. */
export interface SchemaNodeData extends Record<string, unknown> {
  schemaName: string;
  objectCount: number;
  /** Object counts keyed by lineage object type. */
  typeBreakdown: Partial<Record<ObjectType, number>>;
  color: string;
  /** True for a node of only external objects; those clusters use the fixed external color. */
  isExternalOnly?: boolean;
  /** Marks a collapsed schema cluster shown alongside object nodes in Expanded Schema View. */
  isExpandedSchemaViewCluster?: boolean;
  /** Right-click-only selection flag controlling the attached schema toolbar. */
  toolbarActive?: boolean;
}

/** One selectable direct neighbor for interactive trace add/prune controls. */
export type TraceNeighborOption = {
  /** Stable node ID passed back to trace edit handlers. */
  id: string;
  label: string;
  schema: string;
  /** Object kind used for compact type badges in the picker. */
  objectType: ObjectType;
  /** For a prune candidate, the number of other visible trace nodes reachable only through it. */
  cutCount?: number;
};

/** Add/prune candidates and disabled-copy for one lineage side of a node. */
export type TraceSideControls = {
  /** Direct neighbors that can be added on this side. */
  add: TraceNeighborOption[];
  /** Visible trace nodes that can be pruned on this side. */
  prune: TraceNeighborOption[];
  /** Reason add controls are disabled, or an empty string when enabled. */
  addDisabledReason: string;
  /** Reason prune controls are disabled, or an empty string when enabled. */
  pruneDisabledReason: string;
  /** Total direct neighbors on this side (drives hide-vs-disable for add). */
  neighborCount: number;
  /** Direct neighbors on this side already in the trace (drives hide-vs-disable for prune). */
  visibleNeighborCount: number;
};

/** Per-node callbacks and candidate lists for interactive trace editing. */
export type TraceNodeControls = {
  /** Controls for upstream direct-neighbor trace edits. */
  in: TraceSideControls;
  /** Controls for downstream direct-neighbor trace edits. */
  out: TraceSideControls;
  onAdd: (nodeId: string) => void;
  /** Removes the selected node from the current trace scope when safe. */
  onPrune: (nodeId: string) => void;
};

/** The business data associated with a single node in the React Flow canvas. */
export type CustomNodeData = {
  label: string;
  /** Schema name used for grouping, color selection, and tooltips. */
  schema: string;
  /** Fully qualified object name used by detail and debug surfaces. */
  fullName: string;
  /** Object kind that drives icon, color, and tooltip behavior. */
  objectType: ObjectType;
  /** Count of upstream dependencies shown in node metadata. */
  inDegree: number;
  /** Count of downstream dependents shown in node metadata. */
  outDegree: number;
  /** Highlight state applied by search, trace, or AI presentation. */
  highlighted?: boolean | 'yellow';
  externalType?: 'et' | 'file' | 'db';
  externalUrl?: string;
  externalDatabase?: string;
  /** Definition not readable: the node has no edges and shows a warning marker. */
  definitionUnreadable?: boolean;
  /** Resolved schema color supplied by the parent graph projection. */
  schemaColor?: string;
  /** AI-authored badge rendered above the node. */
  aiBadge?: AiBadge;
  /** AI-authored note rendered below the node. */
  aiNote?: { text: string };
  /** AI-authored highlight styling applied to the node border and glow. */
  aiHighlight?: { color: string; glow: string; shadow: string };
  /** Whether the scoped-view remove control is shown. */
  showRemoveButton?: boolean;
  /** Removes the node from the active allowlist-backed view. */
  onRemoveFromView?: (nodeId: string) => void;
  traceControls?: TraceNodeControls;
};

/**
 * An AI-authored section label rendered above a node. `emphasis` is the report's section focus, not
 * a node state: node bodies keep what the selection and column thread already say. The channels
 * stay separate because a section focus that dimmed nodes would overwrite the answer the user is
 * looking at.
 */
export type AiBadge = {
  text: string;
  /** `lit` for the focused section's own labels, `dim` for every other label. */
  emphasis?: 'lit' | 'dim';
};

/** The business data associated with a single column-trace node in the React Flow canvas. */
export type ColumnTraceNodeData = {
  /** Checked source catalog comparison policy for row/object identity. */
  identifierCaseSensitive?: boolean;
  /** Positioned view node computed by `buildColumnTraceView` (`src/engine/columnTraceView.ts`). */
  view: ColumnTraceViewNode;
  /** Whether the scoped-view remove control is shown — same chrome as {@link CustomNodeData}. */
  showRemoveButton?: boolean;
  /** Removes the node from the active allowlist-backed view. */
  onRemoveFromView?: (nodeId: string) => void;
  traceControls?: TraceNodeControls;
  /**
   * Per-row line state for the state dot, keyed by row name; populated by the caller from edges
   * touching the row, never computed here. An absent row renders an unstated dot.
   */
  rowLineStates?: Partial<Record<string, ColumnLineState>>;
  /** Highlight state applied by node selection, matching {@link CustomNodeData.highlighted}. */
  highlighted?: boolean | 'yellow';
  /** Whether the node is de-emphasized because a different node is selected. */
  dimmed?: boolean;
  /** AI-authored highlight styling applied to the node border and glow. */
  aiHighlight?: { color: string; glow: string; shadow: string };
  /** AI-authored badge rendered above the node. */
  aiBadge?: AiBadge;
  /** AI-authored note rendered below the node. */
  aiNote?: { text: string };
  /**
   * Resolved colour of the node's schema, matching {@link CustomNodeData.schemaColor} of the object
   * node it replaces (the external colour for an external object).
   */
  schemaColor?: string;
};

/** Durable graph filter state applied to the current model. */
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
   * When non-empty, only these node IDs are shown (applied after all other filters); empty or
   * absent means no restriction. Set by advanced bookmarks (trace-save, analysis-save, AI view).
   */
  allowlistNodeIds?: Set<string>;
}

/** Interactive trace state for the current graph session. */
export interface TraceState {
  mode: 'none' | 'configuring' | 'applied' | 'filtered' | 'pathfinding' | 'path-applied' | 'analysis';
  /** Analysis type when the trace is in analysis mode. */
  analysisType?: AnalysisType;
  /** Origin node ID for the trace. */
  selectedNodeId: string | null;
  targetNodeId: string | null;
  upstreamLevels: number;
  downstreamLevels: number;
  /** Original BFS node scope before interactive trace add/prune edits. */
  baseNodeIds: Set<string>;
  /** Original BFS edge scope before interactive trace add/prune edits. */
  baseEdgeIds: Set<string>;
  /** Direct-neighbor nodes manually added to the active trace. */
  manualAddedNodeIds: Set<string>;
  /** Nodes manually removed from the active trace. */
  manualPrunedNodeIds: Set<string>;
  tracedNodeIds: Set<string>;
  tracedEdgeIds: Set<string>;
  /** BFS auto-promoted to fullGraph because the target node was filtered out. */
  autoPromoted?: boolean;
}

/**
 * One side (in/out) of the highlighted node's serialized add/prune trace affordances. Function-free
 * so it survives postMessage; shared by the webview serializer and the host-side debug dump so the
 * two cannot drift.
 */
export interface TraceAffordanceSideSnapshot {
  /** Direct-neighbor node IDs that can be added on this lineage side. */
  add: string[];
  /** Visible trace node IDs that can be pruned on this lineage side. */
  prune: string[];
  /** Explanation shown when add controls are disabled. */
  addDisabledReason: string;
  /** Explanation shown when prune controls are disabled. */
  pruneDisabledReason: string;
  /** Total direct-neighbor count on this lineage side. */
  neighborCount: number;
  /** Direct-neighbor count already visible in the trace on this lineage side. */
  visibleNeighborCount: number;
}

/**
 * Serializable snapshot of the highlighted node's add/prune affordances, mirrored host-side via
 * `render-state`.
 */
export interface TraceAffordanceSnapshot {
  /** Highlighted node ID these affordances were computed for. */
  nodeId: string;
  /** Inbound-side add/prune affordances. */
  in: TraceAffordanceSideSnapshot;
  /** Outbound-side add/prune affordances. */
  out: TraceAffordanceSideSnapshot;
}


export type AnalysisType = 'islands' | 'hubs' | 'orphans' | 'longest-path' | 'cycles' | 'external-refs';

/** Grouped analysis result for a related set of nodes. */
export interface AnalysisGroup {
  id: string;
  label: string;
  nodeIds: string[];
  meta?: Record<string, string | number>;
}

/** Result payload returned by a graph analysis run. */
export interface AnalysisResult {
  type: AnalysisType;
  groups: AnalysisGroup[];
  /** Human-readable summary of the analysis result. */
  summary: string;
}

/** Active analysis view state. */
export interface AnalysisMode {
  type: AnalysisType;
  result: AnalysisResult;
  /** Selected analysis group, or `null` when none is active. */
  activeGroupId: string | null;
}
