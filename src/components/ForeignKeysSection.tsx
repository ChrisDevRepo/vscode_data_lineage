import type { ForeignKeyInfo } from '../engine/types';

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
              <td className="py-0.5 pr-1 text-xs font-mono truncate" style={{ color: 'var(--ln-fg)', maxWidth: '0' }} title={fk.name}>
                {highlightText(fk.name, findQuery)}
              </td>
              <td className="py-0.5 pr-1 text-xs font-mono truncate" style={{ color: 'var(--ln-fg-muted)', maxWidth: '0' }} title={fk.columns.join(', ')}>
                {fk.columns.map((c, i) => <span key={i}>{i > 0 && ', '}{highlightText(c, findQuery)}</span>)}
              </td>
              <td className="py-0.5 pr-1 text-xs font-mono truncate" style={{ color: 'var(--ln-fg-muted)', maxWidth: '0' }}
                title={`[${fk.refSchema}].[${fk.refTable}](${fk.refColumns.join(', ')})`}>
                [{highlightText(fk.refSchema, findQuery)}].[{highlightText(fk.refTable, findQuery)}]
              </td>
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
