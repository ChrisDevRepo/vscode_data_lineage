/**
 * Runs column-flow rows from `tests/cases/lineage-cases.yaml`.
 * A row locks ids, columns, edges, and rejection kinds. Prompt sentences stay out of the catalog.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { ColumnTracer } from '../../../src/ai/sm/columnTracer';
import type { LineageNode, ObjectType } from '../../../src/engine/types';
import { makeModel, makeNode } from './helpers/fixtures';

const { loadCases } = createRequire(import.meta.url)('../../cases/loadCases.cjs') as {
  loadCases: (runner?: string) => CatalogRow[];
};

interface FlowColumn {
  readonly node: string;
  readonly col: string;
  readonly transforms?: readonly string[];
  readonly note?: string;
}

interface CaseNode {
  readonly id: string;
  readonly type: ObjectType;
  readonly columns?: readonly string[];
}

interface CaseExpect {
  readonly edges?: readonly string[];
  readonly invalid?: readonly unknown[];
  readonly invalid_kind?: string;
  readonly reason_contains?: string;
  readonly log_contains?: readonly string[];
  readonly log_matches?: string;
}

interface LineageCase {
  readonly id: string;
  readonly active: readonly string[];
  readonly nodes: readonly CaseNode[];
  readonly focus: string;
  readonly out: string;
  readonly direction: 'upstream' | 'downstream';
  readonly roots?: readonly { node: string; col: string }[];
  readonly upstream?: readonly FlowColumn[];
  readonly matrix?: readonly FlowColumn[];
  readonly expect: CaseExpect;
}

interface CatalogRow {
  readonly id: string;
  readonly runners?: readonly string[];
  readonly prompt?: string;
  readonly command?: string;
  readonly dacpac?: string;
  readonly expect?: CaseExpect & { graph?: boolean; terminal?: string; phase?: string };
}

const scriptedCases = loadCases('scripted') as unknown as LineageCase[];

function column(name: string) {
  return { name, type: 'int', nullable: 'NULL' as const, extra: '' };
}

function run(row: LineageCase, upstream: readonly FlowColumn[]) {
  const nodes = row.nodes.map(node => makeNode({
    id: node.id, schema: 'dbo', name: node.id, type: node.type,
    columns: (node.columns ?? []).map(column),
  }));
  const lines: string[] = [];
  const result = new ColumnTracer([...row.active]).validateColumnFlow(
    row.focus,
    { verdict: 'analyze', summary: 's', sections: [], column_flow: [{ out_col: row.out, upstream_columns: upstream }] } as never,
    new Map<string, LineageNode>(nodes.map(node => [node.id, node])),
    makeModel(nodes, [], ['dbo']),
    null,
    ((_level: string, message: string) => { lines.push(message); }) as never,
    undefined,
    row.direction,
    undefined,
    [],
    [],
    [],
    row.roots ?? [],
  );
  return { result, lines };
}

function check(row: LineageCase, upstream: readonly FlowColumn[]) {
  const { result, lines } = run(row, upstream);
  const wanted = row.expect;
  if (wanted.edges) expect(result.stagedEdges.map(edge => edge.from_col)).toEqual(wanted.edges);
  if (wanted.invalid) expect(result.invalidRoutes).toEqual(wanted.invalid);
  if (wanted.invalid_kind) expect(result.invalidRoutes[0]?.kind).toBe(wanted.invalid_kind);
  if (wanted.reason_contains) expect(result.invalidRoutes[0]?.reason).toContain(wanted.reason_contains);
  for (const text of wanted.log_contains ?? []) expect(lines.join('\n')).toContain(text);
  if (wanted.log_matches) {
    const relevant = lines.filter(line => line.includes('row role only')).join('\n');
    expect(relevant).toMatch(new RegExp(wanted.log_matches));
  }
}

describe('lineage case catalog', () => {
  it('gives Playwright, Electron, and headless their own rows and expected output', () => {
    expect(loadCases('scripted').some(row => row.runners?.includes('playwright'))).toBe(false);
    for (const runner of ['playwright', 'electron', 'headless'] as const) {
      const rows = loadCases(runner);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.runners).toEqual([runner]);
        expect(row.id.length).toBeGreaterThan(0);
        if (runner === 'playwright') {
          expect(row.command?.length).toBeGreaterThan(0);
          expect(row.expect?.graph).toBe(true);
        } else {
          expect(row.prompt?.length).toBeGreaterThan(0);
        }
        if (runner === 'electron') expect(row.expect?.phase?.length).toBeGreaterThan(0);
        if (runner === 'headless') {
          expect(row.dacpac?.length).toBeGreaterThan(0);
          expect(['ok', 'error', 'cancelled']).toContain(row.expect?.terminal);
        }
      }
    }
  });

  it.each(scriptedCases)('$id', row => {
    const calls = row.matrix?.length ? row.matrix : [row.upstream ?? []];
    for (const upstream of calls) {
      check(row, Array.isArray(upstream) ? upstream : [upstream]);
    }
  });
});
