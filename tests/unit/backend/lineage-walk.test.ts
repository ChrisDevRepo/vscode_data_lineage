// Owner: src/ai/sm/smBase.ts, columnTracer.ts and src/ai/tools/toolSchemas.ts; what a hop serves, what the backend accepts and the graph a walk delivers.
/** Runs the `contract: walk` rows of `tests/cases/lineage-cases.yaml` through the registered tools. The rows state decisions; `authorReply` owns the wire shape, so a contract change edits that function and no row. Scripted walks check the row's own final graph; generic walks ask every open neighbor ahead and must deliver the directed closure. */
import { describe, expect, it } from 'vitest';
import { closureOutcome, walkRow, walkRows } from './helpers/walkRows';

describe('catalog walk rows', () => {
  it('has rows', () => {
    expect(walkRows.length).toBeGreaterThan(0);
    expect(new Set(walkRows.map(row => row.id)).size).toBe(walkRows.length);
  });

  describe.each(walkRows)('$id', row => {
    it(`scripted: every hop satisfies the hop invariants and the row's final graph results`, async () => {
      const outcome = await walkRow(row, true);
      expect(outcome.violations).toEqual([]);
      expect(outcome.offers).toEqual([]);
      expect(outcome.nodes).toEqual([...row.expect.nodes].sort());
      expect(outcome.edges).toEqual(row.expect.edges.map(([from, to]) => `${from}>${to}`).sort());
      expect(outcome.columnEdges).toEqual((row.expect.column_edges ?? []).map(([from, fromCol, to, toCol]) => `${from}.${fromCol}>${to}.${toCol}`).sort());
      if (row.expect.deferred) expect(outcome.deferred).toEqual([...row.expect.deferred].sort());
    });

    it(`generic: asking every open neighbor ahead delivers the directed closure`, async () => {
      const outcome = await walkRow(row, false);
      expect(outcome.violations).toEqual([]);
      expect(outcome.offers).toEqual([]);
      const oracle = closureOutcome(row);
      expect(outcome.nodes).toEqual(oracle.nodes);
      expect(outcome.edges).toEqual(oracle.edges);
    });
  });
});
