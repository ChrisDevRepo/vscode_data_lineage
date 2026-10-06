import { ColumnTracer } from '../../../src/ai/sm/columnTracer';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

/** A literal is never a column, whether or not the named neighbour declares columns. */
describe('CT literal named as a contributor column', () => {
  const rpt = makeNode({ id: 'rpt', schema: 'dbo', name: 'rpt', type: 'view', columns: [{ name: 'Currency', type: 'char(3)', nullable: 'NULL', extra: '' }] });
  const withCols = makeNode({ id: 'fx', schema: 'dbo', name: 'fx', type: 'view', columns: [{ name: 'Rate', type: 'decimal', nullable: 'NULL', extra: '' }] });
  const noCols = makeNode({ id: 'bare', schema: 'dbo', name: 'bare', type: 'view' });
  const nodeMap = new Map<string, LineageNode>([['rpt', rpt], ['fx', withCols], ['bare', noCols]]);
  const model: DatabaseModel = makeModel([rpt, withCols, noCols], [], ['dbo']);

  for (const [label, node] of [['a neighbour with declared columns', 'fx'], ['a neighbour with no declared columns', 'bare']] as const) {
    for (const literal of ["'EUR'", "N'EUR'", '0', '1.5']) {
      it(`${literal} against ${label} is refused as a literal`, () => {
        const res = new ColumnTracer(['Currency']).validateColumnFlow('rpt', {
          verdict: 'analyze' as const, summary: 's', sections: [],
          column_flow: [{ out_col: 'Currency', upstream_columns: [{ node, col: literal }] }],
        } as any, nodeMap, model, null, undefined, undefined, 'upstream');
        expect(res.stagedEdges).toEqual([]);
        expect(res.invalidRoutes[0]?.reason, 'the reason names the literal repair').toContain('is a literal, not a column reference');
      });
    }
  }
});
