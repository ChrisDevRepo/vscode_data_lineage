import type { ColumnDef } from '../engine/types';
import { highlightText } from './highlight';
import { Tooltip } from './ui/Tooltip';

interface ColumnTableProps {
  columns: ColumnDef[];
  isVirtualExt: boolean;
  findQuery?: string;
  /** Hide Null and Flags columns (used for views/functions where these are meaningless). */
  compact?: boolean;
}

export function ColumnTable({ columns, isVirtualExt, findQuery, compact }: ColumnTableProps) {
  if (columns.length === 0) {
    return (
      <div className="text-xs" style={{ color: 'var(--ln-fg-dim)' }}>
        {isVirtualExt ? 'Virtual reference — column metadata not available.' : 'No column metadata available.'}
      </div>
    );
  }

  const pkCount = columns.filter(c => c.pkOrdinal !== undefined).length;

  return (
    <table className="ln-detail-table">
      <thead>
        <tr style={{ borderBottom: '1px solid var(--ln-border)' }}>
          <th style={{ width: compact ? '50%' : '38%' }}>Name</th>
          <th style={{ width: compact ? '50%' : '30%' }}>Type</th>
          {!compact && <th style={{ width: '18%' }}>Null</th>}
          {!compact && <th>Flags</th>}
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
            <tr key={col.name}>
              <Tooltip content={col.name} asChild>
                <td className="py-0.5 pr-1 text-xs font-mono truncate" style={{ color: 'var(--ln-fg)', maxWidth: '0' }}>
                  {highlightText(col.name, findQuery)}
                </td>
              </Tooltip>
              <Tooltip content={col.type} asChild>
                <td className="py-0.5 pr-1 text-xs font-mono truncate" style={{ color: 'var(--ln-fg-muted)', maxWidth: '0' }}>
                  {col.type}
                </td>
              </Tooltip>
              {!compact && <td className="py-0.5 text-xs" style={{ color: col.nullable === 'NULL' ? 'var(--ln-fg-dim)' : 'var(--ln-fg-muted)' }}>
                {col.nullable === 'NULL' ? 'null' : ''}
              </td>}
              {!compact && <td className="py-0.5 text-xs font-mono" style={{ color: 'var(--ln-fg-dim)' }}>
                {flags}
              </td>}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
