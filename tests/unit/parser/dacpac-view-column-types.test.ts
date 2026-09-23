/**
 * A view's columns arrive from a DACPAC as computed columns with no declared type and no expression,
 * so they stay unresolved; a table computed column whose expression is not a bare column reference
 * stays unresolved too.
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

  it('does not borrow a type for a view column, even a renamed pass-through', () => {
    expect(columnType('[ai].[salesstaging]', 'OrderQty')).toBeDefined();
    expect(columnType('[ai].[vwconsolidatedsales]', 'Qty')).toBe(UNRESOLVED_COLUMN_TYPE);
  });

  it('does not borrow the xml type for a view column shredded from one xml column', () => {
    expect(columnType('[production].[vproductmodelcatalogdescription]', 'Summary')).toBe(UNRESOLVED_COLUMN_TYPE);
  });

  it('does not borrow a type for a table computed column whose expression calls a method', () => {
    expect(columnType('[humanresources].[employee]', 'OrganizationLevel')).toBe(UNRESOLVED_COLUMN_TYPE);
  });

  it('leaves a column with no single source unresolved', () => {
    expect(columnType('[ai].[vwpricelist]', 'UnitPrice')).toBe(UNRESOLVED_COLUMN_TYPE);
  });

  it('leaves declared table column types untouched', () => {
    expect(columnType('[ai].[factsalesreport]', 'TotalRevenue')).toBe('decimal(18,2)');
  });
});
