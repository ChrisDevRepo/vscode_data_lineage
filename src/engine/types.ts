// ─── Core Types ──────────────────────────────────────────────────────────────

export type ObjectType = 'table' | 'view' | 'procedure' | 'function';

export interface LineageNode {
  id: string;            // "[schema].[name]"
  schema: string;        // "dbo", "SalesLT", etc.
  name: string;          // object name without brackets/schema
  fullName: string;      // "[schema].[name]" as in dacpac
  type: ObjectType;
  bodyScript?: string;   // SQL body for SPs/Views/UDFs
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
  unrelated: string[];      // refs not in catalog
  excluded?: string[];      // refs removed by exclusion patterns
}

export interface ParseStats {
  parsedRefs: number;       // total refs found by regex
  resolvedEdges: number;    // matched dacpac catalog
  droppedRefs: string[];    // not in catalog, not external (CTEs, ghost refs)
  spDetails: SpParseDetail[];  // per-SP breakdown
}

export interface DacpacModel {
  nodes: LineageNode[];
  edges: LineageEdge[];
  schemas: SchemaInfo[];
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
};

export const TRACKED_ELEMENT_TYPES = new Set(Object.keys(ELEMENT_TYPE_MAP));

// ─── Intermediate extraction format (shared by dacpac + DMV extractors) ──────

export interface ColumnDef {
  name: string;
  type: string;
  nullable: string;
  extra: string;
}

export interface ExtractedObject {
  fullName: string;       // "[Schema].[Name]"
  type: ObjectType;
  bodyScript?: string;
  columns?: ColumnDef[];  // table column metadata (for table design view)
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
  | { type: 'dacpac-data'; data: number[]; fileName: string; config: ExtensionConfig; lastSelectedSchemas?: string[]; autoVisualize?: boolean }
  | { type: 'last-dacpac-gone' }
  | { type: 'themeChanged'; kind: string }
  | { type: 'mssql-status'; available: boolean }
  | { type: 'db-progress'; step: number; total: number; label: string }
  | { type: 'db-schema-preview'; preview: SchemaPreview; config: ExtensionConfig; sourceName: string; lastSelectedSchemas?: string[] }
  | { type: 'db-model'; model: DacpacModel; config: ExtensionConfig; sourceName: string; lastSelectedSchemas?: string[] }
  | { type: 'db-error'; message: string; phase: string }
  | { type: 'db-cancelled' };
