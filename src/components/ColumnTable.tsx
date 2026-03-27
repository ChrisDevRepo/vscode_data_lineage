import type { ColumnDef } from '../engine/types';

interface ColumnTableProps {
  columns: ColumnDef[];
  isVirtualExt: boolean;
  findQuery?: string;
}

function highlightText(text: string, query: string | undefined): React.ReactNode {
  if (!query || query.length < 2) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark style={{ background: 'var(--ln-highlight-yellow)', color: 'inherit' }}>
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}

export function ColumnTable({ columns, isVirtualExt, findQuery }: ColumnTableProps) {
  if (columns.length === 0) {
    return (
      <div className="text-xs" style={{ color: 'var(--ln-fg-dim)' }}>
        {isVirtualExt ? 'Virtual reference — column metadata not available.' : 'No column metadata available.'}
      </div>
    );
  }

  const pkCount = columns.filter(c => c.pkOrdinal !== undefined).length;

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--ln-border)' }}>
          <th className="text-left pb-1 text-xs font-semibold" style={{ color: 'var(--ln-fg-muted)', width: '38%' }}>Name</th>
          <th className="text-left pb-1 text-xs font-semibold" style={{ color: 'var(--ln-fg-muted)', width: '30%' }}>Type</th>
          <th className="text-left pb-1 text-xs font-semibold" style={{ color: 'var(--ln-fg-muted)', width: '18%' }}>Null</th>
          <th className="text-left pb-1 text-xs font-semibold" style={{ color: 'var(--ln-fg-muted)' }}>Flags</th>
        </tr>
      </thead>
      <tbody>
        {columns.map(col => {
          const pkBadge = col.pkOrdinal !== undefined ? (pkCount > 1 ? `PK${col.pkOrdinal}` : 'PK') : '';
          const flags = [
            col.extra || '',
            pkBadge,
            col.unique ? 'UQ' : '',
            col.check ? 'CK' : '',
          ].filter(Boolean).join(' ');
          return (
            <tr key={col.name} style={{ borderBottom: '1px solid var(--ln-border-light)' }}>
              <td className="py-0.5 pr-1 text-xs font-mono truncate" style={{ color: 'var(--ln-fg)', maxWidth: '0' }} title={col.name}>
                {highlightText(col.name, findQuery)}
              </td>
              <td className="py-0.5 pr-1 text-xs font-mono truncate" style={{ color: 'var(--ln-fg-muted)', maxWidth: '0' }} title={col.type}>
                {col.type}
              </td>
              <td className="py-0.5 text-xs" style={{ color: col.nullable === 'NULL' ? 'var(--ln-fg-dim)' : 'var(--ln-fg-muted)' }}>
                {col.nullable === 'NULL' ? 'null' : ''}
              </td>
              <td className="py-0.5 text-xs font-mono" style={{ color: 'var(--ln-fg-dim)' }}>
                {flags}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
