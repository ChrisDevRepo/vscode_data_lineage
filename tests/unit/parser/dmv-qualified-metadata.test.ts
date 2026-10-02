/** DMV metadata keeps dotted schema/table identities separate without changing canonical IDs. */
import { expect, it } from 'vitest';
import { buildModelFromDmv } from '../../../src/engine/dmvExtractor';
import type { SimpleExecuteResult } from '../../../src/types/mssql';
import { loadParseRules } from '../helpers/testUtils';

loadParseRules();

function result(names: string[], values: string[][]): SimpleExecuteResult {
  return {
    columnInfo: names.map(columnName => ({ columnName, dataType: 'string', dataTypeName: 'varchar' })),
    rowCount: values.length,
    rows: values.map(row => row.map(displayValue => ({ displayValue, isNull: displayValue === '' }))),
  };
}

function extract(constraints: string[][] = []) {
  return buildModelFromDmv({
    nodes: result(['schema_name', 'object_name', 'type_code', 'body_script'], [
      ['a.b', 'c', 'U', ''], ['a', 'b.c', 'U', ''], ['dbo', 'Target', 'U', ''],
    ]),
    columns: result(['schema_name', 'table_name', 'ordinal', 'column_name', 'type_name', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'is_computed'], [
      ['A.B', 'C', '1', 'Shared', 'int', '4', '10', '0', '0', '0', '0'],
      ['a.b', 'c', '2', 'FirstOnly', 'int', '4', '10', '0', '1', '0', '0'],
      ['a', 'b.c', '1', 'Shared', 'int', '4', '10', '0', '0', '0', '0'],
      ['a', 'b.c', '2', 'SecondOnly', 'int', '4', '10', '0', '1', '0', '0'],
      ['dbo', 'Target', '1', 'Id', 'int', '4', '10', '0', '0', '0', '0'],
      ['missing', 'c', '1', 'Unowned', 'int', '4', '10', '0', '1', '0', '0'],
    ]),
    dependencies: result(['referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name'], []),
    constraints: result(['schema_name', 'table_name', 'constraint_type', 'constraint_name', 'column_name', 'ref_schema', 'ref_table', 'ref_column', 'on_delete'], constraints),
  });
}

it('assigns columns only to their qualified catalog owner while preserving case-insensitive metadata matching', () => {
  const model = extract();
  expect(model.nodes.map(node => node.id).sort()).toEqual(['[a.b].[c]', '[a].[b.c]', '[dbo].[target]']);
  expect(model.nodes.find(node => node.id === '[a.b].[c]')?.columns?.map(column => column.name)).toEqual(['Shared', 'FirstOnly']);
  expect(model.nodes.find(node => node.id === '[a].[b.c]')?.columns?.map(column => column.name)).toEqual(['Shared', 'SecondOnly']);
  expect(model.nodes.flatMap(node => node.columns ?? []).map(column => column.name)).not.toContain('Unowned');
});

it('keeps unique, check and foreign-key constraints on their declared dotted-identifier owner', () => {
  const model = extract([
    ['A.B', 'C', 'CK', 'CK_First', 'Shared', '', '', '', ''],
    ['a', 'b.c', 'UQ', 'UQ_Second', 'Shared', '', '', '', ''],
    ['a.b', 'c', 'FK', 'FK_First', 'Shared', 'dbo', 'Target', 'Id', 'CASCADE'],
    ['a', 'b.c', 'FK', 'FK_Second', 'Shared', 'dbo', 'Target', 'Id', 'SET_NULL'],
    ['missing', 'c', 'UQ', 'UQ_Unowned', 'Shared', '', '', '', ''],
  ]);
  const first = model.nodes.find(node => node.id === '[a.b].[c]')!;
  const second = model.nodes.find(node => node.id === '[a].[b.c]')!;
  expect(first.columns?.find(column => column.name === 'Shared')).toMatchObject({ check: 'CK_First', unique: '' });
  expect(second.columns?.find(column => column.name === 'Shared')).toMatchObject({ check: '', unique: 'UQ_Second' });
  expect(first.fks).toEqual([{ name: 'FK_First', columns: ['Shared'], refSchema: 'dbo', refTable: 'Target', refColumns: ['Id'], onDelete: 'CASCADE' }]);
  expect(second.fks).toEqual([{ name: 'FK_Second', columns: ['Shared'], refSchema: 'dbo', refTable: 'Target', refColumns: ['Id'], onDelete: 'SET NULL' }]);
});
