import { describe, expect, it } from 'vitest';
import {
  compileSearchRegex,
  regexRejectHint,
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
    columns: [column('OrderID'), column('CustomerID'), column('OrderDate', 'datetime')],
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
    bodyScript: "CREATE VIEW dbo.ActiveCustomersView AS\nSELECT CustomerID FROM Customer WHERE Status = 'Active'",
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

  it('strips a redundant leading "(?i)" and compiles the remainder', () => {
    const result = compileSearchRegex('(?i)raworderimport');
    expect(result.ok).toBe(true);
    expect(result.ok && result.regex.test('RawOrderImport')).toBe(true);
  });

  it('still rejects a flag group that changes semantics beyond case-insensitivity', () => {
    const multiline = compileSearchRegex('(?m)foo');
    expect(multiline.ok).toBe(false);
    expect(multiline.ok === false && multiline.reason).toBe('syntax');

    const mixed = compileSearchRegex('(?im)foo');
    expect(mixed.ok).toBe(false);
    expect(mixed.ok === false && mixed.reason).toBe('syntax');
  });

  it('leaves the scoped "(?i:...)" form untouched — it is a different construct, not a no-op prefix', () => {
    const scoped = compileSearchRegex('(?i:foo)');
    expect(scoped.ok).toBe(false);
    expect(scoped.ok === false && scoped.reason).toBe('syntax');
  });

  it('does not strip a bare "(?i)" pattern down to an empty, match-everything regex', () => {
    const bare = compileSearchRegex('(?i)');
    expect(bare.ok).toBe(false);
    expect(bare.ok === false && bare.reason).toBe('syntax');
  });

  it('reports the normalization through the provided sink instead of rewriting silently', () => {
    const messages: string[] = [];
    compileSearchRegex('(?i)raworderimport', msg => messages.push(msg));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('(?i)');

    const unchanged: string[] = [];
    compileSearchRegex('order', msg => unchanged.push(msg));
    expect(unchanged).toHaveLength(0);
  });

  it('searches and ranks catalog names case-insensitively', () => {
    const results = searchCatalog(nodes, 'ORDER');
    expect(results.map(node => node.id)).toEqual([
      'sales.orderdetail',
      'sales.orderheader',
      'dbo.getorderssummary',
    ]);
    expect(searchCatalog(nodes, '')).toEqual([]);
    expect(searchCatalog(nodes, 'missing')).toEqual([]);
  });

  it('applies catalog type, schema, regex, and result limits', () => {
    expect(
      searchCatalog(nodes, 'Order', new Set(['table'] as const))
        .every(node => node.type === 'table'),
    ).toBe(true);
    expect(
      searchCatalog(nodes, 'Order', undefined, new Set(['Sales']))
        .map(node => node.id),
    ).toEqual(['sales.orderdetail', 'sales.orderheader']);
    expect(
      searchCatalog(nodes, '^Order', undefined, undefined, 20, 'regex')
        .every(node => node.name.startsWith('Order')),
    ).toBe(true);
    expect(searchCatalog(nodes, '[invalid(', undefined, undefined, 20, 'regex'))
      .toEqual([]);
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

  it('matches a compiled regex against bodies — the lineage_search_ddl contract (T3 loop, 2026-09-06)', () => {
    // The tool validates the pattern with compileSearchRegex but the body search matched the raw
    // pattern text as a substring, so `(?i)totalquantity` and `total.*quantity` returned nothing.
    for (const pattern of ['(?i)totalquantity', 'total.*quantity', 'TOTALQUANTITY']) {
      const compiled = compileSearchRegex(pattern);
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) return;
      const hits = searchBodyScripts(nodes, compiled.regex);
      expect(hits.map(h => h.node.id)).toEqual(['dbo.getorderssummary']);
      expect(hits[0].snippet).toContain('TotalQuantity');
    }
    const none = compileSearchRegex('no.such.token');
    expect(none.ok && searchBodyScripts(nodes, none.regex)).toEqual([]);
  });

  it('reports every match in a body with its 1-based line and matched line text', () => {
    // Grep's contract: one entry per match, located. One entry per object hid the second and
    // later occurrences, so the model could not tell "mentioned once" from "used throughout".
    const compiled = compileSearchRegex('OrderID');
    if (!compiled.ok) throw new Error('OrderID must compile');
    const hits = searchBodyScripts(nodes, compiled.regex, new Set(['procedure'] as const));
    expect(hits.map(h => h.line), 'line 3 once, line 5 twice').toEqual([3, 5, 5]);
    expect(hits[0].text).toBe('SELECT o.OrderID, SUM(d.Quantity) AS TotalQuantity');
    expect(hits[2].text).toBe('JOIN Sales.OrderDetail d ON o.OrderID = d.OrderID');
  });

  it('keeps ^, $ and . anchored to the whole body — the flags are fixed to "i"', () => {
    const count = (pattern: string): number => {
      const compiled = compileSearchRegex(pattern);
      if (!compiled.ok) throw new Error(`${pattern} must compile`);
      return searchBodyScripts(nodes, compiled.regex, new Set(['procedure'] as const)).length;
    };
    expect(count('^CREATE'), '^ is the body start').toBe(1);
    expect(count('^SELECT'), 'SELECT starts a line, not the body').toBe(0);
    expect(count('d.OrderID$'), '$ is the body end').toBe(1);
    expect(count('AS.SELECT'), '. never crosses a line break').toBe(0);
  });

  it('does not skip a body whose first match is empty', () => {
    // `x*` matches the empty string at offset 0; the scan advances one position instead of
    // abandoning the node, so the real match later in the same body is still reported.
    const body: SearchableNode[] = [{
      id: 'dbo.vwx', name: 'vwX', schema: 'dbo', type: 'view',
      bodyScript: 'SELECT ColA\nFROM dbo.xTable',
    }];
    const compiled = compileSearchRegex('x*');
    if (!compiled.ok) throw new Error('x* must compile');
    const hits = searchBodyScripts(body, compiled.regex);
    expect(hits.length, 'the node is scanned, not skipped').toBeGreaterThan(0);
    expect(hits.some(h => h.text.includes('xTable')), 'the real match is reported').toBe(true);
  });

  it('never windows a regex match line, and still windows the sidebar substring line', () => {
    const wide = 'x'.repeat(120);
    const body: SearchableNode[] = [{
      id: 'dbo.vwwide', name: 'vwWide', schema: 'dbo', type: 'view',
      bodyScript: `SELECT ${wide} AS TotalQuantity FROM dbo.T`,
    }];
    const compiled = compileSearchRegex('TotalQuantity');
    if (!compiled.ok) throw new Error('TotalQuantity must compile');
    const [regexHit] = searchBodyScripts(body, compiled.regex);
    expect(regexHit.snippet, 'a tool result is never elided').not.toContain('\u2026');
    expect(regexHit.snippet).toContain(wide);

    const [stringHit] = searchBodyScripts(body, 'TotalQuantity');
    expect(stringHit.snippet, 'the sidebar still windows to its panel width').toContain('\u2026');
  });

  it('applies body type, context, and result limits', () => {
    const procedures = searchBodyScripts(
      nodes,
      'SELECT',
      new Set(['procedure'] as const),
      1,
      1,
    );
    expect(procedures).toHaveLength(1);
    expect(procedures[0].node.type).toBe('procedure');
    expect(procedures[0].snippet.split('\n').length).toBeLessThanOrEqual(2);
  });

  it('searches columns while excluding non-column object types', () => {
    const results = searchColumns(nodes, 'orderid');
    expect(results.map(result => result.node.id)).toEqual([
      'sales.orderheader',
      'sales.orderdetail',
    ]);
    expect(results[0].snippet).toContain('OrderID');
    expect(results.some(result =>
      result.node.type === 'procedure' || result.node.type === 'view')).toBe(false);
    expect(searchColumns(nodes, 'I')).toEqual([]);
  });

  it('includes external columns and enforces result/snippet limits', () => {
    expect(searchColumns(nodes, 'RefID')[0].node.id).toBe('__ext__.abc123');
    expect(searchColumns(nodes, 'ID', 1)).toHaveLength(1);
    const detail = searchColumns(nodes, 'ID', 100)
      .find(result => result.node.id === 'sales.orderdetail');
    expect(detail?.snippet.split(', ')).toHaveLength(3);
  });
});

describe('regexRejectHint', () => {
  /** Compiles `pattern`, asserts it was refused, and returns the hint derived from that refusal. */
  function hintFor(pattern: string): string {
    const compiled = compileSearchRegex(pattern);
    if (compiled.ok) throw new Error(`expected ${pattern} to be rejected`);
    return regexRejectHint(pattern, compiled);
  }

  it('names the flags option instead of blaming nested quantifiers for an inline flag', () => {
    // A redundant "(?i)" no longer reaches this hint — compileSearchRegex strips it and compiles
    // the remainder (covered in the 'model search' describe above). "(?m)" requests semantics the
    // engine does not otherwise apply, so it still fails to compile and still needs this hint.
    const hint = hintFor('(?m)order');
    expect(hint).toContain('inline flag');
    expect(hint).toContain('already case-insensitive');
    expect(hint).not.toContain('nested quantifiers');
  });

  it('flags a Python-style named group with its JavaScript spelling', () => {
    const hint = hintFor('(?P<name>foo)');
    expect(hint).toContain('(?<name>...)');
  });

  it('flags an inline comment group as unsupported', () => {
    expect(hintFor('(?#comment)foo')).toContain('comment group');
  });

  it('names the missing closing paren for an unbalanced open group', () => {
    expect(hintFor('foo(bar')).toContain('closing ")"');
  });

  it('names the extra closing paren for an unmatched close', () => {
    expect(hintFor('foo)bar')).toContain('extra ")"');
  });

  it('names the missing closing bracket for an unterminated character class', () => {
    expect(hintFor('foo[bar')).toContain('closing "]"');
  });

  it('names the dangling quantifier for a lone repeat operator', () => {
    expect(hintFor('foo**')).toContain('quantifier');
  });

  it('names the out-of-order character range', () => {
    expect(hintFor('foo[z-a]')).toContain('lower bound comes first');
  });

  it('names the duplicate named group', () => {
    expect(hintFor('(?<n>a)(?<n>b)')).toContain('duplicate');
  });

  it('names the out-of-order quantifier bounds', () => {
    expect(hintFor('a{2,1}')).toContain('minimum comes first');
  });

  it('names the trailing backslash', () => {
    expect(hintFor('foo\\')).toContain('trailing "\\"');
  });

  it('names catastrophic backtracking for a pattern refused by the ReDoS guard', () => {
    expect(regexRejectHint('(a+)+$', { ok: false, reason: 'redos' })).toContain('nested quantifiers');
  });
});
