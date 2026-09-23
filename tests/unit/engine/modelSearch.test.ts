import { describe, expect, it } from 'vitest';
import {
  compileSearchRegex,
  regexRejectHint,
  scanBodyMatches,
  searchBodyScripts,
  searchCatalog,
  searchColumns,
  type SearchableNode,
} from '../../../src/utils/modelSearch';
import type { ColumnDef } from '../../../src/engine/types';

/**
 * Whether this runner's V8 implements ES2025 regexp modifier groups (`(?i:…)`, `(?-i:…)`).
 *
 * @remarks
 * Measured, never assumed: Node gained them mid-life, and the VS Code extension host runs its own
 * Node, so a test that hard-codes one answer pins the runner instead of the code under test.
 */
const MODIFIER_GROUPS_SUPPORTED = (() => {
  try {
    new RegExp('(?i:a)');
    return true;
  } catch {
    return false;
  }
})();

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

  it('strips a redundant "(?m)" or "(?im)" too, and still rejects a flag group beyond the grep flags', () => {
    const multiline = compileSearchRegex('(?m)foo');
    expect(multiline.ok && multiline.regex.source).toBe('foo');
    const mixed = compileSearchRegex('(?im)foo');
    expect(mixed.ok && mixed.regex.flags).toBe('im');

    const dotAll = compileSearchRegex('(?s)foo');
    expect(dotAll.ok).toBe(false);
    expect(dotAll.ok === false && dotAll.reason).toBe('syntax');
  });

  it('leaves the scoped "(?i:...)" form untouched — it is a different construct, not a no-op prefix', () => {
    const normalizations: string[] = [];
    const scoped = compileSearchRegex('(?i:foo)', msg => normalizations.push(msg));
    expect(normalizations, 'the scoped form is not a redundant prefix — there is nothing to strip').toEqual([]);

    if (MODIFIER_GROUPS_SUPPORTED) {
      expect(scoped.ok, 'this engine supports modifier groups, so the untouched pattern compiles').toBe(true);
      expect(scoped.ok && scoped.regex.source, 'the pattern reaches the engine byte-for-byte').toBe('(?i:foo)');
    } else {
      expect(scoped.ok, 'this engine has no modifier groups, so the untouched pattern is refused').toBe(false);
      expect(scoped.ok === false && scoped.reason).toBe('syntax');
    }
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
    const compiled = compileSearchRegex('OrderID');
    if (!compiled.ok) throw new Error('OrderID must compile');
    const hits = searchBodyScripts(nodes, compiled.regex, new Set(['procedure'] as const));
    expect(hits.map(h => h.line), 'line 3 once, line 5 twice').toEqual([3, 5, 5]);
    expect(hits[0].text).toBe('SELECT o.OrderID, SUM(d.Quantity) AS TotalQuantity');
    expect(hits[2].text).toBe('JOIN Sales.OrderDetail d ON o.OrderID = d.OrderID');
  });

  it('scans once: full rows while the count is admitted, only counts once it is not', () => {
    const compiled = compileSearchRegex('OrderID|Customer');
    if (!compiled.ok) throw new Error('the pattern must compile');
    const all = scanBodyMatches(nodes, compiled.regex, undefined, () => true);
    expect(all.matches, 'an admitted count builds exactly what searchBodyScripts builds')
      .toEqual(searchBodyScripts(nodes, compiled.regex));
    expect([all.total, all.objects], '3 OrderID hits in the procedure, 3 Customer hits in the view').toEqual([6, 2]);

    const capped = scanBodyMatches(nodes, compiled.regex, undefined, count => count <= 2);
    expect([capped.total, capped.objects], 'counts cover every match past the ceiling').toEqual([6, 2]);
    expect(capped.matches, 'no row is built past the ceiling').toHaveLength(2);
  });

  it('anchors ^ and $ per line like grep, and . never crosses a line break', () => {
    const count = (pattern: string): number => {
      const compiled = compileSearchRegex(pattern);
      if (!compiled.ok) throw new Error(`${pattern} must compile`);
      return searchBodyScripts(nodes, compiled.regex, new Set(['procedure'] as const)).length;
    };
    expect(count('^CREATE'), '^ matches the first line start').toBe(1);
    expect(count('^SELECT'), '^ matches a line start inside the body').toBe(1);
    expect(count('d.OrderID$'), '$ matches a line end').toBe(1);
    expect(count('AS.SELECT'), '. never crosses a line break').toBe(0);
    const inline = compileSearchRegex('(?im)^select');
    expect(inline.ok && inline.regex.source, 'a redundant (?im) group is stripped, not rejected').toBe('^select');
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

/**
 * A match inside a SQL comment is marked.
 *
 * The reported context is a 3-line window, so a match deep inside a block comment arrived
 * indistinguishable from live code: three answers described commented-out SQL as running behaviour.
 * The marker is additive — `commented` is set only when true, and never filters a hit, because two
 * of that same answer's correct facts came from inside a comment.
 */
describe('model search — commented matches', () => {
  /** Runs `pattern` over one body and returns `[line, commented]` for every hit, in order. */
  function hits(bodyScript: string, pattern: string): [number, boolean][] {
    const compiled = compileSearchRegex(pattern);
    if (!compiled.ok) throw new Error(`${pattern} must compile`);
    const body: SearchableNode[] = [{
      id: 'dbo.p', name: 'p', schema: 'dbo', type: 'procedure', bodyScript,
    }];
    return searchBodyScripts(body, compiled.regex).map(h => [h.line, h.commented === true]);
  }

  it('marks a hit inside a block comment and leaves a live hit unmarked', () => {
    const hit = hits([
      'SELECT SUM(RawAmount) FROM #RawBatch',   // 1 — live
      '/* RECONCILIATION QUERY',                // 2
      '   deferred, kept for reference',        // 3
      '   more prose',                          // 4
      '   and more prose',                      // 5
      '   still more prose',                    // 6
      '   SELECT SUM(RawAmount) FROM ai.Raw',   // 7 — 5 lines below the opener
      '*/',                                     // 8
    ].join('\n'), 'SUM\\(RawAmount\\)');
    expect(hit, 'the live hit is unmarked, the one inside the block is marked')
      .toEqual([[1, false], [7, true]]);
  });

  it('marks a hit the 3-line context window cannot explain', () => {
    // The window is [hit-1, hit, hit+1]; the opener sits outside it, which is the whole defect.
    const compiled = compileSearchRegex('DELETE');
    if (!compiled.ok) throw new Error('DELETE must compile');
    const lines = ['/* OLD DEDUP APPROACH (pre v2.0)', 'a', 'b', 'c', 'd', 'e', 'DELETE d1', 'f', '*/'];
    const [match] = searchBodyScripts(
      [{ id: 'dbo.p', name: 'p', schema: 'dbo', type: 'procedure', bodyScript: lines.join('\n') }],
      compiled.regex,
    );
    expect(match.snippet, 'no delimiter is visible in the reported context').not.toContain('/*');
    expect(match.commented, 'and the marker says so anyway').toBe(true);
  });

  it('tracks nested block comments and clears the marker after the outer close', () => {
    expect(hits([
      'SELECT 1 AS Target',            // 1 — live, before
      '/* outer',                      // 2
      '  /* inner Target */',          // 3 — inner close does not end the outer block
      '  Target inside outer',         // 4
      '*/',                            // 5
      'SELECT 2 AS Target',            // 6 — live again
    ].join('\n'), 'Target'))
      .toEqual([[1, false], [3, true], [4, true], [6, false]]);
  });

  it('marks a line comment to end of line only, leaving live code on that line unmarked', () => {
    expect(hits([
      'SELECT Target FROM t -- Target was renamed',  // 1 — live match, then commented match
      '-- Target',                                   // 2
      'SELECT Target',                               // 3 — the line comment does not carry over
    ].join('\n'), 'Target'))
      .toEqual([[1, false], [1, true], [2, true], [3, false]]);
  });

  it('is not fooled by a comment delimiter inside a string literal or a bracketed identifier', () => {
    expect(hits([
      "SELECT 'no /* Target here' AS a",   // 1 — the literal opens no block
      'SELECT Target FROM t',              // 2 — so this is live
      "SELECT '-- Target' AS b",           // 3 — nor does the literal start a line comment
      'SELECT Target FROM u',              // 4
      'SELECT [Target -- col] FROM v',     // 5 — a bracketed identifier hides "--" too
      'SELECT Target FROM w',              // 6
    ].join('\n'), 'Target'))
      .toEqual([[1, false], [2, false], [3, false], [4, false], [5, false], [6, false]]);
  });

  it("closes a literal on a doubled '' escape without swallowing the rest of the body", () => {
    expect(hits([
      "SELECT 'it''s fine' AS a",   // 1 — '' is a close and a reopen, net state unchanged
      '/* Target */',               // 2 — so this block is still seen
      'SELECT Target',              // 3
    ].join('\n'), 'Target'))
      .toEqual([[2, true], [3, false]]);
  });

  it('reads a double-quoted identifier the way the parser does', () => {
    expect(hits([
      'SELECT "odd /* name" AS a',   // 1 — the quoted identifier opens no block
      'SELECT Target FROM t',        // 2 — so this is live
      'SELECT "x -- y", Target',     // 3 — nor does it start a line comment
    ].join('\n'), 'Target'))
      .toEqual([[2, false], [3, false]]);
  });

  it('leaves a live match byte-identical to the shape before the marker existed', () => {
    const compiled = compileSearchRegex('Target');
    if (!compiled.ok) throw new Error('Target must compile');
    const [live] = searchBodyScripts(
      [{ id: 'dbo.p', name: 'p', schema: 'dbo', type: 'procedure', bodyScript: 'SELECT Target' }],
      compiled.regex,
    );
    expect(Object.keys(live), 'no key is added to a live hit').toEqual(['node', 'line', 'text', 'snippet']);
    expect('commented' in live, 'the field is omitted, not false').toBe(false);
  });
});

/**
 * The innermost `IF`/`WHILE` predicate governing a hit is reported (IB3-T3-PREDICATE, D-049).
 *
 * The reported context is a 3-line window, so a hit's controlling condition sits outside it
 * whenever it is more than a line or two away — the normal case in T-SQL. The marker is additive,
 * the same shape as `commented`: present only when a governing condition exists.
 */
describe('model search — enclosing predicate', () => {
  /** Runs `pattern` over one body and returns `[line, enclosingPredicate]` for every hit, in order. */
  function hits(bodyScript: string, pattern: string): [number, string | undefined][] {
    const compiled = compileSearchRegex(pattern);
    if (!compiled.ok) throw new Error(`${pattern} must compile`);
    const body: SearchableNode[] = [{
      id: 'dbo.p', name: 'p', schema: 'dbo', type: 'procedure', bodyScript,
    }];
    return searchBodyScripts(body, compiled.regex).map(h => [h.line, h.enclosingPredicate]);
  }

  it('reports the IF predicate for a hit several lines inside its BEGIN…END block', () => {
    const hit = hits([
      'CREATE PROCEDURE dbo.p',                    // 1
      'AS',                                        // 2
      'BEGIN',                                     // 3
      '    IF @ForceReimport = 0',                 // 4
      '    BEGIN',                                 // 5
      '        -- dedup pass',                     // 6
      '        DELETE rb FROM #RawBatch rb',       // 7
      '        INNER JOIN Target t',                // 8
      '            ON t.OrderDate = rb.OrderDate',  // 9 — 5 lines below the opener
      '    END',                                   // 10
      'END',                                       // 11
    ].join('\n'), 'ON t\\.OrderDate');
    expect(hit).toEqual([[9, 'IF @ForceReimport = 0']]);
  });

  it('does not open a frame for BEGIN TRAN, so the IF block closes on its own END', () => {
    const hit = hits([
      'BEGIN',                                     // 1
      '    IF @Apply = 1',                         // 2
      '    BEGIN',                                 // 3
      '        BEGIN TRANSACTION',                 // 4
      '        UPDATE Target SET x = 1',           // 5
      '        COMMIT',                            // 6
      '    END',                                   // 7
      '    DELETE FROM Target',                    // 8 — after the IF block
      'END',                                       // 9
    ].join('\n'), 'Target');
    expect(hit).toEqual([[5, 'IF @Apply = 1'], [8, undefined]]);
  });

  it('reports the innermost predicate when IF blocks nest', () => {
    const hit = hits([
      'BEGIN',                                     // 1
      '    IF @Outer = 1',                         // 2
      '    BEGIN',                                 // 3
      '        IF @Inner = 1',                     // 4
      '        BEGIN',                             // 5
      '            SELECT Target',                 // 6
      '        END',                               // 7
      '    END',                                   // 8
      'END',                                       // 9
    ].join('\n'), 'Target');
    expect(hit).toEqual([[6, 'IF @Inner = 1']]);
  });

  it('reports nothing for a hit outside any IF/WHILE block', () => {
    const hit = hits([
      'CREATE PROCEDURE dbo.p',    // 1
      'AS',                        // 2
      'BEGIN',                     // 3
      '    SELECT Target',         // 4
      'END',                       // 5
    ].join('\n'), 'Target');
    expect(hit).toEqual([[4, undefined]]);
  });

  it('leaves a hit before the governing IF unmarked — the exact D-049 shape', () => {
    // The verification SELECT is ungated; the IF that follows it gates only the warning after it.
    // A hit on the SELECT must not inherit the later IF's predicate.
    const hit = hits([
      'BEGIN',                                          // 1
      '    SELECT @VerifyCount = COUNT(*)',              // 2
      '    FROM Target',                                 // 3
      '    IF @VerifyCount <> @ProcessedRows AND @DryRun = 0', // 4
      '    BEGIN',                                       // 5
      '        PRINT ' + "'mismatch'",                   // 6
      '    END',                                         // 7
      'END',                                              // 8
    ].join('\n'), 'FROM Target');
    expect(hit).toEqual([[3, undefined]]);
  });

  it('governs exactly the next live line for an IF written without BEGIN…END', () => {
    const hit = hits([
      'BEGIN',                    // 1
      '    IF @Flag = 1',         // 2
      '        SELECT Target',    // 3 — single statement, no BEGIN
      '    SELECT Target',        // 4 — back outside the IF
      'END',                      // 5
    ].join('\n'), 'Target');
    expect(hit).toEqual([[3, 'IF @Flag = 1'], [4, undefined]]);
  });

  it('reports WHILE the same as IF', () => {
    const hit = hits([
      'BEGIN',                       // 1
      '    WHILE @i < 10',           // 2
      '    BEGIN',                   // 3
      '        SELECT Target',       // 4
      '    END',                     // 5
      'END',                         // 6
    ].join('\n'), 'Target');
    expect(hit).toEqual([[4, 'WHILE @i < 10']]);
  });

  it('does not mistake a CASE…END expression for closing an outer BEGIN', () => {
    const hit = hits([
      'BEGIN',                                           // 1
      '    IF @Flag = 1',                                 // 2
      '    BEGIN',                                        // 3
      "        SELECT CASE WHEN x = 1 THEN 'a' ELSE 'b' END AS Col", // 4 — CASE...END on one line
      '        SELECT Target',                            // 5 — still inside the IF block
      '    END',                                          // 6
      'END',                                               // 7
    ].join('\n'), 'Target');
    expect(hit).toEqual([[5, 'IF @Flag = 1']]);
  });

  it('leaves a hit with no governing block byte-identical to the shape before the field existed', () => {
    const compiled = compileSearchRegex('Target');
    if (!compiled.ok) throw new Error('Target must compile');
    const [live] = searchBodyScripts(
      [{ id: 'dbo.p', name: 'p', schema: 'dbo', type: 'procedure', bodyScript: 'SELECT Target' }],
      compiled.regex,
    );
    expect('enclosingPredicate' in live, 'the field is omitted, not undefined-but-present').toBe(false);
  });
});

describe('compileSearchRegex — ReDoS guard', () => {
  it('refuses exponential patterns without hanging on its own probe', () => {
    // A single 200-character probe never returns for these; the guard must stop at a short input.
    for (const pattern of ['(a+)+x', '(\\d+)+x', '(\\s+)+x']) {
      const start = performance.now();
      const compiled = compileSearchRegex(pattern);
      expect(compiled.ok, `${pattern} is refused`).toBe(false);
      if (!compiled.ok) expect(compiled.reason).toBe('redos');
      expect(performance.now() - start, `${pattern} is refused promptly`).toBeLessThan(2_000);
    }
  });

  it('accepts ordinary search patterns', () => {
    for (const pattern of ['total.*quantity', 'ON t\\.OrderDate', '\\bINSERT\\s+INTO\\b', '\\d{4}-\\d{2}']) {
      expect(compileSearchRegex(pattern).ok, pattern).toBe(true);
    }
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
    // A redundant "(?i)"/"(?m)" no longer reaches this hint — compileSearchRegex strips it and
    // compiles the remainder (covered in the 'model search' describe above). "(?s)" requests
    // semantics the engine does not otherwise apply, so it still fails to compile and needs this hint.
    const hint = hintFor('(?s)order');
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
