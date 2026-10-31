// Owner: src/ai/sm/columnTracer.ts and smBase.ts served schemas; contract tests at the supplied-message boundary.
/** Contract tests: the `tests/cases/lineage-cases.yaml` catalog shape and its column-flow rows (ids, columns, edges and rejection kinds per row), and what the model is served (the `out_col` enum, the procedure `out_node` requirement, the engine-qualified task endpoints, and the `questions`/`prune_neighbors` shape of a hop whose neighbors are all closed). Multi-hop runs live in lineage-cases-functional.test.ts. */
import { validateToolCandidate } from '../../../src/ai/support/toolValidation';
import { describe, expect, it } from 'vitest';
import { submitFindingsSchemaForMode } from '../../../src/ai/tools/toolSchemas';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import { makeNode } from '../helpers/modelFixtures';
import {
  check,
  column,
  engineFor,
  loadCases,
  scriptedCases,
  scriptedCatalog,
  selfPruneCases,
  storedArrivalCases,
  upstreamAll,
} from './helpers/lineageCaseHarness';

describe('lineage case catalog', () => {
  it('gives Playwright, Electron, and headless their own rows and expected output', () => {
    const rows = loadCases();
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(scriptedCases.length).toBeGreaterThan(0);
    expect(storedArrivalCases.length).toBeGreaterThan(0);
    for (const row of scriptedCases) {
      const keys = Object.keys(row.expect);
      expect(
        keys.length > 0 &&
          keys.every((key) =>
            ['edges', 'invalid', 'invalid_kind', 'reason_contains'].includes(
              key,
            ),
          ),
        row.id,
      ).toBe(true);
    }
    expect(selfPruneCases.length).toBeGreaterThan(0);
    expect(new Set(selfPruneCases.map((row) => row.id)).size).toBe(
      selfPruneCases.length,
    );
    expect(
      selfPruneCases.every(
        (row) => typeof row.story === 'string' && row.story.trim().length > 0,
      ),
    ).toBe(true);
    for (const row of selfPruneCases.filter(
      (row) => row.expect.eligible && !row.expect.refused,
    )) {
      expect(Object.keys(row.expect)).toEqual(
        expect.arrayContaining([
          'unvisited',
          'pruned',
          'inspected',
          'kept',
          'edges',
        ]),
      );
    }
    expect(
      scriptedCatalog.every(
        (row) =>
          row.contract === undefined ||
          row.contract === 'stored-arrival' ||
          row.contract === 'self-prune',
      ),
    ).toBe(true);
    expect(
      loadCases('scripted').some((row) => row.runners?.includes('playwright')),
    ).toBe(false);
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
        if (runner === 'electron')
          expect(row.expect?.phase?.length).toBeGreaterThan(0);
        if (runner === 'headless') {
          expect(row.dacpac?.length).toBeGreaterThan(0);
          expect(['ok', 'error', 'cancelled']).toContain(row.expect?.terminal);
        }
      }
    }
  });

  it.each(scriptedCases)('$id', (row) => {
    const calls = row.matrix?.length ? row.matrix : [row.upstream ?? []];
    for (const upstream of calls) {
      check(row, Array.isArray(upstream) ? upstream : [upstream]);
    }
  });
});

describe('out_col enum is the arriving columns', () => {
  it('serves only the arriving declared columns and rejects another declared column with allowed values', () => {
    const v = '[d].[V]',
      s = '[d].[S]';
    const nodes = [
      makeNode({
        id: v,
        schema: 'd',
        name: 'V',
        type: 'view',
        columns: [column('X'), column('Y')],
        bodyScript: 'CREATE VIEW d.V AS SELECT X, Y FROM d.S;',
      }),
      makeNode({
        id: s,
        schema: 'd',
        name: 'S',
        type: 'view',
        columns: [column('X'), column('Y')],
        bodyScript: 'CREATE VIEW d.S AS SELECT 1 AS X, 2 AS Y;',
      }),
    ];
    const engine = engineFor(nodes, [[s, v]]);
    expect(
      engine.init({
        origin: v,
        question: 'Trace X.',
        analysisMode: 'ct',
        targetColumns: ['X'],
        direction: 'upstream',
        depthIntent: upstreamAll,
      }),
    ).toHaveProperty('ok', true);
    engine.getHopContext();
    expect(engine.hopSubmitColumns.outCols).toEqual(['X']);
    const schema = submitFindingsSchemaForMode(
      'ct',
      'technical',
      false,
      engine.hopSubmitColumns,
    );
    const flow = (out_col: string) => ({
      focus_node_id: v,
      summary: 'Recorded findings.',
      column_flow: [
        {
          out_col,
          upstream_columns: [
            { node: s, col: 'X' },
            { node: s, col: 'Y' },
          ],
        },
      ],
    });
    expect(validateToolCandidate(schema, flow('X')).success).toBe(true);
    const bad = validateToolCandidate(schema, flow('Y'));
    expect(bad.success).toBe(false);
    // The declared-but-not-arriving Y is refused at its own path, and the refusal lists exactly the arriving columns.
    expect(bad.success ? [] : bad.rejection.errors).toEqual([
      { path: 'column_flow.0.out_col', code: 'unknown_column', values: ['X'] },
    ]);
  });
});

/**
 * A hop must not serve an entry that nothing can
 * satisfy (the `z.never` / `{"not":{}}` id). The hop below has one neighbor, already visited: it can be neither questioned nor pruned.
 * Expected values are read off that rule, not off the producer: both lists take zero entries, each id stays a plain string, and an
 * entry is refused once, as a size fault on the list itself.
 */
describe('a hop whose only neighbor is closed serves satisfiable questions and prune_neighbors', () => {
  const visited = '[d].[Visited]';
  const hop = {
    neighbors: [{ id: visited, can_question: false, can_prune: false }],
    outCols: null,
    outNode: false,
  };
  const reply = (mode: 'bb' | 'ct', extra: object) => ({
    focus_node_id: '[d].[Focus]',
    summary: 'Recorded findings.',
    sections: { technical: 'Reads Visited.' },
    ...(mode === 'ct' ? { column_flow: [] } : {}),
    ...extra,
  });
  const served = (mode: 'bb' | 'ct') => {
    const schema = submitFindingsSchemaForMode(mode, 'technical', true, hop);
    const json = toModelJsonSchema(schema) as {
      properties: Record<
        string,
        { maxItems?: number; items: { properties: Record<string, object> } }
      >;
    };
    return {
      schema,
      questions: json.properties.questions,
      prune: json.properties.prune_neighbors,
    };
  };
  const errors = (
    mode: 'bb' | 'ct',
    extra: object,
  ): readonly { path: string; code: string }[] | 'accepted' => {
    const result = validateToolCandidate(
      served(mode).schema,
      reply(mode, extra),
    );
    return result.success
      ? 'accepted'
      : result.rejection.errors.map(({ path, code }) => ({ path, code }));
  };

  for (const mode of ['bb', 'ct'] as const) {
    it(`${mode}: the questions cap serves zero entries and refuses a question to the visited neighbor with a size fault on the list`, () => {
      expect(served(mode).questions.maxItems).toBe(0);
      expect(errors(mode, { questions: [] })).toBe('accepted');
      const faults = errors(mode, {
        questions: [{ nodeId: visited, question: 'Check Visited.' }],
      });
      // The list-level fault only; the item-level half is the next test's guard.
      expect(
        faults === 'accepted'
          ? faults
          : faults.filter((f) => f.path === 'questions'),
      ).toEqual([{ path: 'questions', code: 'size' }]);
    });

    it(`${mode}: the closed neighbor keeps the question id a plain string, so no second never fault is raised at nodeId`, () => {
      const nodeId = served(mode).questions.items.properties.nodeId;
      expect(nodeId).toHaveProperty('type', 'string');
      expect(nodeId).not.toHaveProperty('not');
      expect(nodeId).not.toHaveProperty('enum');
      const faults = errors(mode, {
        questions: [{ nodeId: visited, question: 'Check Visited.' }],
      });
      expect(
        faults === 'accepted'
          ? []
          : faults.filter((f) => f.path !== 'questions'),
      ).toEqual([]);
    });

    it(`${mode}: with no prunable neighbor, prune_neighbors takes zero entries with a plain-string id and refuses a prune as one size fault`, () => {
      const { prune } = served(mode);
      expect(prune.maxItems).toBe(0);
      expect(prune.items.properties.id).toHaveProperty('type', 'string');
      expect(prune.items.properties.id).not.toHaveProperty('not');
      expect(errors(mode, { prune_neighbors: [] })).toBe('accepted');
      expect(
        errors(mode, {
          prune_neighbors: [{ id: visited, reason: 'Off the answer.' }],
        }),
      ).toEqual([{ path: 'prune_neighbors', code: 'size' }]);
    });
  }
});
