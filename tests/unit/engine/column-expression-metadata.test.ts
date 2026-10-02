/** Column expression metadata survives storage and validated IPC, with legacy payload compatibility. */
import { expect, it } from 'vitest';
import { ColumnStore } from '../../../src/engine/columnStore';
import { ExtensionToDetailMsgSchema } from '../../../src/engine/shared/bridgeContract';

const legacyColumn = { name: 'Amount', type: 'decimal(18,2)', nullable: 'NULL', extra: 'COMPUTED' };
const frame = (column: unknown) => ({ type: 'detail-update', node: {
  id: '[demo].[Projected]', fullName: '[demo].[Projected]', schema: 'demo', name: 'Projected', type: 'view', columns: [column],
}, config: {} });

it('retains exact declared metadata through JSON storage and IPC parsing', () => {
  const column = { ...legacyColumn, expressionDependencies: [
    { reference: '[demo].[Scalar]', sourceElementType: 'SqlScalarFunction' },
    { reference: '[remote].[Rows].[Amount]', externalSource: 'ExternalIdentity' },
  ] };
  const store = new ColumnStore();
  store.setColumns('[demo].[Projected]', JSON.parse(JSON.stringify([column])));
  expect(store.getColumns('[demo].[Projected]')).toEqual([column]);
  expect(ExtensionToDetailMsgSchema.parse(frame(store.getColumns('[demo].[Projected]')![0]))).toEqual(frame(column));
  expect(ExtensionToDetailMsgSchema.parse(frame(legacyColumn))).toEqual(frame(legacyColumn));
});

it.each([null, [{ reference: '' }], [{ reference: '  ' }], [{ reference: 4 }], [{ reference: 'x', sourceElementType: 3 }], [{ reference: 'x', externalSource: false }]])('rejects malformed declared metadata at IPC: %j', expressionDependencies => {
  expect(ExtensionToDetailMsgSchema.safeParse(frame({ ...legacyColumn, expressionDependencies })).success).toBe(false);
});
