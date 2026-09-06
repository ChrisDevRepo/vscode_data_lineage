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
 * - an over-budget result hands off with the existing `over_discovery_budget` fact and omits the
 *   list entirely, never a partial one;
 * - `package.json` `languageModelTools` is what the generator produces from `TOOL_DEFS`.
 *
 * Cap-setting calls (`setDiscoveryTokenBudget` — process-wide mutable module state) are made
 * inside the it() they apply to and restored afterwards, so no other test observes them.
 */

import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { searchDdl, searchObjects, setDiscoveryTokenBudget } from '../../../src/ai/tools/tools';
import { DEFAULT_DISCOVERY_TOKEN_BUDGET } from '../../../src/ai/support/tokenBudget';
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

type DdlRow = { id: string; name: string; type: string; line: number; text: string; context: string };
type DdlResult = {
  results?: DdlRow[]; total?: number; objects?: number; hint?: string; error?: string;
  searched?: { bodies: number; types: string[] }; reason?: string; results_omitted?: boolean;
};

describe('search tools — grep contract', () => {
  const model = makeModel();

  afterEach(() => setDiscoveryTokenBudget(DEFAULT_DISCOVERY_TOKEN_BUDGET));

  it('reports a hit with its object, 1-based line number, matched line and context', () => {
    const res = searchDdl(model, 'Archive.*Orders') as DdlResult;
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
    const res = searchDdl(model, 'OrderId') as DdlResult;
    expect(res.total, 'OrderId occurs on line 2 and line 4').toBe(2);
    expect(res.objects, 'both are in the same view, reported once each').toBe(1);
    expect((res.results ?? []).map(r => r.line)).toEqual([2, 4]);
    // Two occurrences on one line are two matches, as grep -o reports them.
    const sameLine = searchDdl(model, 'o\\.') as DdlResult;
    expect((sameLine.results ?? []).filter(r => r.line === 2)).toHaveLength(2);
  });

  it('accepts a redundant "(?i)" group end-to-end and matches case-insensitively', () => {
    const inline = searchDdl(model, '(?i)archiveorders') as DdlResult;
    const plain = searchDdl(model, 'ARCHIVEORDERS') as DdlResult;
    expect(inline.error, '(?i) is stripped, not rejected').toBeUndefined();
    expect(inline.total).toBe(1);
    expect(plain.total, 'matching is case-insensitive with or without the group').toBe(1);
  });

  it('states an empty result as a fact with no repair advice, distinct from an invalid pattern', () => {
    const empty = searchDdl(model, 'no_such_token') as DdlResult;
    expect(empty).toEqual({ results: [], total: 0, objects: 0, searched: { bodies: 1, types: ['view', 'procedure', 'function'] } });
    expect('hint' in empty, 'no substring advice on a regex tool — it drove the T3 retry loop').toBe(false);
    expect('error' in empty, 'zero matches is not an error').toBe(false);

    const invalid = searchDdl(model, 'foo(') as DdlResult;
    expect(invalid.error, 'an unusable pattern is an error, not an empty result').toBe('invalid_regex');
    expect(invalid.hint).toContain('closing ")"');
    expect('results' in invalid, 'a rejection carries no result list').toBe(false);
  });

  it('anchors work per line like grep, and "." never crosses a line break', () => {
    expect((searchDdl(model, '^CREATE') as DdlResult).total, '^ matches the first line').toBe(1);
    expect((searchDdl(model, '^SELECT') as DdlResult).total, '^ matches a line start inside the body').toBe(1);
    expect((searchDdl(model, 'OrderId > 0$') as DdlResult).total, '$ matches a line end').toBe(1);
    expect((searchDdl(model, 'ai.vwSales AS.SELECT') as DdlResult).total, '. never crosses a line break').toBe(0);
  });

  it('a pattern whose first match is empty still reports the real match later in the body', () => {
    // `x*` matches the empty string at offset 0. Skipping the node on an empty first match hid
    // every later match in that body; the scan advances one position and keeps going instead.
    const withX = makeModel([
      node({ id: '[ai].[vwx]', name: 'vwX', type: 'view', bodyScript: 'SELECT xId\nFROM ai.ArchiveOrders' }),
    ]);
    const res = searchDdl(withX, 'x*') as DdlResult;
    const onVwX = (res.results ?? []).filter(r => r.id === '[ai].[vwx]');
    expect(onVwX.length, 'the node is scanned, not skipped').toBeGreaterThan(0);
    expect(onVwX.some(r => r.text.includes('xId')), 'the real match is reported').toBe(true);
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
    setDiscoveryTokenBudget(1000);
    const res = searchDdl(wide, 'ArchiveOrders') as DdlResult;
    expect(res.reason, 'reuses the existing discovery over-budget fact').toBe('over_discovery_budget');
    expect(res.results_omitted).toBe(true);
    expect('results' in res, 'never a partial list').toBe(false);
    expect(res.total, 'the count still answers "how much is there"').toBe(201);
    expect(res.hint).toContain('Narrow the pattern');

    setDiscoveryTokenBudget(DEFAULT_DISCOVERY_TOKEN_BUDGET);
    const inline = searchDdl(wide, 'ArchiveOrders') as DdlResult;
    expect(inline.results?.length, 'under budget the full list is inlined').toBe(201);
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

  it('never suggests regex mode to a caller already in regex mode', () => {
    const res = searchObjects(model, 'zzz_no_such_object', undefined, undefined, 'regex') as { ai_hint?: string };
    expect(res.ai_hint).not.toContain('try regex mode');
    const substring = searchObjects(model, 'zzz_no_such_object') as { ai_hint?: string };
    expect(substring.ai_hint, 'substring mode still gets the mode suggestion').toContain('try regex mode');
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
