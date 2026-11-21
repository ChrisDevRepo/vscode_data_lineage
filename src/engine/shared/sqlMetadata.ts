/**
 * SQL Server system metadata (suppressed schemas, built-in CLR/XML methods): one source of truth
 * for objects excluded from lineage graphs, keeping the parser and model builder consistent.
 *
 * @packageDocumentation
 */

/**
 * Well-known system schemas whose objects must never appear as lineage nodes. `msdb`, `tempdb`,
 * `model` and `master` are system databases; their schemas (`dbo`, `sys`, ...) are commonly
 * referenced in stored procedures but are not user-defined data lineage.
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
 * SQL Server XML data type methods that look like `schema.object` to the parser: in
 * `[ref].[value]`, `value` is an XML method, not an object in a schema named `ref`; counting it
 * would create "hallucinated" nodes.
 *
 * @see
 *   {@link https://learn.microsoft.com/en-us/sql/t-sql/xml/xml-data-type-methods-xml-data-type | XML Data Type Methods}
 */
export const XML_METHODS: Set<string> = new Set([
  'nodes',
  'value',
  'exist',
  'query',
  'modify'
]);

/**
 * SQL Server CLR built-in type methods that appear as the last part of a 3-part name. They look
 * like `db.schema.object` but are method calls on system types such as `HierarchyID`, `Geometry` or
 * `Geography`; the set suppresses false positive catalog references during cross-database lineage
 * extraction.
 *
 * @see
 *   {@link https://learn.microsoft.com/en-us/sql/t-sql/data-types/hierarchyid-data-type-method-reference | HierarchyID Methods}
 * @see
 *   {@link https://learn.microsoft.com/en-us/sql/t-sql/spatial-geometry/ogc-methods-on-geometry-instances | Geometry Methods}
 */
export const CLR_TYPE_METHODS: Set<string> = new Set([
  'getancestor', 'getdescendant', 'getlevel', 'getroot', 'getreparentedvalue',
  'isdescendantof', 'reparent', 'tostring', 'parse',

  'value', 'query', 'exist', 'modify', 'nodes',

  'starea', 'stasbinary', 'stastext', 'stboundary', 'stbuffer', 'stcentroid',
  'stcontains', 'stconvexhull', 'stcrosses', 'stdifference', 'stdimension',
  'stdisjoint', 'stdistance', 'stendpoint', 'stenvelope', 'stequals',
  'stexteriorring', 'stgeometryn', 'stgeometrytype', 'stinteriorringn',
  'stintersection', 'stintersects', 'stisclosed', 'stisempty', 'stisring',
  'stissimple', 'stisvalid', 'stlength', 'stnumcurves', 'stnumgeometries',
  'stnuminteriorring', 'stnumpoints', 'stoverlaps', 'stpointn', 'strelate',
  'stsrid', 'ststartpoint', 'stsymdifference', 'sttouches', 'stunion',
  'stwithin', 'stx', 'sty',

  'stgeomfromtext', 'stgeomfromwkb', 'stpointfromtext', 'stpointfromwkb',
  'stlinefromtext', 'stlinefromwkb', 'stpolyfromtext', 'stpolyfromwkb',
  'stgeomcollfromtext', 'stgeomcollfromwkb',

  'makevalid', 'reduce', 'bufferwithtolerance',
]);
