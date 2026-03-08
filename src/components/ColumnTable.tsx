import type { ColumnDef } from '../engine/types';

interface ColumnTableProps {
  columns: ColumnDef[];
  isVirtualExt: boolean;
}

export function ColumnTable({ columns, isVirtualExt }: ColumnTableProps) {
  if (columns.length === 0) {
    return (
      <div className="text-xs" style={{ color: 'var(--ln-fg-dim)' }}>
        {isVirtualExt ? 'Virtual reference — column metadata not available.' : 'No column metadata available.'}
      </div>
    );
  }

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
          const flags = [
            col.extra || '',
            col.unique ? 'UQ' : '',
            col.check ? 'CK' : '',
          ].filter(Boolean).join(' ');
          return (
            <tr key={col.name} style={{ borderBottom: '1px solid var(--ln-border-light)' }}>
              <td className="py-0.5 pr-1 text-xs font-mono truncate" style={{ color: 'var(--ln-fg)', maxWidth: '0' }} title={col.name}>
                {col.name}
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
