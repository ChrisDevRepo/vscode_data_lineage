import React from 'react';
import type { ForeignKeyInfo } from '../engine/types';
import { highlightText } from './highlight';
import { Tooltip } from './ui/Tooltip';

/**
 * Props for the {@link ForeignKeysSection} component.
 */
interface ForeignKeysSectionProps {
  /** Array of foreign key information objects to be displayed. */
  fks: ForeignKeyInfo[];
  /** Optional search query for highlighting matching text in the table. */
  findQuery?: string;
}

/**
 * A component that renders a table displaying foreign key constraints for a specific SQL table.
 *
 * @remarks
 * This section includes columns for the constraint name, source columns, referenced table, and delete rules.
 * It uses {@link Tooltip} for truncated text and {@link highlightText} for search result visualization.
 * It is typically rendered within a table detail or property panel.
 *
 * @param props - The component properties.
 * @returns A {@link React.JSX.Element} displaying the foreign keys table.
 */
export function ForeignKeysSection({ fks, findQuery }: ForeignKeysSectionProps) {
  return (
    <div style={{ borderTop: '1px solid var(--ln-border)', paddingTop: 10 }}>
      <div className="ln-section-label mb-2">
        FOREIGN KEYS
      </div>
      <table className="ln-detail-table">
        <thead>
          <tr style={{ borderBottom: '1px solid var(--ln-border)' }}>
            <th className="text-left font-semibold">Constraint</th>
            <th className="text-left font-semibold">Column(s)</th>
            <th className="text-left font-semibold">References</th>
            <th className="text-left font-semibold">On Delete</th>
          </tr>
        </thead>
        <tbody>
          {fks.map(fk => (
            <tr key={fk.name}>
              <Tooltip content={fk.name} asChild>
                <td className="py-0.5 pr-1 text-xs font-mono truncate" style={{ color: 'var(--ln-fg)', maxWidth: '0' }}>
                  {highlightText(fk.name, findQuery)}
                </td>
              </Tooltip>
              <Tooltip content={fk.columns.join(', ')} asChild>
                <td className="py-0.5 pr-1 text-xs font-mono truncate" style={{ color: 'var(--ln-fg-muted)', maxWidth: '0' }}>
                  {fk.columns.map((c, i) => <span key={i}>{i > 0 && ', '}{highlightText(c, findQuery)}</span>)}
                </td>
              </Tooltip>
              <Tooltip content={`[${fk.refSchema}].[${fk.refTable}](${fk.refColumns.join(', ')})`} asChild>
                <td className="py-0.5 pr-1 text-xs font-mono truncate" style={{ color: 'var(--ln-fg-muted)', maxWidth: '0' }}>
                  [{highlightText(fk.refSchema, findQuery)}].[{highlightText(fk.refTable, findQuery)}]
                </td>
              </Tooltip>
              <td className="py-0.5 text-xs font-mono" style={{ color: 'var(--ln-fg-dim)' }}>
                {fk.onDelete}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
