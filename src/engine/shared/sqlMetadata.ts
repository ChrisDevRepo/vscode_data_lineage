/**
 * ─── SQL Metadata ───────────────────────────────────────────────────────────
 *
 * Centralized repository for SQL Server system metadata, suppressed schemas,
 * and built-in CLR/XML methods.
 *
 * This ensures consistency across the parser and model builder by providing 
 * a single source of truth for objects that should be excluded from lineage 
 * graphs.
 * 
 * @packageDocumentation
 */

/**
 * Well-known system schemas whose objects must never appear as lineage nodes.
 * 
 * @remarks
 * `msdb`, `tempdb`, `model`, and `master` are SQL Server system databases. 
 * Their schemas (like `dbo`, `sys`, etc.) are commonly referenced in stored 
 * procedures but are generally not considered part of user-defined data lineage.
 * 
 * @constant
 * @readonly
 */
export const SYSTEM_SCHEMAS: Set<string> = new Set([
  'sys',
  'information_schema',
  'msdb',
  'tempdb',
  'model',
  'master'
]);

/**
 * SQL Server XML data type methods that look like `schema.object` to the parser.
 * 
 * @remarks
 * For example, in `[ref].[value]`, `value` is an XML method, not a database 
 * object in a schema named `ref`. Including these in lineage would create 
 * "hallucinated" nodes.
 * 
 * @constant
 * @readonly
 * @see {@link https://learn.microsoft.com/en-us/sql/t-sql/xml/xml-data-type-methods-xml-data-type | XML Data Type Methods}
 */
export const XML_METHODS: Set<string> = new Set([
  'nodes',
  'value',
  'exist',
  'query',
  'modify'
]);

/**
 * SQL Server CLR built-in type methods that appear as the last part of a 3-part name.
 * 
 * @remarks
 * These often look like `db.schema.object` but are actually method calls on 
 * system types like `HierarchyID`, `Geometry`, or `Geography`.
 * 
 * This set is used to suppress false positive catalog references during 
 * cross-database lineage extraction.
 * 
 * @constant
 * @readonly
 * @see {@link https://learn.microsoft.com/en-us/sql/t-sql/data-types/hierarchyid-data-type-method-reference | HierarchyID Methods}
 * @see {@link https://learn.microsoft.com/en-us/sql/t-sql/spatial-geometry/ogc-methods-on-geometry-instances | Geometry Methods}
 */
export const CLR_TYPE_METHODS: Set<string> = new Set([
  // HierarchyID
  'getancestor', 'getdescendant', 'getlevel', 'getroot', 'getreparentedvalue',
  'isdescendantof', 'reparent', 'tostring', 'parse',
  
  // XML data type (also in XML_METHODS)
  'value', 'query', 'exist', 'modify', 'nodes',
  
  // Geometry / Geography OGC instance methods
  'starea', 'stasbinary', 'stastext', 'stboundary', 'stbuffer', 'stcentroid',
  'stcontains', 'stconvexhull', 'stcrosses', 'stdifference', 'stdimension',
  'stdisjoint', 'stdistance', 'stendpoint', 'stenvelope', 'stequals',
  'stexteriorring', 'stgeometryn', 'stgeometrytype', 'stinteriorringn',
  'stintersection', 'stintersects', 'stisclosed', 'stisempty', 'stisring',
  'stissimple', 'stisvalid', 'stlength', 'stnumcurves', 'stnumgeometries',
  'stnuminteriorring', 'stnumpoints', 'stoverlaps', 'stpointn', 'strelate',
  'stsrid', 'ststartpoint', 'stsymdifference', 'sttouches', 'stunion',
  'stwithin', 'stx', 'sty',
  
  // Geometry/Geography static constructors
  'stgeomfromtext', 'stgeomfromwkb', 'stpointfromtext', 'stpointfromwkb',
  'stlinefromtext', 'stlinefromwkb', 'stpolyfromtext', 'stpolyfromwkb',
  'stgeomcollfromtext', 'stgeomcollfromwkb',
  
  // SQL Server-specific spatial helpers
  'makevalid', 'reduce', 'bufferwithtolerance',
]);
