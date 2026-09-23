/**
 * A view's columns arrive from a DACPAC as computed columns with no declared type. Where the model
 * names the one source column they read, the type is borrowed from it; where it names none or
 * several, the column stays unresolved.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseModel } from '../../../src/engine/types';
import { UNRESOLVED_COLUMN_TYPE } from '../../../src/engine/types';
import { loadAdventureWorksModel } from '../helpers/testUtils';

describe('DACPAC view column types', () => {
  let model: DatabaseModel;
  beforeAll(async () => { model = await loadAdventureWorksModel(); });
  const columnType = (nodeId: string, column: string): string | undefined =>
    model.nodes.find(n => n.id === nodeId)?.columns?.find(c => c.name.toLowerCase() === column.toLowerCase())?.type;

  it('borrows the source column type for a renamed pass-through column', () => {
    expect(columnType('[ai].[salesstaging]', 'OrderQty')).toBeDefined();
    expect(columnType('[ai].[vwconsolidatedsales]', 'Qty')).toBe(columnType('[ai].[salesstaging]', 'OrderQty'));
  });

  it('leaves a column with no single source unresolved', () => {
    expect(columnType('[ai].[vwpricelist]', 'UnitPrice')).toBe(UNRESOLVED_COLUMN_TYPE);
  });

  it('leaves declared table column types untouched', () => {
    expect(columnType('[ai].[factsalesreport]', 'TotalRevenue')).toBe('decimal(18,2)');
  });
});
