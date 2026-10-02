/** Preserves authoritative DMV column references without assigning object dependencies to outputs. */
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { load } from 'js-yaml';
import { buildModelFromDmv, validateQueryResult } from '../../../src/engine/dmvExtractor';
import type { SimpleExecuteResult } from '../../../src/types/mssql';
import { loadParseRules, rootPath } from '../helpers/testUtils';
loadParseRules();

function result(names: string[], values: string[][]): SimpleExecuteResult {
  return { columnInfo: names.map(columnName => ({ columnName, dataType: 'string', dataTypeName: 'varchar' })), rowCount: values.length,
    rows: values.map(row => row.map(displayValue => ({ displayValue, isNull: displayValue === '' }))) };
}
const oldNames = ['referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name', 'referenced_database'];
const newNames = [...oldNames, 'referencing_column', 'referenced_column', 'referenced_type', 'referenced_server'];
function extract(names = newNames, rows: string[][] = [], secondColumn = 'Other') {
  const model = buildModelFromDmv({
    nodes: result(['schema_name', 'object_name', 'type_code', 'body_script'], [['demo', 'Calculated', 'U', ''], ['demo', 'Scalar', 'FN', 'CREATE FUNCTION demo.Scalar() RETURNS int AS BEGIN RETURN 1 END']]),
    columns: result(['schema_name', 'table_name', 'ordinal', 'column_name', 'type_name', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'is_computed'],
      [['demo', 'Calculated', '1', 'Amount', 'int', '4', '10', '0', '1', '0', '1'], ['demo', 'Calculated', '2', secondColumn, 'int', '4', '10', '0', '1', '0', '1']]),
    dependencies: result(names, rows),
  });
  return model.nodes.find(node => node.name === 'Calculated')!.columns!;
}
it('retains supplied column-qualified scalar, TVF and source-column metadata without inferred roles', () => {
  const columns = extract(newNames, [
    ['demo', 'Calculated', 'demo', 'Scalar', '', 'Amount', '', 'FN', ''],
    ['demo', 'Calculated', 'demo', 'Rows', '', 'Amount', '', 'IF', ''],
    ['demo', 'Calculated', 'source', 'Inputs', '', 'Amount', 'Value', 'U', ''],
    ['demo', 'Calculated', 'demo', 'Unbound', '', 'Amount', '', '', ''],
  ]);
  expect(columns[0]).toMatchObject({ expressionDependencies: [
    { reference: '[demo].[Scalar]', sourceElementType: 'FN' },
    { reference: '[demo].[Rows]', sourceElementType: 'IF' },
    { reference: '[source].[Inputs].[Value]', sourceElementType: 'U' },
    { reference: '[demo].[Unbound]' },
  ] });
  expect(columns[1]).not.toHaveProperty('expressionDependencies');
});
it('preserves an omitted database slot on server-qualified references', () => {
  expect(extract(newNames, [['demo', 'Calculated', 'demo', 'Scalar', '', 'Amount', '', 'FN', 'LinkedServer']])[0]).toMatchObject({
    expressionDependencies: [{ reference: '[LinkedServer]..[demo].[Scalar]', externalSource: '[LinkedServer].' }],
  });
});
it('binds exact catalog column names when loaded columns differ only in case', () => {
  const columns = extract(newNames, [['demo', 'Calculated', 'demo', 'Scalar', '', 'Amount', '', 'FN', '']], 'amount');
  expect(columns[0]).toHaveProperty('expressionDependencies');
  expect(columns[1]).not.toHaveProperty('expressionDependencies');
});
it('retains external identities without accepting a supplied local type as external evidence', () => {
  expect(extract(newNames, [['demo', 'Calculated', 'demo', 'Scalar', 'RemoteDb', 'Amount', '', 'FN', 'LinkedServer']])[0]).toMatchObject({
    expressionDependencies: [{ reference: '[LinkedServer].[RemoteDb].[demo].[Scalar]', externalSource: '[LinkedServer].[RemoteDb]' }],
  });
  expect(extract(newNames, [['demo', 'Calculated', 'demo', 'Scalar', 'RemoteDb', 'Amount', '', 'FN', 'LinkedServer']])[0].expressionDependencies![0]).not.toHaveProperty('sourceElementType');
});
it('leaves legacy, object-level, malformed and unknown-owner rows without invented output bindings', () => {
  expect(validateQueryResult('dependencies', result(oldNames, []))).toEqual([]);
  for (const columns of [extract(oldNames, [['demo', 'Calculated', 'demo', 'Scalar', '']]), extract(newNames, [
    ['demo', 'Calculated', 'demo', 'Scalar', '', '', '', 'FN', ''],
    ['demo', 'Calculated', '', 'Scalar', '', 'Amount', '', 'FN', ''],
    ['demo', 'Calculated', 'demo', '', '', 'Amount', '', 'FN', ''],
    ['demo', 'Calculated', 'demo', 'Scalar', '', 'MissingOutput', '', 'FN', ''],
  ])]) expect(columns.every(column => column.expressionDependencies === undefined)).toBe(true);
});
it('projects catalog minor identities and local type with left joins while retaining object dependency rows', () => {
  const config = load(readFileSync(rootPath('assets/dmvQueries.yaml'), 'utf8')) as { queries: Array<{ name: string; sql: string }> };
  const sql = config.queries.find(query => query.name === 'dependencies')!.sql;
  expect(sql).toContain('referencing_minor_id');
  expect(sql).toContain('referenced_minor_id');
  expect(sql).toContain('AS referencing_column');
  expect(sql).toContain('AS referenced_type');
  expect(sql).toMatch(/LEFT JOIN sys\.columns/);
  expect(sql).not.toMatch(/WHERE[\s\S]*referencing_minor_id\s*>\s*0/);
});
