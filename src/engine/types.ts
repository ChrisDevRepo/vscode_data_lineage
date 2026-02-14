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
  maxNodes: 250,
  layout: { direction: 'LR' as const, rankSeparation: 120, nodeSeparation: 30, edgeAnimation: true, highlightAnimation: false, minimapEnabled: true },
  edgeStyle: 'default' as const,
  trace: { defaultUpstreamLevels: 3, defaultDownstreamLevels: 3 },
  analysis: { hubMinDegree: 8, islandMaxSize: 0, longestPathMinNodes: 5 },
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
  mode: 'none' | 'configuring' | 'applied' | 'filtered' | 'pathfinding' | 'path-applied';
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
