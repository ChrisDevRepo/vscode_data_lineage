import { describe, expect, it } from 'vitest';
import { assignEvidenceIds, evidenceCoverage } from '../../../src/ai/tools/presentResult';
import { columnRefSuffix } from '../../../src/ai/tools/handlers/submitFindings';
import type { DetailSlot } from '../../../src/ai/session/memoryManager';

/** Log-only signals: which captured SQL the report shows, and how a hop classified its column refs. */
describe('evidenceCoverage', () => {
  const slot = (text: string): DetailSlot => ({ nodeId: 'n', sections: [{ label: 'business', text }] }) as unknown as DetailSlot;
  const { blocks } = assignEvidenceIds([
    slot('Rule.\n```sql\nWHERE a.IsOpen = 1\n```\nFormula.\n```sql\nSELECT a.Qty * 2 AS Doubled\n```'),
  ]);

  it('counts a block shown with different whitespace and lists the block no field shows', () => {
    expect(evidenceCoverage(blocks, ['Step 1\n   ```sql\n   WHERE  a.IsOpen = 1\n   ```'])).toEqual({ served: 2, unusedIds: ['S2'] });
  });

  it('reports every block unused for a report without SQL', () => {
    expect(evidenceCoverage(blocks, ['prose only', ''])).toEqual({ served: 2, unusedIds: ['S1', 'S2'] });
  });

  it('reports nothing served for an archive without SQL blocks', () => {
    expect(evidenceCoverage(assignEvidenceIds([slot('prose')]).blocks, ['```sql\nSELECT 1\n```'])).toEqual({ served: 0, unusedIds: [] });
  });
});

describe('columnRefSuffix', () => {
  it('counts refs without a note and refs that pair a row role with a value role', () => {
    expect(columnRefSuffix([
      { out_col: 'Total', upstream_columns: [
        { node: 'src', col: 'Amount', transforms: ['compute'], note: 'a.Amount * 2' },
        { node: 'src', col: 'RankDate', transforms: ['compute', 'filter'] },
        { node: 'src', col: 'IsOpen', transforms: ['filter'] },
        { node: 'src', col: 'Plain' },
      ] },
    ])).toBe(' refs=4 refs_no_note=3 role_mixed=1');
  });

  it('yields zero counts for a hop without column_flow', () => {
    expect(columnRefSuffix(undefined)).toBe(' refs=0 refs_no_note=0 role_mixed=0');
  });
});
