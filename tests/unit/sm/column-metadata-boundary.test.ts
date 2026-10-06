/** Missing column metadata permits fallback only for procedure/external object types. */
import { describe, expect, it } from 'vitest';
import { ColumnTracer } from '../../../src/ai/sm/columnTracer';
import type { ColumnFlowEntry, HopFindingKept } from '../../../src/ai/sm/smTypes';
import type { ObjectType } from '../../../src/engine/types';
import { makeModel, makeNode } from './helpers/fixtures';

/** The requested output of the origin the focus is traced from. */
const focusRoot = [{ node: 'focus', col: 'Result' }];

function node(id: string, type: ObjectType, columns: string[]) {
  return makeNode({ id, name: id, schema: 'dbo', type,
    columns: columns.map(name => ({ name, type: 'int', nullable: 'NULL', extra: '' })) });
}
function validate(focusType: ObjectType, focusCols: string[], sourceType: ObjectType, sourceCols: string[], flow?: ColumnFlowEntry, targetType?: ObjectType, targetCols: string[] = []) {
  const nodes = [node('focus', focusType, focusCols), node('source', sourceType, sourceCols), ...(targetType ? [node('target', targetType, targetCols)] : [])];
  const model = makeModel(nodes, [['source', 'focus'], ...(targetType ? [['focus', 'target'] as [string, string]] : [])], ['dbo']);
  const finding: HopFindingKept = { focus_node_id: 'focus', verdict: 'analyze', sections: [], summary: 'SQL-supported relation', column_flow: [flow ?? { out_col: 'Result', upstream_columns: [{ node: 'source', col: 'Input' }] }] };
  return new ColumnTracer(['Result']).validateColumnFlow('focus', finding, new Map(nodes.map(n => [n.id, n])), model, null, undefined, undefined, 'upstream', undefined, [], [], [], focusRoot);
}

describe('column metadata boundary', () => {
  it.each(['table', 'view', 'external', 'function'] as const)('marks complete %s catalog names as verified actual columns', type => {
    const result = validate('view', ['Result'], type, ['ActualInput', 'OtherInput']);
    expect(result.invalidRoutes).toContainEqual(expect.objectContaining({
      kind: 'bad_contributor_col', actual_columns: ['ActualInput', 'OtherInput'],
    }));
  });
  it('keeps procedure metadata eligibility separate from actual object columns', () => {
    const result = validate('view', ['Result'], 'procedure', ['ProcedureInput']);
    expect(result.invalidRoutes[0]).toMatchObject({ available_columns: ['procedureinput'] });
    expect(result.invalidRoutes[0]).not.toHaveProperty('actual_columns');
  });
  it('uses the full focus catalog rather than its tracked subset for unknown output names', () => {
    const result = validate('view', ['Result', 'Other'], 'table', ['Input'], { out_col: 'Missing', upstream_columns: [{ node: 'source', col: 'Input' }] });
    expect(result.invalidRoutes[0]).toMatchObject({ available_columns: ['Result'], actual_columns: ['Result', 'Other'] });
  });

  it.each(['table', 'view'] as const)('rejects %s sources with no declared columns', type => {
    const result = validate('view', ['Result'], type, []);
    expect(result.invalidRoutes).toContainEqual(expect.objectContaining({ kind: 'bad_contributor_col', reason: expect.stringMatching(/metadata/i) }));
    expect(result.stagedEdges).toEqual([]);
  });
  it.each(['table', 'view'] as const)('rejects %s focus outputs with no declared columns', type => {
    const result = validate(type, [], 'table', ['Input']);
    expect(result.invalidRoutes).toContainEqual(expect.objectContaining({ kind: 'bad_out_col', reason: expect.stringMatching(/metadata/i) }));
    expect(result.stagedEdges).toEqual([]);
  });
  it.each(['table', 'view'] as const)('rejects %s write destinations with no declared columns', type => {
    const result = validate('procedure', [], 'table', ['Input'], { out_col: 'Result', writes_to: { node: 'target', col: 'Saved' }, upstream_columns: [{ node: 'source', col: 'Input' }] }, type);
    expect(result.invalidRoutes).toContainEqual(expect.objectContaining({ kind: 'bad_out_col', reason: expect.stringMatching(/metadata/i) }));
    expect(result.stagedEdges).toEqual([]);
  });
  it.each(['procedure', 'external'] as const)('preserves no-column %s source fallback', type => {
    const result = validate('view', ['Result'], type, []);
    expect(result.invalidRoutes).toEqual([]);
    expect(result.stagedEdges).toEqual([expect.objectContaining({ from_node: 'source', from_col: 'Input', to_node: 'focus', to_col: 'Result' })]);
  });
  it.each(['procedure', 'external'] as const)('preserves no-column %s focus output fallback', type => {
    const result = validate(type, [], 'table', ['Input']);
    expect(result.invalidRoutes).toEqual([]);
    expect(result.stagedEdges).toEqual([expect.objectContaining({ from_node: 'source', from_col: 'Input', to_node: 'focus', to_col: 'Result' })]);
  });
  it.each(['table', 'view', 'procedure', 'external'] as const)('validates declared %s source columns', type => {
    const result = validate('view', ['Result'], type, ['Different']);
    expect(result.invalidRoutes).toContainEqual(expect.objectContaining({ kind: 'bad_contributor_col' }));
    expect(result.stagedEdges).toEqual([]);
  });
  it('checks contributor existence on a non-bodied carrier continuation', () => {
    const result = validate('table', ['Result'], 'view', []);
    expect(result.invalidRoutes).toContainEqual(expect.objectContaining({ kind: 'bad_contributor_col' }));
    expect(result.stagedEdges).toEqual([]);
  });
  it.each(['et', 'db', 'file'] as const)('permits missing metadata for external subtype %s and validates declared columns', subtype => {
    const nodes = [node('focus', 'view', ['Result']), node('source', 'external', [])];
    nodes[1].externalType = subtype;
    const model = makeModel(nodes, [['source', 'focus']], ['dbo']);
    const finding: HopFindingKept = { focus_node_id: 'focus', verdict: 'analyze', sections: [], summary: 'Explicit SQL source', column_flow: [{ out_col: 'Result', upstream_columns: [{ node: 'source', col: 'Input' }] }] };
    const validate = () => new ColumnTracer(['Result']).validateColumnFlow('focus', finding, new Map(nodes.map(n => [n.id, n])), model, null, undefined, undefined, 'upstream', undefined, [], [], [], focusRoot);
    expect(validate().invalidRoutes).toEqual([]);
    expect(validate().stagedEdges).toEqual([expect.objectContaining({ from_node: 'source', from_col: 'Input', to_node: 'focus', to_col: 'Result' })]);
    nodes[1].columns = node('source', 'external', ['Different']).columns;
    expect(validate().invalidRoutes).toContainEqual(expect.objectContaining({ kind: 'bad_contributor_col' }));
    expect(validate().stagedEdges).toEqual([]);
  });
  it('defers a carrier output rename to its columnless producer SQL rather than checking producer inputs', () => {
    const nodes = [node('focus', 'table', ['Result']), node('source', 'procedure', []), node('input', 'table', ['BeforeRename'])];
    const model = makeModel(nodes, [['input', 'source'], ['source', 'focus']], ['dbo']);
    model.neighborIndex.source = { in: ['input'], out: ['focus'] };
    model.neighborIndex.focus = { in: ['source'], out: [] };
    const finding: HopFindingKept = { focus_node_id: 'focus', verdict: 'analyze', sections: [], summary: 'Writer attribution required', column_flow: [{ out_col: 'Result', upstream_columns: [{ node: 'source', col: 'Result' }] }] };
    const result = new ColumnTracer(['Result']).validateColumnFlow('focus', finding, new Map(nodes.map(n => [n.id, n])), model, null, undefined, undefined, 'upstream', undefined, [], [], [], focusRoot);
    expect(result.invalidRoutes).toEqual([]);
    expect(result.stagedEdges).toEqual([expect.objectContaining({ from_node: 'source', from_col: 'Result', to_node: 'focus', to_col: 'Result' })]);
  });
  it('does not allow function parameters as columnless contributors', () => {
    const result = validate('view', ['Result'], 'function', [], { out_col: 'Result', upstream_columns: [{ node: 'source', col: '@Input' }] });
    expect(result.invalidRoutes).toContainEqual(expect.objectContaining({ kind: 'bad_contributor_col' }));
    expect(result.stagedEdges).toEqual([]);
  });
  it.each(['table', 'view', 'procedure', 'external', 'function'] as const)('preserves declared real %s source identity', type => {
    const result = validate('view', ['Result'], type, ['Input']);
    expect(result.invalidRoutes).toEqual([]);
    expect(result.stagedEdges).toEqual([expect.objectContaining({ from_node: 'source', from_col: 'Input', to_node: 'focus', to_col: 'Result' })]);
  });
  it.each(['table', 'view', 'procedure', 'external'] as const)('rejects an unknown output when %s metadata exists', type => {
    const result = validate(type, ['Different'], 'table', ['Input']);
    expect(result.invalidRoutes).toContainEqual(expect.objectContaining({ kind: 'bad_out_col' }));
    expect(result.stagedEdges).toEqual([]);
  });
  it.each(['table', 'view', 'procedure', 'external', 'function'] as const)('rejects an unknown %s write column when metadata exists', type => {
    const result = validate('procedure', [], 'table', ['Input'], { out_col: 'Result', writes_to: { node: 'target', col: 'Saved' }, upstream_columns: [{ node: 'source', col: 'Input' }] }, type, ['Different']);
    expect(result.invalidRoutes).toContainEqual(expect.objectContaining({ kind: 'bad_out_col' }));
    expect(result.stagedEdges).toEqual([]);
  });
  it('preserves a real renamed procedure write destination', () => {
    const result = validate('procedure', [], 'table', ['Input'], { out_col: 'Result', writes_to: { node: 'target', col: 'Saved' }, upstream_columns: [{ node: 'source', col: 'Input' }] }, 'table', ['Saved']);
    expect(result.invalidRoutes).toEqual([]);
    expect(result.stagedEdges).toEqual([
      expect.objectContaining({ from_node: 'source', from_col: 'Input', to_node: 'target', to_col: 'Saved' }),
      expect.objectContaining({ from_node: 'focus', from_col: 'Result', to_node: 'target', to_col: 'Saved' }),
    ]);
  });
});
