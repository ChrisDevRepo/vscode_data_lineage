/**
 * A hop on a writer sees the column constraints of each table it writes, so it can tell whether a
 * value it inserts is accepted (a NULL into a NOT NULL column). Tables it only reads keep the
 * neighbor shape without columns.
 */
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { HopFindingKept } from '../../../src/ai/sm/smTypes';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

const FACT = '[dbo].[fact]';
const LOAD = '[dbo].[load]';
const SOURCE = '[dbo].[source]';

function writerHopNeighbors() {
  const nodes = [
    makeNode({ id: FACT, schema: 'dbo', name: 'fact', type: 'table', columns: [
      { name: 'Id', type: 'int', nullable: 'NOT NULL', extra: '', pkOrdinal: 1 },
      { name: 'Amount', type: 'decimal(18,2)', nullable: 'NOT NULL', extra: '' },
      { name: 'Note', type: 'varchar(50)', nullable: 'NULL', extra: '' },
    ] }),
    makeNode({ id: LOAD, schema: 'dbo', name: 'load', type: 'procedure' }),
    makeNode({ id: SOURCE, schema: 'dbo', name: 'source', type: 'table', columns: [
      { name: 'Amount', type: 'decimal(18,2)', nullable: 'NULL', extra: '' },
    ] }),
  ];
  const pairs: Array<[string, string]> = [[SOURCE, LOAD], [LOAD, FACT]];
  const engine = new NavigationEngine(makeModel(nodes, pairs, ['dbo']), makeGraph(nodes, pairs), () => {}, {});
  expect(engine.init({
    origin: FACT, question: 'Explain how the fact rows are built', direction: 'upstream',
    depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } },
  })).toMatchObject({ ok: true });
  const kept: HopFindingKept = {
    focus_node_id: FACT, verdict: 'analyze', summary: 'The fact table stores amounts.',
    sections: [{ angle: 'technical', text: 'Rows are written by the load procedure.' }],
  };
  expect(engine.getHopContext().focus_node?.id).toBe(FACT);
  expect(engine.submitFindings(kept)).toMatchObject({ ok: true });
  const context = engine.getHopContext();
  expect(context.focus_node?.id).toBe(LOAD);
  return context.neighbors ?? [];
}

describe('written table columns on a writer hop', () => {
  it('lists every column of a written table with type, nullability and key', () => {
    expect(writerHopNeighbors().find(neighbor => neighbor.id === FACT)).toMatchObject({
      edge_type: 'write',
      cols: ['Id, int, not null, PK', 'Amount, decimal(18,2), not null', 'Note, varchar(50), nullable'],
    });
  });

  it('adds no columns to a table the writer only reads', () => {
    const source = writerHopNeighbors().find(neighbor => neighbor.id === SOURCE);
    expect(source).toMatchObject({ edge_type: 'read' });
    expect(source).not.toHaveProperty('cols');
  });
});
