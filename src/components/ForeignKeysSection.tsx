import type { ForeignKeyInfo } from '../engine/types';
import { highlightText } from './highlight';
import { Tooltip } from './ui/Tooltip';

export function ForeignKeysSection({ fks, findQuery }: { fks: ForeignKeyInfo[]; findQuery?: string }) {
  return (
    <div style={{ borderTop: '1px solid var(--ln-border)', paddingTop: 10 }}>
      <div className="text-xs font-semibold tracking-wider mb-2"
        style={{ color: 'var(--ln-fg-dim)', letterSpacing: '0.08em' }}>
        FOREIGN KEYS
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--ln-border)' }}>
            <th className="text-left pb-1 text-xs font-semibold" style={{ color: 'var(--ln-fg-muted)' }}>Constraint</th>
            <th className="text-left pb-1 text-xs font-semibold" style={{ color: 'var(--ln-fg-muted)' }}>Column(s)</th>
            <th className="text-left pb-1 text-xs font-semibold" style={{ color: 'var(--ln-fg-muted)' }}>References</th>
            <th className="text-left pb-1 text-xs font-semibold" style={{ color: 'var(--ln-fg-muted)' }}>On Delete</th>
          </tr>
        </thead>
        <tbody>
          {fks.map(fk => (
            <tr key={fk.name} style={{ borderBottom: '1px solid var(--ln-border-light)' }}>
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
