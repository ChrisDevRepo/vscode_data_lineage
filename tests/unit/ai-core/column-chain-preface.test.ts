/** Backend column-chain formatting preserves validated edges and capture provenance. */
import { describe, expect, it } from 'vitest';
import { marked, type Tokens } from 'marked';
import { buildColumnChainPreface } from '../../../src/ai/tools/presentResult';

describe('column chain preface', () => {
  it('names each output once and preserves every source row, including repeated captures', () => {
    const edges = [
      { hop: 2, from_node: '[dbo].[rates]', from_col: 'Pct', to_node: '[dbo].[report]', to_col: 'Gross' },
      { hop: 1, from_node: '[dbo].[orders]', from_col: 'Amount', to_node: '[dbo].[report]', to_col: 'Gross' },
      { hop: 2, from_node: '[dbo].[orders]', from_col: 'Amount', to_node: '[dbo].[report]', to_col: 'Gross' },
      { hop: 3, from_node: '[dbo].[orders]', from_col: 'Qty', to_node: '[dbo].[report]', to_col: 'Quantity' },
    ];
    const before = structuredClone(edges);
    const text = buildColumnChainPreface(edges)!;
    const tables = marked.lexer(text).filter((token): token is Tokens.Table => token.type === 'table');
    expect(text.match(/\*\*Output:\*\*/g)).toHaveLength(2);
    expect(tables).toHaveLength(2);
    expect(tables[0]!.rows).toHaveLength(3);
    expect(tables[1]!.rows).toHaveLength(1);
    expect(tables[0]!.rows.map(row => row[1]!.text)).toEqual(['1', '2', '2']);
    expect(text.indexOf('orders].Amount')).toBeLessThan(text.indexOf('rates].Pct'));
    expect(edges).toEqual(before);
  });

  it('keeps pipes and backticks in identifiers from changing Markdown table structure', () => {
    const text = buildColumnChainPreface([
      { hop: 1, from_node: '[dbo].[a|`b]', from_col: 'x|`y', to_node: '[dbo].[target]', to_col: 'z`q' },
    ])!;
    const tables = marked.lexer(text).filter((token): token is Tokens.Table => token.type === 'table');
    expect(tables).toHaveLength(1);
    expect(tables[0]!.rows).toHaveLength(1);
    expect(tables[0]!.rows[0]).toHaveLength(3);
    const html = marked.parse(text);
    expect(html).toContain('<code>[dbo].[a|`b].x|`y</code>');
    expect(html).toContain('<code>[dbo].[target].z`q</code>');
  });

  it('omits the chain when no column edges were recorded', () => {
    expect(buildColumnChainPreface([])).toBeUndefined();
  });

  it('renders recorded roles in order and leaves missing roles blank', () => {
    const edges = [
      { hop: 1, from_node: 'source', from_col: 'Amount', to_node: 'target', to_col: 'Gross', transforms: ['compute', 'filter'] as const },
      { hop: 2, from_node: 'source', from_col: 'Rate', to_node: 'target', to_col: 'Gross' },
    ];
    const before = structuredClone(edges);
    const table = marked.lexer(buildColumnChainPreface(edges)!).find((token): token is Tokens.Table => token.type === 'table')!;
    expect(table.rows.map(row => row[2]!.text)).toEqual(['`compute`, `filter`', '']);
    expect(edges).toEqual(before);
  });
});
