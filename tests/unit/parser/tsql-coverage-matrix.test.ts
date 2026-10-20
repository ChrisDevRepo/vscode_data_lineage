/** Exact parser edges. Each row in tests/cases/parser/exact-edges.yaml is one SQL statement and the full source, target, and call lists. A missing name and an invented name both fail. Two generated-length statements stay in this file. Partial checks stay in parser-edge-cases.test.ts. Whole procedures are the yaml `fixture-*` rows. */
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildModel } from '../../../src/engine/modelBuilder';
import { extractExternalRefs, parseSqlBody } from '../../../src/engine/sqlBodyParser';
import { loadParseRules } from '../helpers/testUtils';

beforeAll(() => { loadParseRules(); });

/** Expected references as `schema.object`; cross-database ones as `db.schema.object`. */
type Expect = { s?: string[]; t?: string[]; x?: string[]; xs?: string[]; xt?: string[] };

/** Plain expectations split at the first dot; quoted expectations are already canonical. */
const key = (name: string, cs: boolean) => {
  const canonical = name.startsWith('[') ? name : `[${name.replace(/]/g, ']]').replace('.', '].[')}]`;
  return cs ? canonical : canonical.toLowerCase();
};
const sorted = <T>(list: T[]) => [...list].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

function expectParsed(sql: string, want: Expect, cs = false) {
  const parsed = parseSqlBody(sql, undefined, cs);
  const names = (values: string[] = []) => sorted(values.map(name => key(name, cs)));
  const remote = (values: string[] = []) => sorted(values.map(name => cs ? name : name.toLowerCase()));
  expect({
    s: sorted(parsed.sources), t: sorted(parsed.targets), x: sorted(parsed.execCalls),
    xs: sorted(parsed.crossDbSources), xt: sorted(parsed.crossDbTargets),
  }).toEqual({
    s: names(want.s), t: names(want.t), x: names(want.x),
    xs: remote(want.xs), xt: remote(want.xt),
  });
  return parsed;
}

interface EdgeCase {
  id: string;
  description: string;
  sql: string;
  case_modes?: Array<'ci' | 'cs'>;
  mutations?: Array<{ parts: string[]; kind: 'write' | 'delete' }>;
  graph?: {
    tables: string[];
    metadata: string[];
    current_database?: string;
    edges: Array<{ source: string; target: string; type: 'body' | 'exec'; deleteOnly?: true }>;
  };
  sources?: string[];
  targets?: string[];
  exec?: string[];
  cross_db_sources?: string[];
  cross_db_targets?: string[];
  /** Full file or URL list. Present only when the statement is checking external refs. */
  external?: { url: string; kind: string }[];
}

const cases = (load(readFileSync(new URL('../../cases/parser/exact-edges.yaml', import.meta.url), 'utf8')) as { cases: EdgeCase[] }).cases;

describe('exact parser edges', () => {
  it('gives every case its own id', () => {
    const ids = cases.map(row => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(cases.every(row => row.id && row.description && row.sql)).toBe(true);
    for (const row of cases) {
      const modes = row.case_modes ?? ['ci'];
      expect(modes.length, row.id).toBeGreaterThan(0);
      expect(new Set(modes).size, row.id).toBe(modes.length);
      expect(modes.every(mode => mode === 'ci' || mode === 'cs'), row.id).toBe(true);
    }
  });

  it.each(cases.flatMap(row => (row.case_modes ?? ['ci']).map(mode => ({ ...row, mode }))))('$id ($mode)', row => {
    const cs = row.mode === 'cs';
    const parsed = expectParsed(row.sql, {
      s: row.sources, t: row.targets, x: row.exec, xs: row.cross_db_sources, xt: row.cross_db_targets,
    }, cs);
    if (row.mutations !== undefined) expect(parsed.mutations).toEqual(row.mutations);
    if (row.graph !== undefined) {
      const focus = 'gen.Subject';
      const objects = [
        { fullName: focus, type: 'procedure' as const, bodyScript: row.sql },
        ...row.graph.tables.map(fullName => ({ fullName, type: 'table' as const })),
      ];
      const metadata = row.graph.metadata.map(targetName => ({ sourceName: focus, targetName }));
      const model = buildModel(objects, metadata, objects, row.graph.current_database ?? 'LocalDb', true, undefined, cs);
      expect(sorted(model.edges)).toEqual(sorted(row.graph.edges.map(edge => ({
        ...edge, source: cs ? edge.source : edge.source.toLowerCase(), target: cs ? edge.target : edge.target.toLowerCase(),
      }))));
    }
    if (row.external !== undefined) {
      expect(extractExternalRefs(row.sql).map(ref => ({ url: ref.url, kind: ref.kind }))).toEqual(row.external);
    }
  });

  it('a SET list of any length keeps the aliased write', () => {
    expectParsed(`UPDATE t SET x=1${', y=1'.repeat(1000)} FROM dbo.T t`, { s: ['dbo.T'], t: ['dbo.T'] });
  });

  it('CTAS with a column list, nested options and options of any length', () => {
    expectParsed(`CREATE TABLE dbo.T (a, b) WITH (DISTRIBUTION = HASH(a), PARTITION (b RANGE RIGHT FOR VALUES (${'1, '.repeat(300)}2)))\nAS\nSELECT a, b FROM dbo.S`, { s: ['dbo.S'], t: ['dbo.T'] });
  });
});

describe('the ANSI-89 comma-list scan is linear in the size of the body', () => {
  const SIZES_KB = [25, 50, 100, 200];
  const MAX_RATIO_PER_DOUBLING = 3;
  const MAX_SECONDS = 20;
  const RUNS = 3;

  /** CPU time measures scaling without scheduler waits; elapsed time still enforces the wall-clock cap. */
  const fastestSeconds = (sqls: string[]) => {
    const cpu = sqls.map(() => Number.POSITIVE_INFINITY);
    const wall = [...cpu];
    for (let round = 0; round < RUNS; round++) {
      sqls.forEach((sql, i) => {
        const start = performance.now();
        const cpuStart = process.cpuUsage();
        parseSqlBody(sql);
        const used = process.cpuUsage(cpuStart);
        cpu[i] = Math.min(cpu[i], (used.user + used.system) / 1_000_000);
        wall[i] = Math.min(wall[i], (performance.now() - start) / 1000);
      });
    }
    return { cpu, wall };
  };

  const body = (unit: string, kb: number) => unit.repeat(Math.ceil(kb * 1024 / unit.length));
  const inputs: Array<[string, (kb: number) => string]> = [
    ['repeated FETCH NEXT FROM c', kb => body('FETCH NEXT FROM c INTO @x\n', kb)],
    ['repeated unbalanced [', kb => body('[ x ', kb)],
    ['one long comma list', kb => 'SELECT * FROM dbo.A a' + body(', dbo.B b WITH (NOLOCK), dbo.fn(1, 2) f, (SELECT 1 x) d', kb)],
  ];

  it.each(inputs)('%s', (_name, build) => {
    const times = fastestSeconds(SIZES_KB.map(kb => build(kb)));
    expect(Math.max(...times.wall)).toBeLessThan(MAX_SECONDS);
    times.cpu.slice(1).forEach((time, i) => {
      // a floor keeps a sub-millisecond baseline from turning timer noise into a ratio
      expect(time / Math.max(times.cpu[i], 0.01)).toBeLessThan(MAX_RATIO_PER_DOUBLING);
    });
  });
});
