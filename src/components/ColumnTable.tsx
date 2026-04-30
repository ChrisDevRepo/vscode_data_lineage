import type { ColumnDef } from '../engine/types';
import { highlightText } from './highlight';
import { Tooltip } from './ui/Tooltip';

/**
 * Props for the `ColumnTable` component.
 */
interface ColumnTableProps {
  /** The array of column definitions to render. */
  columns: ColumnDef[];
  /** 
   * Indicates if the parent object is a "virtual" external reference.
   * If true, a specific message is shown indicating metadata unavailability.
   */
  isVirtualExt: boolean;
  /** Optional search query to highlight matching text within column names. */
  findQuery?: string;
  /** 
   * If true, hides the 'Null' and 'Flags' columns to save space.
   * Typically used for views or functions where these attributes are non-applicable.
   */
  compact?: boolean;
}

/**
 * Renders a tabular list of columns for a specific database object.
 * 
 * @remarks
 * This component provides:
 * - High-fidelity rendering of SQL Server column metadata (Name, Type, Nullability).
 * - Automatic badge generation for Primary Keys (PK) and Unique constraints (UQ).
 * - Truncation with tooltips for long column names and types.
 * - Integration with the global search highlight system.
 * 
 * @param props - The component props.
 */
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
