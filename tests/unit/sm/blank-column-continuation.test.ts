/** Invalid procedure continuations cannot poison the state dump, and corrected references stay admissible. */
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

describe.each([false, true])('procedure continuation admission (CS=%s)', identifierCaseSensitive => {
  it.each(['Value', 'Value With Space', '[ ]'])('rejects an empty column atomically and preserves corrected identity %j', correctedColumn => {
    const carrier = '[ct].[Result]', writer = '[ct].[Load]';
    const nodes = [
      makeNode({ id: carrier, schema: 'ct', name: 'Result', type: 'table', columns: [{ name: 'Value', type: 'int', nullable: 'NULL', extra: '' }] }),
      makeNode({ id: writer, schema: 'ct', name: 'Load', type: 'procedure', bodyScript: 'INSERT INTO [ct].[Result](Value) SELECT 7;' }),
    ];
    const pairs: Array<[string, string]> = [[writer, carrier]];
    const model = { ...makeModel(nodes, pairs, ['ct']), identifierCaseSensitive };
    const engine = new NavigationEngine(model, makeGraph(nodes, pairs), () => {}, {});
    expect(engine.init({ origin: carrier, question: 'Trace Value to its original sources', direction: 'upstream', analysisMode: 'ct', targetColumns: ['Value'], depthIntent: { upstream: { levels: 'all', exactness: 'approximate' }, downstream: { levels: 0, exactness: 'exact' } } })).toHaveProperty('ok', true);
    engine.getHopContext();
    const finding = { focus_node_id: carrier, verdict: 'passthrough' as const, summary: 'Stored value', sections: [{ angle: 'technical' as const, text: 'The procedure writes Value.' }], column_flow: [{ out_col: 'Value', upstream_columns: [{ node: writer, col: '' }] }] };
    const before = engine.toJSON();
    for (const col of ['', ' ']) {
      expect(engine.submitFindings({ ...finding, column_flow: [{ out_col: 'Value', upstream_columns: [{ node: writer, col }] }] })).toMatchObject({ code: 'contributor_col_not_on_source', issuePaths: ['column_flow.0.upstream_columns.0.col'] });
    }
    expect(engine.columnAspect?.edges).toEqual([]);
    expect(engine.toJSON().hopCount).toBe(before.hopCount);
    expect(engine.currentFocus).toBe(carrier);
    expect(() => engine.toJSON()).not.toThrow();
    expect(engine.submitFindings({ ...finding, column_flow: [{ out_col: 'Value', upstream_columns: [{ node: writer, col: correctedColumn }] }] })).toHaveProperty('ok', true);
    expect(engine.getHopContext().focus_node?.id).toBe(writer);
    expect(engine.columnAspect?.edges).toContainEqual(expect.objectContaining({ from_node: writer, from_col: correctedColumn, to_node: carrier, to_col: 'Value' }));
  });
});
