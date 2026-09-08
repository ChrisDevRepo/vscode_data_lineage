/**
 * Unit tests for the discovery search tools' grep contract (P1-92.b).
 *
 * `lineage_search_ddl` and `lineage_search_objects` follow the shape models are trained on: a
 * regex in, every match out with its location and line text, an empty result stated as a plain
 * fact, an unusable pattern named as an error, and no truncation anywhere. What is guarded here:
 *
 * - a hit carries the object, a 1-based line number, the matched line and its context;
 * - `(?i)` reaches the tool boundary and is a no-op, not a rejection;
 * - the empty result is `total: 0` plus what was searched — with NO repair advice, which is what
 *   drove the T3 retry loop ("try a shorter substring" on a regex tool) — and is structurally
 *   distinct from `{ error: 'invalid_regex' }`;
 * - `^`, `$` and `.` keep their whole-body (non-multiline) meaning, as the tool sentence states;
 * - a pattern whose first match is empty still reports the real match later in the same body;
 * - `search_objects` in regex mode takes the pattern verbatim (no dotted-name splitting) and
 *   names an invalid pattern instead of answering with an empty list;
 * - `search_objects` serves `by_type` for the same rows `total` counts, and the two quote
 *   characters are named as a query rather than answered with `total: 0` (IB3-T2: 19/8/5 served
 *   per row was delivered as "17 tables … 7 views", and "send an empty query" cost a hop);
 * - an over-budget result hands off with the existing `over_discovery_budget` fact and omits the
 *   list entirely, never a partial one;
 * - a hit inside a SQL comment carries `commented: true` while a live hit's row is unchanged
 *   (M0-T3: the 3-line context window dropped the enclosing block, and dead SQL read as behaviour);
 * - a hit governed by a conditional block carries `enclosing_predicate`, and one that is not
 *   carries nothing — right or absent, never the condition that happens to be nearby (IB3-T3: an
 *   ungated row-count verification was delivered as gated by the single `@ForceReimport` token the
 *   payload contained, which gates a dedup a hundred and fifty lines earlier);
 * - `by_object` states every matching object once with its `hits` total and, where anything is
 *   dead, its `commented_hits` and line ranges, and no hit is lost to the grouping (M0-T3: a
 *   per-row flag does not survive an answer composed by theme, and a per-object count tallied by
 *   hand from 33 rows was delivered as 17/16 against 22/11);
 * - `package.json` `languageModelTools` is what the generator produces from `TOOL_DEFS`.
 *
 * The caps travel with the call as one immutable per-turn budget, so a case that needs a tight
 * budget builds its own and no other case observes it.
 */

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { searchDdl, searchObjects } from '../../../src/ai/tools/tools';
import {
  createTurnTokenBudget,
  DEFAULT_TURN_TOKEN_BUDGET as BUDGET,
} from '../../../src/ai/support/tokenBudget';
import { rootPath } from '../helpers/testUtils';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';

const VIEW_BODY = [
  'CREATE VIEW ai.vwSales AS',
  'SELECT o.OrderId, o.CustomerKey',
  'FROM ai.ArchiveOrders o',
  'WHERE o.OrderId > 0',
].join('\n');

function node(partial: Partial<LineageNode> & { id: string; name: string; type: LineageNode['type'] }): LineageNode {
  return {
    schema: 'ai',
    fullName: `[ai].[${partial.name}]`,
    columns: [],
    ...partial,
  } as LineageNode;
}

function makeModel(extra: LineageNode[] = []): DatabaseModel {
  const nodes: LineageNode[] = [
    node({ id: '[ai].[vwsales]', name: 'vwSales', type: 'view', bodyScript: VIEW_BODY }),
    node({ id: '[sales].[orderheader]', name: 'OrderHeader', type: 'table', schema: 'sales' }),
    ...extra,
  ];
  return {
    nodes,
    edges: [],
    schemas: [{ name: 'ai', nodeCount: nodes.length, types: { table: 1, view: 1, procedure: 0, function: 0, external: 0 } }],
    catalog: {},
    neighborIndex: Object.fromEntries(nodes.map(n => [n.id, { in: [], out: [] }])),
    dbPlatform: 'SQL Server',
  };
}

type DdlRow = {
  id: string; name: string; type: string; line: number; text: string; context: string;
  commented?: true; enclosing_predicate?: string;
};
type DdlResult = {
  results?: DdlRow[]; total?: number; objects?: number; hint?: string; error?: string;
  searched?: { bodies: number; types: string[] }; reason?: string; results_omitted?: boolean;
  by_object?: { id: string; name: string; type: string; hits: number; commented_hits?: number; commented_lines?: string }[];
};

describe('search tools — grep contract', () => {
  const model = makeModel();

  it('reports a hit with its object, 1-based line number, matched line and context', () => {
    const res = searchDdl(model, 'Archive.*Orders', BUDGET) as DdlResult;
    expect(res.total, 'one match for one occurrence').toBe(1);
    expect(res.objects, 'one distinct object').toBe(1);
    const [hit] = res.results ?? [];
    expect(hit.id).toBe('[ai].[vwsales]');
    expect(hit.name).toBe('vwSales');
    expect(hit.type).toBe('view');
    expect(hit.line, 'ArchiveOrders is on the third line, counted from 1').toBe(3);
    expect(hit.text).toBe('FROM ai.ArchiveOrders o');
    expect(hit.context, 'context carries the surrounding lines').toContain('SELECT o.OrderId');
  });

  it('returns every match in a body, not one per object', () => {
    const res = searchDdl(model, 'OrderId', BUDGET) as DdlResult;
    expect(res.total, 'OrderId occurs on line 2 and line 4').toBe(2);
    expect(res.objects, 'both are in the same view, reported once each').toBe(1);
    expect((res.results ?? []).map(r => r.line)).toEqual([2, 4]);
    // Two occurrences on one line are two matches, as grep -o reports them.
    const sameLine = searchDdl(model, 'o\\.', BUDGET) as DdlResult;
    expect((sameLine.results ?? []).filter(r => r.line === 2)).toHaveLength(2);
  });

  it('accepts a redundant "(?i)" group end-to-end and matches case-insensitively', () => {
    const inline = searchDdl(model, '(?i)archiveorders', BUDGET) as DdlResult;
    const plain = searchDdl(model, 'ARCHIVEORDERS', BUDGET) as DdlResult;
    expect(inline.error, '(?i) is stripped, not rejected').toBeUndefined();
    expect(inline.total).toBe(1);
    expect(plain.total, 'matching is case-insensitive with or without the group').toBe(1);
  });

  it('states an empty result as a fact with no repair advice, distinct from an invalid pattern', () => {
    const empty = searchDdl(model, 'no_such_token', BUDGET) as DdlResult;
    expect(empty).toEqual({ results: [], total: 0, objects: 0, searched: { bodies: 1, types: ['view', 'procedure', 'function'] } });
    expect('hint' in empty, 'no substring advice on a regex tool — it drove the T3 retry loop').toBe(false);
    expect('error' in empty, 'zero matches is not an error').toBe(false);

    const invalid = searchDdl(model, 'foo(', BUDGET) as DdlResult;
    expect(invalid.error, 'an unusable pattern is an error, not an empty result').toBe('invalid_regex');
    expect(invalid.hint).toContain('closing ")"');
    expect('results' in invalid, 'a rejection carries no result list').toBe(false);
  });

  it('anchors work per line like grep, and "." never crosses a line break', () => {
    expect((searchDdl(model, '^CREATE', BUDGET) as DdlResult).total, '^ matches the first line').toBe(1);
    expect((searchDdl(model, '^SELECT', BUDGET) as DdlResult).total, '^ matches a line start inside the body').toBe(1);
    expect((searchDdl(model, 'OrderId > 0$', BUDGET) as DdlResult).total, '$ matches a line end').toBe(1);
    expect((searchDdl(model, 'ai.vwSales AS.SELECT', BUDGET) as DdlResult).total, '. never crosses a line break').toBe(0);
  });

  it('a pattern whose first match is empty still reports the real match later in the body', () => {
    // `x*` matches the empty string at offset 0. Skipping the node on an empty first match hid
    // every later match in that body; the scan advances one position and keeps going instead.
    const withX = makeModel([
      node({ id: '[ai].[vwx]', name: 'vwX', type: 'view', bodyScript: 'SELECT xId\nFROM ai.ArchiveOrders' }),
    ]);
    const res = searchDdl(withX, 'x*', BUDGET) as DdlResult;
    const onVwX = (res.results ?? []).filter(r => r.id === '[ai].[vwx]');
    expect(onVwX.length, 'the node is scanned, not skipped').toBeGreaterThan(0);
    expect(onVwX.some(r => r.text.includes('xId')), 'the real match is reported').toBe(true);
  });

  it('marks a hit inside a comment and leaves a live hit\'s row byte-identical', () => {
    const commented = makeModel([node({
      id: '[ai].[vwdelta]', name: 'vwDelta', type: 'view',
      bodyScript: [
        'CREATE VIEW ai.vwDelta AS',
        'SELECT w.Id FROM ai.Watermark w',
        '/* DELTA MODE, deferred to v5.0',
        '   a',
        '   b',
        '   SELECT * FROM ai.Watermark',
        '*/',
      ].join('\n'),
    })]);
    const rows = (searchDdl(commented, 'ai\\.Watermark', BUDGET) as DdlResult).results ?? [];
    expect(rows.map(r => [r.line, r.commented]), 'the live hit is unflagged, the dead one is flagged')
      .toEqual([[2, undefined], [6, true]]);

    // The wire shape: a live row carries the fields it carried before the flag existed, in the
    // same order and with no key added; the flag is appended only where it is true.
    expect(Object.keys(rows[0])).toEqual(['id', 'name', 'type', 'line', 'text', 'context']);
    expect(rows[0].text, 'the matched line is served as written').toBe('SELECT w.Id FROM ai.Watermark w');
    // Marking is per line, not per row: the window straddles the opener, so the live statement is
    // bare and the dead line beside it is not — which is the distinction the window has to carry.
    expect(rows[0].context.split('\n').map(l => l.startsWith('--'))).toEqual([false, false, true]);
    expect(JSON.stringify(rows[1]).endsWith(',"commented":true}'), 'appended, never in place of a field')
      .toBe(true);
    expect(JSON.stringify(rows[1]).length - JSON.stringify({ ...rows[1], commented: undefined }).length)
      .toBe(',"commented":true'.length);
  });

  it('states every object once with its hit count and its commented lines, losing no hit', () => {
    const grouped = makeModel([
      node({
        id: '[ai].[spimport]', name: 'spImport', type: 'procedure',
        bodyScript: [
          'CREATE PROCEDURE ai.spImport AS',   // 1
          'SELECT x FROM ai.Watermark w',      // 2  live
          '/* reconciliation, never enabled',  // 3
          '  SELECT a FROM ai.Watermark',      // 4  commented
          '  SELECT b FROM ai.Watermark',      // 5  commented
          '*/',                                // 6
          'SELECT 1',                          // 7
          '-- legacy: ai.Watermark snapshot',  // 8  commented
        ].join('\n'),
      }),
      node({
        id: '[ai].[vwlive]', name: 'vwLive', type: 'view',
        bodyScript: 'CREATE VIEW ai.vwLive AS\nSELECT * FROM ai.Watermark',
      }),
    ]);
    const res = searchDdl(grouped, 'ai\\.Watermark', BUDGET) as DdlResult;
    const rows = res.results ?? [];

    // No fact lost: every hit is still its own row, with its own line, text and comment truth.
    expect(rows.map(r => [r.id, r.line, r.commented ?? false]), 'five hits, unchanged and unmerged')
      .toEqual([
        ['[ai].[spimport]', 2, false],
        ['[ai].[spimport]', 4, true],
        ['[ai].[spimport]', 5, true],
        ['[ai].[spimport]', 8, true],
        ['[ai].[vwlive]', 2, false],
      ]);
    expect(rows.every(r => r.text.includes('ai.Watermark')), 'each row keeps its own matched line').toBe(true);
    expect(res.total).toBe(5);
    expect(res.objects).toBe(2);

    // One group per object, every object, in first-hit order — the per-object count is served, so
    // no answer has to tally it from the rows (M0-T3: 17/16 delivered against an actual 22/11).
    const groups = res.by_object ?? [];
    expect(groups.map(g => [g.id, g.hits]), 'every matching object, counted, no repeat')
      .toEqual([['[ai].[spimport]', 4], ['[ai].[vwlive]', 1]]);
    expect(groups.reduce((n, g) => n + g.hits, 0), 'the parts sum to the served total').toBe(res.total);
    expect(res.objects, 'the scalar is the group list\'s length, so the two cannot disagree').toBe(groups.length);
    expect(groups[0].name).toBe('spImport');
    expect(groups[0].type).toBe('procedure');
    expect(groups[0].commented_hits, 'the dead subset is counted apart from the total').toBe(3);

    // The span is stated once and covers exactly the commented hit lines — expanding the ranges
    // round-trips to the set of flagged rows, so grouping neither drops nor invents a line.
    const expanded = (groups[0].commented_lines ?? '').split(',').flatMap(part => {
      const [from, to] = part.trim().split('-').map(Number);
      return Array.from({ length: (to ?? from) - from + 1 }, (_, i) => from + i);
    });
    expect(expanded, 'consecutive lines join, a gap does not')
      .toEqual(rows.filter(r => r.id === '[ai].[spimport]' && r.commented).map(r => r.line));
    expect(groups[0].commented_lines, 'one statement, not one per line').toBe('4-5, 8');

    // Nothing commented → the object is still counted, and says nothing about deadness.
    expect(groups[1].name).toBe('vwLive');
    expect('commented_hits' in groups[1], 'stated only where there is something to state').toBe(false);
    expect('commented_lines' in groups[1], 'stated only where there is something to state').toBe(false);
  });

  it('an over-budget result hands off with the over_discovery_budget fact and omits the list', () => {
    const wide = makeModel(
      Array.from({ length: 200 }, (_, i) => node({
        id: `[ai].[vwbulk${i}]`,
        name: `vwBulk${i}`,
        type: 'view',
        bodyScript: `CREATE VIEW ai.vwBulk${i} AS\nSELECT * FROM ai.ArchiveOrders\nWHERE 1 = 1`,
      })),
    );
    const tight = createTurnTokenBudget({ discoveryTokenBudget: 1000 });
    const res = searchDdl(wide, 'ArchiveOrders', tight) as DdlResult;
    expect(res.reason, 'reuses the existing discovery over-budget fact').toBe('over_discovery_budget');
    expect(res.results_omitted).toBe(true);
    expect('results' in res, 'never a partial list').toBe(false);
    expect(res.total, 'the count still answers "how much is there"').toBe(201);
    expect(res.hint).toContain('Narrow the pattern');

    // The list and the per-object counts are one payload and are measured together, so the
    // headroom the contract needs is stated here rather than left to the default budget landing
    // just above the same corpus.
    const roomy = createTurnTokenBudget({ discoveryTokenBudget: 20_000 });
    const inline = searchDdl(wide, 'ArchiveOrders', roomy) as DdlResult;
    expect(inline.results?.length, 'under budget the full list is inlined').toBe(201);
    expect(inline.by_object?.length, 'and every object is counted beside it').toBe(201);
  });

  it('search_objects regex mode takes the pattern verbatim and names an invalid one', () => {
    const dotted = searchObjects(model, 'sales\\..*order', undefined, undefined, 'regex') as {
      results?: { id?: string }[]; total?: number; error?: string; hint?: string;
    };
    expect(dotted.error, 'a dotted pattern is not split into query + schemaHint').toBeUndefined();
    expect(dotted.total, 'sales.OrderHeader matches on schema.name').toBe(1);

    const invalid = searchObjects(model, 'foo(', undefined, undefined, 'regex') as { error?: string; hint?: string };
    expect(invalid.error, 'an unusable pattern is named, never answered with []').toBe('invalid_regex');
    expect(invalid.hint).toContain('closing ")"');
  });

  it('search_objects serves the type breakdown of the list it counts', () => {
    // IB3-T2: a 32-row payload carrying 19 table / 8 procedure / 5 view per row, with only `total`
    // aggregated, was delivered as "17 tables … 7 views" — the rows were tallied by hand. The
    // breakdown is measured on the same pass as the rows, so it cannot disagree with `total`.
    const wide = makeModel([
      node({ id: '[ai].[spload]', name: 'spLoad', type: 'procedure', bodyScript: 'CREATE PROC ai.spLoad AS SELECT 1' }),
      node({ id: '[ai].[spclean]', name: 'spClean', type: 'procedure', bodyScript: 'CREATE PROC ai.spClean AS SELECT 1' }),
      node({ id: '[ai].[stage]', name: 'Stage', type: 'table' }),
    ]);
    const res = searchObjects(wide, '.', undefined, ['ai'], 'regex') as {
      total?: number; by_type?: Record<string, number>;
    };
    expect(res.by_type, 'largest kind first, so a heading order reads off the payload')
      .toEqual({ procedure: 2, table: 1, view: 1 });
    const summed = Object.values(res.by_type ?? {}).reduce((a, b) => a + b, 0);
    expect(summed, 'the breakdown sums to the served total').toBe(res.total);
    expect(JSON.stringify(res), 'served next to the total it breaks down, in count order')
      .toContain('"total":4,"by_type":{"procedure":2,"table":1,"view":1},"filter_context"');
  });

  it('names the two quote characters as a query, and shows the arguments that list a schema', () => {
    // IB3-T2, one wasted hop: "send an empty query" was answered with the literal `""`, which
    // cleared the length check, matched nothing and returned `total: 0` with no diagnosis.
    const quoted = searchObjects(model, '""', undefined, ['ai']) as { error?: string; hint?: string; total?: number };
    expect(quoted.error, 'punctuation-only is named, never answered with a list of nothing').toBe('query_not_a_name');
    expect(quoted.total, 'and the empty list is not what the caller gets').toBeUndefined();

    const short = searchObjects(model, 'a') as { error?: string; hint?: string };
    expect(short.error).toBe('query_too_short');
    for (const hint of [quoted.hint ?? '', short.hint ?? '']) {
      expect(hint, 'the repair shows the arguments object rather than describing it')
        .toContain('{"query": "", "schemas": ["<schema>"]}');
      expect(hint, 'and says which reading of it is wrong').toContain('not the two quote characters');
    }

    // The value the hint names still works.
    const listed = searchObjects(model, '', undefined, ['ai']) as { total?: number; by_type?: Record<string, number> };
    expect(listed.total, 'the ai schema holds the view').toBe(1);
    expect(listed.by_type).toEqual({ view: 1 });
  });

  it('never suggests regex mode to a caller already in regex mode', () => {
    const res = searchObjects(model, 'zzz_no_such_object', undefined, undefined, 'regex') as { ai_hint?: string };
    expect(res.ai_hint).not.toContain('try regex mode');
    const substring = searchObjects(model, 'zzz_no_such_object') as { ai_hint?: string };
    expect(substring.ai_hint, 'substring mode still gets the mode suggestion').toContain('try regex mode');
  });

  it('attaches the condition that governs a hit, and nothing to a hit that is not governed', () => {
    // IB3-T3. The two statements below are the shape that produced the defect: a dedup gated by
    // one variable, and an ungated verification reading the same table a few statements later.
    // Inside a three-line window they arrive identical, so the only condition token in the payload
    // was welded onto the statement it does not govern. The invariant is per hit: whatever is
    // served must be the condition over that line, and a line no block governs is served bare.
    const body = [
      'BEGIN',                                              // 1
      '    IF @ForceReimport = 0',                          // 2
      '    BEGIN',                                          // 3
      '        DELETE rb FROM #RawBatch rb',                // 4
      '        JOIN [ai].[RawOrderImport] roi ON 1 = 1;',   // 5
      '    END;',                                           // 6
      '',                                                   // 7
      '    SELECT @VerifyCount = COUNT(*)',                 // 8
      '    FROM [ai].[RawOrderImport]',                     // 9
      '    WHERE BatchID = @BatchID;',                      // 10
      '',                                                   // 11
      '    IF @VerifyCount <> @ProcessedRows AND @DryRun = 0', // 12
      '    BEGIN',                                          // 13
      '        SET @Warnings = @Warnings + 1;',             // 14
      '    END;',                                           // 15
      'END;',                                               // 16
    ].join('\n');
    const proc = makeModel([node({ id: '[ai].[spimport]', name: 'spImport', type: 'procedure', bodyScript: body })]);
    const rows = ((searchDdl(proc, 'RawOrderImport|@Warnings', BUDGET) as DdlResult).results ?? []);
    const at = (line: number): DdlRow => rows.find(r => r.line === line)!;

    expect(at(9).enclosing_predicate, 'the verification reads the table unconditionally').toBeUndefined();
    expect(at(5).enclosing_predicate, 'the dedup is the statement the flag gates').toContain('@ForceReimport');
    expect(at(14).enclosing_predicate, 'the warning is gated by its own condition, not the flag')
      .toMatch(/@VerifyCount.*@DryRun/);
    expect(at(14).enclosing_predicate).not.toContain('@ForceReimport');
    // The defect restated as a payload property: the flag is no longer the only condition on the
    // wire, so it is no longer the only one an answer can reach for.
    const conditions = rows.map(r => r.enclosing_predicate).filter(Boolean);
    expect(conditions.filter(c => c!.includes('@ForceReimport')), 'one statement, not the payload')
      .toHaveLength(1);
  });

  it('reports the innermost condition, negates an ELSE branch, and carries a loop condition', () => {
    const body = [
      'BEGIN',                                    // 1
      '    WHILE @Retry <= @MaxRetries',          // 2
      '    BEGIN',                                // 3
      '        BEGIN TRY',                        // 4
      '            SELECT 1 AS InLoop;',          // 5
      '            IF @Retry > 1',                // 6
      '            BEGIN',                        // 7
      '                SELECT 2 AS InNested;',    // 8
      '            END;',                         // 9
      '        END TRY',                          // 10
      '        BEGIN CATCH',                      // 11
      '            SELECT 3 AS InCatch;',         // 12
      '        END CATCH;',                       // 13
      '    END;',                                 // 14
      '',                                         // 15
      '    IF @DryRun = 1',                       // 16
      '    BEGIN',                                // 17
      '        SELECT 4 AS InThen;',              // 18
      '    END',                                  // 19
      '    ELSE',                                 // 20
      '    BEGIN',                                // 21
      '        SELECT 5 AS InElse;',              // 22
      '    END;',                                 // 23
      '    SELECT 6 AS AfterAll;',                // 24
      'END;',                                     // 25
    ].join('\n');
    const proc = makeModel([node({ id: '[ai].[spflow]', name: 'spFlow', type: 'procedure', bodyScript: body })]);
    const rows = ((searchDdl(proc, 'SELECT [0-9]', BUDGET) as DdlResult).results ?? []);
    const at = (line: number): string | undefined => rows.find(r => r.line === line)?.enclosing_predicate;

    expect(at(5), 'a loop body is governed by the loop condition').toContain('@Retry <= @MaxRetries');
    expect(at(12), 'a CATCH inside the loop is still inside the loop').toContain('@Retry <= @MaxRetries');
    expect(at(8), 'the innermost condition wins over the loop it sits in').toContain('@Retry > 1');
    expect(at(8), 'and the outer one is not stacked onto it').not.toContain('@MaxRetries');
    expect(at(18)).toContain('@DryRun = 1');
    expect(at(22), 'the ELSE branch runs on the negation, never on the condition itself')
      .toBe('NOT (@DryRun = 1)');
    expect(at(24), 'past the block, nothing governs the line').toBeUndefined();
  });

  it('never reads a condition out of a comment, and stays silent where the block does not resolve', () => {
    const body = [
      'BEGIN',                                             // 1
      '    /* Removed Q4 2025:',                           // 2
      '       IF @Legacy = 1',                             // 3
      '       BEGIN',                                      // 4
      '           SELECT 1 AS WasChunked;',                // 5
      '       END; */',                                    // 6
      '    SELECT 2 AS Live;',                             // 7
      '',                                                  // 8
      '    IF @Trace = 1   -- only when tracing',          // 9
      '    BEGIN',                                         // 10
      '        SELECT 3 AS Traced;',                       // 11
      '    END;',                                          // 12
      '',                                                  // 13
      '    IF @Skip = 1',                                  // 14
      '        SELECT 4 AS Bare;',                         // 15
      'END;',                                              // 16
    ].join('\n');
    const proc = makeModel([node({ id: '[ai].[spcomment]', name: 'spComment', type: 'procedure', bodyScript: body })]);
    const rows = ((searchDdl(proc, 'SELECT [0-9]', BUDGET) as DdlResult).results ?? []);
    const at = (line: number): DdlRow => rows.find(r => r.line === line)!;

    expect(at(5).commented, 'the commented-out block is dead').toBe(true);
    expect(at(5).enclosing_predicate, 'a dead line is governed by nothing; the flag is the fact').toBeUndefined();
    expect(at(7).enclosing_predicate, 'and the commented BEGIN/END never became live structure').toBeUndefined();
    expect(at(11).enclosing_predicate, 'a trailing comment is not part of the condition').toBe('@Trace = 1');
    expect(at(15).enclosing_predicate, 'a single-statement IF has no block to bound, so nothing is claimed')
      .toBeUndefined();
  });

  it('reports nothing at all for a body whose blocks do not balance', () => {
    // Right or absent: an unbalanced read means the nesting is wrong somewhere earlier, so every
    // condition derived from it is suspect and none of them is served.
    const body = ['BEGIN', '    IF @A = 1', '    BEGIN', '        SELECT 1 AS Orphan;', 'END;'].join('\n');
    const proc = makeModel([node({ id: '[ai].[spbroken]', name: 'spBroken', type: 'procedure', bodyScript: body })]);
    const rows = ((searchDdl(proc, 'SELECT 1', BUDGET) as DdlResult).results ?? []);
    expect(rows, 'the hit is still reported').toHaveLength(1);
    expect(rows[0].enclosing_predicate, 'without a condition guessed from a broken read').toBeUndefined();
  });

  it('marks every dead line of the context, including the one that matched nothing', () => {
    // IB4-T3. `commented` answers for the matched line, and the window is wider than the match:
    // the abandoned self-join's own `DELETE` produced no hit, so nothing carried its status and it
    // reached the wire as bare SQL shaped exactly like the live read four lines above — the answer
    // took it for behaviour and reported the procedure as mutating a table it only reads.
    const body = [
      'BEGIN',                                          // 1
      '    SELECT @DuplicateCount = COUNT(*)',          // 2
      '    FROM [ai].[RawOrderImport] r',               // 3  — live
      '    WHERE r.BatchID IS NOT NULL;',               // 4
      '',                                               // 5
      '    /* OLD DEDUP APPROACH (pre v2.0):',          // 6
      '       Used DELETE with a self-join instead.',   // 7
      '',                                               // 8
      '       DELETE d1',                               // 9  — matches nothing itself
      '       FROM [ai].[RawOrderImport] d1',           // 10 — the hit
      '       INNER JOIN [ai].[RawOrderImport] d2',     // 11
      '           AND d1.ImportID > d2.ImportID;',      // 12
      '    */',                                         // 13
      'END;',                                           // 14
    ].join('\n');
    const proc = makeModel([node({ id: '[ai].[spclean]', name: 'spClean', type: 'procedure', bodyScript: body })]);
    const rows = ((searchDdl(proc, 'RawOrderImport', BUDGET) as DdlResult).results ?? []);
    const at = (line: number): DdlRow => rows.find(r => r.line === line)!;

    const dead = at(10).context.split('\n');
    expect(dead, 'the window is the statement, not the matched line').toHaveLength(3);
    expect(dead.every(l => l.startsWith('--')), 'and no line of it arrives unmarked').toBe(true);
    expect(dead.some(l => /DELETE/.test(l)), 'the verb the answer read as behaviour is in the window').toBe(true);
    expect(at(10).context, 'so the abandoned statement is never served as executable SQL')
      .not.toMatch(/^\s*DELETE/m);

    const live = at(3).context.split('\n');
    expect(live.some(l => l.startsWith('--')), 'the live read keeps every line it always had').toBe(false);
    expect(live.some(l => l.includes('[ai].[RawOrderImport] r')), 'byte-for-byte, marker or not').toBe(true);
  });

  it('marks a dead audit query whose own text carries quotes and a line comment', () => {
    // The second block of the same procedure: a verification SELECT kept for manual audit, with
    // string literals and `--` notes inside the block. Neither the literal nor the inner `--`
    // may end the block, or the live code after `*/` would be reported dead.
    const body = [
      'SELECT * FROM [ai].[CleanedOrders];',                              // 1 — live, before
      '/* DATA LINEAGE VERIFICATION QUERY (for manual audit)',            // 2
      '   SELECT',
      "       roi.RawQty     AS 'RawOrderImport.RawQty',",                // 4
      '   FROM [ai].[RawOrderImport] roi',                                // 5 — the hit
      '   -- Expected: RawQty should equal OrderQty',                     // 6
      '*/',                                                               // 7
      'SELECT SUM(RawQty) FROM [ai].[RawOrderImport];',                   // 8 — live, after
    ].join('\n');
    const proc = makeModel([node({ id: '[ai].[spaudit]', name: 'spAudit', type: 'procedure', bodyScript: body })]);
    const rows = ((searchDdl(proc, 'RawOrderImport', BUDGET) as DdlResult).results ?? []);
    const at = (line: number): DdlRow => rows.find(r => r.line === line)!;

    expect(at(5).commented, 'the audit query is dead').toBe(true);
    expect(at(5).context.split('\n').every(l => l.startsWith('--')), 'and reads that way line by line').toBe(true);
    expect(at(8).commented, 'the block closed, so the statement after it is live').toBeUndefined();
    // Its window reaches back over the closing `*/`: that line is dead and says so, the live
    // statement beside it does not, and the two readings sit one line apart without blurring.
    expect(at(8).context.split('\n').map(l => l.startsWith('--'))).toEqual([true, false]);
  });

  it('leaves a live line marked-free when only part of it is a comment', () => {
    // The expensive direction is marking live code: a statement struck out of the payload is
    // lineage deleted, while an unexplained one is merely unexplained. A line that still executes
    // therefore keeps its bare form no matter what trails it.
    const body = [
      'SELECT 1;',                                                        // 1
      'FROM [ai].[RawOrderImport] r  -- RawOrderImport was #Staging',     // 2 — live code, dead tail
      'WHERE r.BatchID IS NOT NULL;',                                     // 3
    ].join('\n');
    const proc = makeModel([node({ id: '[ai].[sptail]', name: 'spTail', type: 'procedure', bodyScript: body })]);
    const rows = ((searchDdl(proc, 'RawOrderImport', BUDGET) as DdlResult).results ?? []);
    expect(rows.map(r => r.commented), 'the code is live, the note after it is not').toEqual([undefined, true]);
    for (const row of rows) {
      expect(row.context.split('\n').some(l => l.startsWith('--')), 'and no line of either window is struck out')
        .toBe(false);
    }
  });

  it('is not fooled into marking live lines by a comment marker inside a literal', () => {
    const body = [
      "SELECT '/* not a comment */' AS a;",                // 1
      'SELECT b FROM [ai].[RawOrderImport];',              // 2 — live
      "SELECT '-- also not one' AS c;",                    // 3
      'SELECT d FROM [ai].[RawOrderImport];',              // 4 — live
      'SELECT [RawOrderImport -- col] FROM [ai].[X];',     // 5 — bracketed identifier, live
    ].join('\n');
    const proc = makeModel([node({ id: '[ai].[split]', name: 'spLit', type: 'procedure', bodyScript: body })]);
    const rows = ((searchDdl(proc, 'RawOrderImport', BUDGET) as DdlResult).results ?? []);
    expect(rows.map(r => r.line), 'three live hits').toEqual([2, 4, 5]);
    for (const row of rows) {
      expect(row.commented, `line ${row.line} executes`).toBeUndefined();
      expect(row.context.split('\n').some(l => l.startsWith('--')), `no line around ${row.line} is struck out`)
        .toBe(false);
    }
  });

  it('marks the remainder after a block comment nobody closed, and nothing before it', () => {
    const body = [
      'SELECT a FROM [ai].[RawOrderImport];',   // 1 — live, before the opener
      '/* dropped in v3, close was lost',       // 2
      '   SELECT b FROM [ai].[RawOrderImport];', // 3
      '   SELECT c FROM [ai].[RawOrderImport];', // 4
    ].join('\n');
    const proc = makeModel([node({ id: '[ai].[spopen]', name: 'spOpen', type: 'procedure', bodyScript: body })]);
    const rows = ((searchDdl(proc, 'RawOrderImport', BUDGET) as DdlResult).results ?? []);
    const at = (line: number): DdlRow => rows.find(r => r.line === line)!;

    expect(at(1).commented, 'the live statement above the opener is untouched').toBeUndefined();
    expect(at(1).context.split('\n').map(l => l.startsWith('--')), 'and stays bare where the opener does not')
      .toEqual([false, true]);
    expect(at(4).commented, 'an unterminated block runs to the end, as a reader takes it too').toBe(true);
    expect(at(4).context.split('\n').every(l => l.startsWith('--'))).toBe(true);
    expect(at(3).context.split('\n')[0], 'the opener line is dead from its own first character')
      .toMatch(/^--/);
  });

  it('package.json languageModelTools is what the generator produces from TOOL_DEFS', () => {
    // Parity is asserted field-by-field in ai-tool-registration.test.ts; this runs the generator
    // itself, so a hand-edit that happens to match the fields but not the generated form fails here.
    expect(() => execFileSync(
      process.execPath,
      [rootPath('scripts/generate-tool-manifest.mjs'), '--check'],
      { cwd: rootPath('.'), stdio: 'pipe' },
    )).not.toThrow();
  });
});
