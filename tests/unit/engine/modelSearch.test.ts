import { describe, expect, it } from 'vitest';
import {
  compileSearchRegex,
  searchBodyScripts,
  searchCatalog,
  searchColumns,
  type SearchableNode,
} from '../../../src/utils/modelSearch';
import type { ColumnDef } from '../../../src/engine/types';

const column = (name: string, type = 'int'): ColumnDef => ({
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
    columns: [
      column('OrderID'),
      column('CustomerID'),
      column('OrderDate', 'datetime'),
    ],
  },
  {
    id: 'sales.orderdetail',
    name: 'OrderDetail',
    schema: 'Sales',
    type: 'table',
    columns: [
      column('OrderDetailID'),
      column('OrderID'),
      column('ProductID'),
      column('Quantity', 'smallint'),
    ],
  },
  {
    id: 'dbo.getorderssummary',
    name: 'GetOrdersSummary',
    schema: 'dbo',
    type: 'procedure',
    bodyScript: [
      'CREATE PROCEDURE dbo.GetOrdersSummary',
      'AS',
      'SELECT o.OrderID, SUM(d.Quantity) AS TotalQuantity',
      'FROM Sales.OrderHeader o',
      'JOIN Sales.OrderDetail d ON o.OrderID = d.OrderID',
    ].join('\n'),
  },
  {
    id: 'dbo.activecustomersview',
    name: 'ActiveCustomersView',
    schema: 'dbo',
    type: 'view',
    bodyScript:
      "CREATE VIEW dbo.ActiveCustomersView AS\nSELECT CustomerID FROM Customer WHERE Status = 'Active'",
  },
  {
    id: 'hr.employee',
    name: 'Employee',
    schema: 'HR',
    type: 'table',
    columns: [column('EmployeeID'), column('FirstName', 'nvarchar(50)')],
  },
  {
    id: '__ext__.abc123',
    name: 'ExternalRef',
    schema: '__ext__',
    type: 'external',
    columns: [column('RefID')],
  },
];

describe('model search', () => {
  it('compiles case-insensitive regexes and names the reason it rejects an invalid one', () => {
    const valid = compileSearchRegex('order');
    expect(valid.ok && valid.regex.test('OrderHeader')).toBe(true);

    const invalid = compileSearchRegex('[invalid(');
    expect(invalid.ok).toBe(false);
    expect(invalid.ok === false && invalid.reason).toBe('syntax');
  });

  it('searches and ranks catalog names case-insensitively', () => {
    const results = searchCatalog(nodes, 'ORDER');
    expect(results.map((node) => node.id)).toEqual([
      'sales.orderdetail',
      'sales.orderheader',
      'dbo.getorderssummary',
    ]);
    expect(searchCatalog(nodes, '')).toEqual([]);
    expect(searchCatalog(nodes, 'missing')).toEqual([]);
  });

  it('applies catalog type, schema, regex, and result limits', () => {
    expect(
      searchCatalog(nodes, 'Order', new Set(['table'] as const)).map(
        (node) => node.id,
      ),
    ).toEqual(['sales.orderdetail', 'sales.orderheader']);
    expect(
      searchCatalog(nodes, 'Order', undefined, new Set(['Sales'])).map(
        (node) => node.id,
      ),
    ).toEqual(['sales.orderdetail', 'sales.orderheader']);
    expect(
      searchCatalog(nodes, '^Order', undefined, undefined, 20, 'regex')
        .map((node) => node.id)
        .sort(),
      'GetOrdersSummary contains Order but does not start with it',
    ).toEqual(['sales.orderdetail', 'sales.orderheader']);
    expect(
      searchCatalog(nodes, '[invalid(', undefined, undefined, 20, 'regex'),
    ).toEqual([]);
    expect(searchCatalog(nodes, 'e', undefined, undefined, 2)).toHaveLength(2);
  });

  it('searches procedure and view bodies with useful snippets', () => {
    const procedure = searchBodyScripts(nodes, 'totalquantity');
    expect(procedure).toHaveLength(1);
    expect(procedure[0].node.id).toBe('dbo.getorderssummary');
    expect(procedure[0].snippet).toContain('TotalQuantity');

    const view = searchBodyScripts(nodes, 'ACTIVE');
    expect(view).toHaveLength(1);
    expect(view[0].node.id).toBe('dbo.activecustomersview');
    expect(searchBodyScripts(nodes, 'A')).toEqual([]);
  });

  it('reports every match in a body with its 1-based line and matched line text', () => {
    const compiled = compileSearchRegex('OrderID');
    if (!compiled.ok) throw new Error('OrderID must compile');
    const hits = searchBodyScripts(
      nodes,
      compiled.regex,
      new Set(['procedure'] as const),
    );
    expect(
      hits.map((h) => h.line),
      'line 3 once, line 5 twice',
    ).toEqual([3, 5, 5]);
    expect(hits[0].text).toBe(
      'SELECT o.OrderID, SUM(d.Quantity) AS TotalQuantity',
    );
    expect(hits[2].text).toBe(
      'JOIN Sales.OrderDetail d ON o.OrderID = d.OrderID',
    );
  });

  it('searches columns while excluding non-column object types', () => {
    const results = searchColumns(nodes, 'orderid');
    expect(results.map((result) => result.node.id)).toEqual([
      'sales.orderheader',
      'sales.orderdetail',
    ]);
    expect(results[0].snippet).toContain('OrderID');
    expect(searchColumns(nodes, 'I')).toEqual([]);
  });
});
