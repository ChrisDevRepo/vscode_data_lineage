/**
 * ─── SQL Metadata ───────────────────────────────────────────────────────────
 *
 * Centralized repository for SQL Server system metadata, suppressed schemas,
 * and built-in CLR/XML methods.
 *
 * This ensures consistency across the parser and model builder.
 */

/**
 * Well-known system schemas whose objects must never appear as lineage nodes.
 * msdb/tempdb/model/master are SQL Server system databases whose schemas (dbo, etc.)
 * are commonly referenced in SPs but are never part of user lineage.
 */
export const SYSTEM_SCHEMAS = new Set([
  'sys',
  'information_schema',
  'msdb',
  'tempdb',
  'model',
  'master'
]);

/**
 * SQL Server XML data type methods that look like schema.object to the parser.
 * e.g. [ref].[value], [resume].[nodes] — never real catalog references.
 */
export const XML_METHODS = new Set([
  'nodes',
  'value',
  'exist',
  'query',
  'modify'
]);

/**
 * SQL Server CLR built-in type methods that appear as the last part of a 3-part name
 * (db.schema.object) but are NOT database catalog objects.
 *
 * Sources: HierarchyID / XML / Geometry / Geography method references on MS Learn.
 */
export const CLR_TYPE_METHODS = new Set([
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
