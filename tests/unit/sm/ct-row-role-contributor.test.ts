import { ColumnTracer } from '../../../src/ai/sm/columnTracer';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

/** A column that only joins, filters, groups or orders rows is object lineage, never a column source. */
describe('CT contributor with a row role only', () => {
  const col = (name: string) => ({ name, type: 'int', nullable: 'NULL', extra: '' });
  const rpt = makeNode({ id: 'rpt', schema: 'dbo', name: 'rpt', type: 'view', columns: [col('Total')] });
  const src = makeNode({ id: 'src', schema: 'dbo', name: 'src', type: 'view', columns: [col('Amount'), col('IsOpen'), col('StoreId')] });
  const nodeMap = new Map<string, LineageNode>([['rpt', rpt], ['src', src]]);
  const model: DatabaseModel = makeModel([rpt, src], [], ['dbo']);
  const submit = (upstream_columns: unknown[], log?: (level: string, message: string) => void) =>
    new ColumnTracer(['Total']).validateColumnFlow('rpt', {
      verdict: 'analyze' as const, summary: 's', sections: [],
      column_flow: [{ out_col: 'Total', upstream_columns }],
    } as any, nodeMap, model, null, log as any, undefined, 'upstream', undefined, [], [], [], [{ node: 'rpt', col: 'Total' }]);

  it('stages the value input and leaves the filter and join keys out, naming them in the log', () => {
    const lines: string[] = [];
    const res = submit([
      { node: 'src', col: 'Amount', transforms: ['aggregate'] },
      { node: 'src', col: 'IsOpen', transforms: ['filter'] },
      { node: 'src', col: 'StoreId', transforms: ['combine', 'filter'] },
    ], (_level, message) => lines.push(message));
    expect(res.invalidRoutes).toEqual([]);
    expect(res.stagedEdges.map(edge => edge.from_col)).toEqual(['Amount']);
    expect(lines.filter(line => line.includes('row role only')).join('\n')).toMatch(/IsOpen[\s\S]*StoreId/);
  });

  it('keeps a column that carries a value and also selects rows', () => {
    const res = submit([{ node: 'src', col: 'Amount', transforms: ['compute', 'filter'] }]);
    expect(res.stagedEdges.map(edge => edge.from_col)).toEqual(['Amount']);
  });

  it('keeps a column the model did not classify', () => {
    const res = submit([{ node: 'src', col: 'Amount' }]);
    expect(res.stagedEdges.map(edge => edge.from_col)).toEqual(['Amount']);
  });

  it('accepts an output whose only listed columns are keys as ending here', () => {
    const res = submit([{ node: 'src', col: 'IsOpen', transforms: ['filter'] }]);
    expect(res.invalidRoutes).toEqual([]);
    expect(res.stagedEdges).toEqual([]);
  });

  it('still refuses a key column that does not exist', () => {
    const res = submit([{ node: 'src', col: 'Missing', transforms: ['filter'] }]);
    expect(res.invalidRoutes[0]?.kind).toBe('bad_contributor_col');
  });
});
