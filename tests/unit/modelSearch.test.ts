/**
 * Full-text search backend tests for src/utils/modelSearch.ts.
 *
 * Tests searchCatalog, searchBodyScripts, searchColumns, and safeRegex
 * using synthetic SearchableNode inputs — no dacpac, no VS Code, no GUI.
 *
 * Self-running node script (not vitest describe/it).
 * Auto-discovered by the support runner via discoverUnitTestFiles (root *.test.ts).
 */

import { assert, assertEq, printSummary, resetCounters } from './helpers/testUtils';
import {
  searchCatalog,
  searchBodyScripts,
  searchColumns,
  safeRegex,
  type SearchableNode,
} from '../../src/utils/modelSearch';
import type { ColumnDef } from '../../src/engine/types';

console.log('modelSearch — full-text search backend');
console.log('='.repeat(40));
resetCounters();

// ─── Synthetic fixtures ───────────────────────────────────────────────────────

const col = (name: string, type: string = 'int'): ColumnDef => ({
  name,
  type,
  nullable: 'NOT NULL',
  extra: '',
});

const nodes: SearchableNode[] = [
  {
    id: 'sales.orderheader',
    name: 'OrderHeader',
    schema: 'Sales',
    type: 'table',
    columns: [col('OrderID'), col('CustomerID'), col('OrderDate', 'datetime')],
  },
  {
    id: 'sales.orderdetail',
    name: 'OrderDetail',
    schema: 'Sales',
    type: 'table',
    columns: [col('OrderDetailID'), col('OrderID'), col('ProductID'), col('Quantity', 'smallint')],
  },
  {
    id: 'dbo.getorderssummary',
    name: 'GetOrdersSummary',
    schema: 'dbo',
    type: 'procedure',
    bodyScript: [
      'CREATE PROCEDURE dbo.GetOrdersSummary',
      '  @StartDate datetime,',
      '  @EndDate datetime',
      'AS',
      'BEGIN',
      '  SELECT o.OrderID, SUM(d.Quantity) AS TotalQuantity',
      '  FROM Sales.OrderHeader o',
      '  JOIN Sales.OrderDetail d ON o.OrderID = d.OrderID',
      '  WHERE o.OrderDate BETWEEN @StartDate AND @EndDate',
      'END',
    ].join('\n'),
  },
  {
    id: 'dbo.activecustomersview',
    name: 'ActiveCustomersView',
    schema: 'dbo',
    type: 'view',
    bodyScript: [
      'CREATE VIEW dbo.ActiveCustomersView AS',
      'SELECT CustomerID, LastName, FirstName',
      'FROM Customer',
      "WHERE Status = 'Active'",
    ].join('\n'),
  },
  {
    id: 'hr.employee',
    name: 'Employee',
    schema: 'HR',
    type: 'table',
    columns: [col('EmployeeID'), col('FirstName', 'nvarchar(50)'), col('LastName', 'nvarchar(50)')],
  },
  {
    id: '__ext__.abc123',
    name: 'ExternalRef',
    schema: '__ext__',
    type: 'external',
    columns: [col('RefID')],
  },
];

// ─── safeRegex ────────────────────────────────────────────────────────────────

{
  const re = safeRegex('Order');
  assert(re !== null, 'safeRegex: valid pattern returns RegExp');
  assert(re instanceof RegExp, 'safeRegex: result is a RegExp instance');
  assert(re?.test('OrderHeader') === true, 'safeRegex: compiled regex matches expected string');
  assert(re?.flags.includes('i') === true, 'safeRegex: compiled regex is case-insensitive');

  const bad = safeRegex('[invalid(');
  assert(bad === null, 'safeRegex: invalid regex pattern returns null');
}

// ─── searchCatalog — empty query ──────────────────────────────────────────────

{
  const results = searchCatalog(nodes, '');
  assertEq(results.length, 0, 'searchCatalog: empty query returns empty array');
}

// ─── searchCatalog — single-char query (min length = 1) ───────────────────────

{
  // 'E' should match Employee and ExternalRef (both contain 'e')
  const results = searchCatalog(nodes, 'E');
  assert(results.length > 0, 'searchCatalog: single-char query is accepted (min length is 1)');
}

// ─── searchCatalog — exact name match ─────────────────────────────────────────

{
  const results = searchCatalog(nodes, 'Employee');
  assertEq(results.length, 1, 'searchCatalog: exact name returns exactly one result');
  assertEq(results[0].id, 'hr.employee', 'searchCatalog: exact match resolves to correct node id');
}

// ─── searchCatalog — case-insensitive ─────────────────────────────────────────

{
  const lower = searchCatalog(nodes, 'employee');
  const upper = searchCatalog(nodes, 'EMPLOYEE');
  assertEq(lower.length, 1, 'searchCatalog: lowercase query finds node');
  assertEq(upper.length, 1, 'searchCatalog: uppercase query finds same node');
  assertEq(lower[0].id, upper[0].id, 'searchCatalog: case variant resolves to same node');
}

// ─── searchCatalog — substring match ──────────────────────────────────────────

{
  // 'Order' appears in OrderHeader, OrderDetail, GetOrdersSummary
  const results = searchCatalog(nodes, 'Order');
  assert(results.length >= 3, 'searchCatalog: substring query matches multiple nodes');
  const ids = results.map(n => n.id);
  assert(ids.includes('sales.orderheader'), 'searchCatalog: substring matches OrderHeader');
  assert(ids.includes('sales.orderdetail'), 'searchCatalog: substring matches OrderDetail');
  assert(ids.includes('dbo.getorderssummary'), 'searchCatalog: substring matches GetOrdersSummary (id contains order)');
}

// ─── searchCatalog — starts-with ranked before mid-word match ─────────────────

{
  // 'Order' — OrderHeader/OrderDetail start with it; GetOrdersSummary only contains it
  const results = searchCatalog(nodes, 'Order');
  const idx = (id: string) => results.findIndex(n => n.id === id);
  const headerPos = idx('sales.orderheader');
  const detailPos = idx('sales.orderdetail');
  const procPos = idx('dbo.getorderssummary');
  assert(headerPos < procPos, 'searchCatalog: starts-with node ranks before mid-match node (header < proc)');
  assert(detailPos < procPos, 'searchCatalog: starts-with node ranks before mid-match node (detail < proc)');
}

// ─── searchCatalog — no match → empty ─────────────────────────────────────────

{
  const results = searchCatalog(nodes, 'ZZZNoSuchObject');
  assertEq(results.length, 0, 'searchCatalog: non-matching query returns empty array');
}

// ─── searchCatalog — type filter ──────────────────────────────────────────────

{
  const results = searchCatalog(nodes, 'Order', new Set(['table'] as const));
  assert(results.every(n => n.type === 'table'), 'searchCatalog: type filter restricts to tables only');
  assert(results.every(n => n.id !== 'dbo.getorderssummary'), 'searchCatalog: type filter excludes procedures');
}

// ─── searchCatalog — schema filter ────────────────────────────────────────────

{
  const results = searchCatalog(nodes, 'Order', undefined, new Set(['Sales']));
  assert(results.every(n => n.schema === 'Sales'), 'searchCatalog: schema filter restricts to Sales schema');
  assertEq(results.length, 2, 'searchCatalog: schema filter finds exactly 2 Sales nodes with Order');
}

// ─── searchCatalog — limit respected ──────────────────────────────────────────

{
  // Nodes list has 6 entries; query 'e' matches many — limit to 2
  const results = searchCatalog(nodes, 'e', undefined, undefined, 2);
  assert(results.length <= 2, 'searchCatalog: limit parameter caps result count');
}

// ─── searchCatalog — regex mode ───────────────────────────────────────────────

{
  const results = searchCatalog(nodes, '^Order', undefined, undefined, 20, 'regex');
  assert(results.length >= 2, 'searchCatalog: regex mode ^ anchor matches names starting with Order');
  assert(results.every(n => n.name.toLowerCase().startsWith('order')), 'searchCatalog: regex ^ matches only start-anchored names');
}

{
  // Regex that matches schema.name pattern
  const results = searchCatalog(nodes, 'Sales\\.Order', undefined, undefined, 20, 'regex');
  assert(results.length >= 2, 'searchCatalog: regex mode matches schema.name composite');
}

{
  // Invalid regex in regex mode returns empty
  const results = searchCatalog(nodes, '[invalid(', undefined, undefined, 20, 'regex');
  assertEq(results.length, 0, 'searchCatalog: invalid regex returns empty array');
}

// ─── searchBodyScripts — query too short ─────────────────────────────────────

{
  const results = searchBodyScripts(nodes, 'A');
  assertEq(results.length, 0, 'searchBodyScripts: single-char query returns empty (min is 2)');
}

{
  const results = searchBodyScripts(nodes, '');
  assertEq(results.length, 0, 'searchBodyScripts: empty query returns empty');
}

// ─── searchBodyScripts — term found in procedure body ────────────────────────

{
  const results = searchBodyScripts(nodes, 'TotalQuantity');
  assertEq(results.length, 1, 'searchBodyScripts: term found in procedure body returns one match');
  assertEq(results[0].node.id, 'dbo.getorderssummary', 'searchBodyScripts: match resolves to correct procedure node');
  assert(results[0].snippet.length > 0, 'searchBodyScripts: match carries a non-empty snippet');
  assert(results[0].snippet.includes('TotalQuantity'), 'searchBodyScripts: snippet contains the matched term');
}

// ─── searchBodyScripts — term found in view body ─────────────────────────────

{
  const results = searchBodyScripts(nodes, 'Active');
  assertEq(results.length, 1, 'searchBodyScripts: term found in view body returns one match');
  assertEq(results[0].node.id, 'dbo.activecustomersview', 'searchBodyScripts: match resolves to correct view node');
}

// ─── searchBodyScripts — case-insensitive ────────────────────────────────────

{
  const lower = searchBodyScripts(nodes, 'totalquantity');
  const upper = searchBodyScripts(nodes, 'TOTALQUANTITY');
  assertEq(lower.length, 1, 'searchBodyScripts: lowercase finds body term');
  assertEq(upper.length, 1, 'searchBodyScripts: uppercase finds same body term');
  assertEq(lower[0].node.id, upper[0].node.id, 'searchBodyScripts: case variant resolves to same node');
}

// ─── searchBodyScripts — tables with no bodyScript are skipped ───────────────

{
  const results = searchBodyScripts(nodes, 'OrderID');
  // OrderID appears only in body scripts, not in table bodyScript (tables have none here)
  assert(results.every(n => n.node.bodyScript !== undefined), 'searchBodyScripts: all matches have a bodyScript');
  assert(!results.some(n => n.node.type === 'table'), 'searchBodyScripts: table nodes without bodyScript are skipped');
}

// ─── searchBodyScripts — no match → empty ────────────────────────────────────

{
  const results = searchBodyScripts(nodes, 'ZZZNoSuchTerm');
  assertEq(results.length, 0, 'searchBodyScripts: non-matching term returns empty array');
}

// ─── searchBodyScripts — type filter ─────────────────────────────────────────

{
  // 'SELECT' appears in both procedure and view bodies
  const allResults = searchBodyScripts(nodes, 'SELECT');
  const procOnly = searchBodyScripts(nodes, 'SELECT', new Set(['procedure'] as const));
  assert(allResults.length >= 2, 'searchBodyScripts: SELECT found in multiple bodies');
  assert(procOnly.every(n => n.node.type === 'procedure'), 'searchBodyScripts: type filter restricts to procedures only');
  assert(procOnly.length < allResults.length, 'searchBodyScripts: type filter reduces result count');
}

// ─── searchBodyScripts — snippet context lines ────────────────────────────────

{
  // With contextLines=1, the snippet should be short (just the matching line)
  const results = searchBodyScripts(nodes, 'TotalQuantity', undefined, 1);
  assert(results.length === 1, 'searchBodyScripts: contextLines=1 still finds the match');
  // Single-line context: snippet contains the match but fewer surrounding lines
  const lineCount = results[0].snippet.split('\n').length;
  assert(lineCount <= 2, 'searchBodyScripts: contextLines=1 produces at most 2 lines in snippet');
}

// ─── searchBodyScripts — limit respected ─────────────────────────────────────

{
  // 'SELECT' matches both proc and view — limit to 1
  const results = searchBodyScripts(nodes, 'SELECT', undefined, 2, 1);
  assert(results.length <= 1, 'searchBodyScripts: limit parameter caps result count');
}

// ─── searchColumns — query too short ─────────────────────────────────────────

{
  const results = searchColumns(nodes, 'I');
  assertEq(results.length, 0, 'searchColumns: single-char query returns empty (min is 2)');
}

{
  const results = searchColumns(nodes, '');
  assertEq(results.length, 0, 'searchColumns: empty query returns empty');
}

// ─── searchColumns — column name found ───────────────────────────────────────

{
  // 'OrderID' appears as a column on both OrderHeader and OrderDetail
  const results = searchColumns(nodes, 'OrderID');
  assert(results.length >= 2, 'searchColumns: column name found on multiple nodes');
  const ids = results.map(r => r.node.id);
  assert(ids.includes('sales.orderheader'), 'searchColumns: finds OrderHeader by OrderID column');
  assert(ids.includes('sales.orderdetail'), 'searchColumns: finds OrderDetail by OrderID column');
}

// ─── searchColumns — case-insensitive ────────────────────────────────────────

{
  const lower = searchColumns(nodes, 'orderid');
  const upper = searchColumns(nodes, 'ORDERID');
  assertEq(lower.length, upper.length, 'searchColumns: case variant produces same result count');
}

// ─── searchColumns — partial column name match ────────────────────────────────

{
  // 'ID' is a suffix of many column names
  const results = searchColumns(nodes, 'ID');
  assert(results.length >= 2, 'searchColumns: partial column name matches multiple nodes');
}

// ─── searchColumns — procedure nodes are excluded ─────────────────────────────

{
  // GetOrdersSummary is a procedure and has no columns — must not appear
  const results = searchColumns(nodes, 'OrderID');
  assert(!results.some(r => r.node.type === 'procedure'), 'searchColumns: procedure nodes are excluded');
  assert(!results.some(r => r.node.type === 'view'), 'searchColumns: view nodes are excluded');
}

// ─── searchColumns — external type is included ────────────────────────────────

{
  // ExternalRef is type='external' and has RefID column
  const results = searchColumns(nodes, 'RefID');
  assert(results.some(r => r.node.id === '__ext__.abc123'), 'searchColumns: external type nodes with matching columns are included');
}

// ─── searchColumns — snippet lists matching columns ───────────────────────────

{
  const results = searchColumns(nodes, 'OrderID');
  assert(results.length > 0, 'searchColumns: results exist for OrderID');
  assert(results[0].snippet.includes('OrderID'), 'searchColumns: snippet contains the matched column name');
}

// ─── searchColumns — no match → empty ────────────────────────────────────────

{
  const results = searchColumns(nodes, 'ZZZNoSuchColumn');
  assertEq(results.length, 0, 'searchColumns: non-matching column name returns empty array');
}

// ─── searchColumns — limit respected ─────────────────────────────────────────

{
  // 'ID' matches many columns across multiple nodes — limit to 1
  const results = searchColumns(nodes, 'ID', 1);
  assert(results.length <= 1, 'searchColumns: limit parameter caps result count');
}

// ─── searchColumns — snippet caps at 3 matching columns ──────────────────────

{
  // OrderDetail has: OrderDetailID, OrderID, ProductID, Quantity — 3 contain 'ID'
  const results = searchColumns(nodes, 'ID', 100);
  const detail = results.find(r => r.node.id === 'sales.orderdetail');
  assert(detail !== undefined, 'searchColumns: OrderDetail found in ID search');
  // snippet is slice(0, 3) of matching columns joined by ', '
  const snippetParts = detail!.snippet.split(', ');
  assert(snippetParts.length <= 3, 'searchColumns: snippet contains at most 3 matching columns');
}

printSummary('modelSearch');
