import { useState, useMemo, useDeferredValue, memo } from 'react';
import type { ObjectType, ColumnDef } from '../engine/types';
import { SidePanel } from './SidePanel';
import { searchBodyScripts, searchColumns } from '../utils/modelSearch';
import { highlightText } from './highlight';

export interface DetailSearchNode {
  id: string;
  name: string;
  schema: string;
  type: ObjectType;
  bodyScript?: string;
  columns?: ColumnDef[];
}

interface DetailSearchSidebarProps {
  onClose: () => void;
  allNodes: DetailSearchNode[];
  onResultClick: (nodeId: string, searchTerm: string) => void;
}

interface SearchResult {
  node: DetailSearchNode;
  snippet: string;
}

const TYPE_LABELS: Partial<Record<ObjectType, string>> = {
  procedure: 'Procedures',
  view: 'Views',
  table: 'Tables',
  external: 'External Tables',
};

const BODY_TYPES = new Set<ObjectType>(['procedure', 'view']);

export const DetailSearchSidebar = memo(function DetailSearchSidebar({
  onClose,
  allNodes,
  onResultClick,
}: DetailSearchSidebarProps) {
  const [input, setInput] = useState('');
  const deferredInput = useDeferredValue(input);

  const results = useMemo<SearchResult[]>(() => {
    const q = deferredInput.trim();
    const bodyResults = searchBodyScripts(allNodes, q, BODY_TYPES);
    const colResults = searchColumns(allNodes, q);
    return [...bodyResults, ...colResults];
  }, [deferredInput, allNodes]);

  // Group by display label
  const grouped = useMemo(() => {
    const map = new Map<string, SearchResult[]>();
    for (const r of results) {
      const label = TYPE_LABELS[r.node.type] || r.node.type;
      const arr = map.get(label) || [];
      arr.push(r);
      map.set(label, arr);
    }
    return map;
  }, [results]);

  const term = deferredInput.trim();

  function highlightSnippet(snippet: string): React.ReactNode[] {
    if (!term) return [snippet];
    const parts: React.ReactNode[] = [];
    const lower = snippet.toLowerCase();
    const termLower = term.toLowerCase();
    let lastIdx = 0;
    let idx = lower.indexOf(termLower);
    let key = 0;
    while (idx >= 0) {
      if (idx > lastIdx) parts.push(snippet.slice(lastIdx, idx));
      parts.push(<mark key={key++}>{snippet.slice(idx, idx + term.length)}</mark>);
      lastIdx = idx + term.length;
      idx = lower.indexOf(termLower, lastIdx);
    }
    if (lastIdx < snippet.length) parts.push(snippet.slice(lastIdx));
    return parts;
  }

  return (
    <SidePanel title="Detail Search" onClose={onClose}>
      <div className="px-3 py-2">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Search SQL bodies..."
          autoFocus
          className="w-full h-7 px-2 text-xs rounded ln-input"
        />
      </div>

      {term.length >= 2 && (
        <>
          {results.length === 0 ? (
            <div className="px-3 py-4 text-xs text-center" style={{ color: 'var(--ln-fg-muted)' }}>
              No results found. Ensure a graph is loaded.
            </div>
          ) : (
            <>
              <div className="px-3 pb-1">
                {[...grouped.entries()].map(([label, items]) => (
                  <div key={label} className="mb-2">
                    <div className="text-[10px] font-semibold uppercase tracking-wide py-1.5 mb-1" style={{ color: 'var(--ln-fg-muted)', borderBottom: '1px solid var(--ln-border-light)' }}>
                      {label} ({items.length})
                    </div>
                    {items.map(r => (
                      <div
                        key={r.node.id}
                        className="ln-detail-search-result"
                        onClick={() => onResultClick(r.node.id, term)}
                      >
                        <div className="text-xs font-medium" style={{ color: 'var(--ln-fg)' }}>
                          {highlightText(`[${r.node.schema}].${r.node.name}`, term)}
                        </div>
                        <div className="ln-detail-search-snippet">
                          {highlightSnippet(r.snippet)}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
              <div className="px-3 py-2 text-[11px] border-t" style={{ color: 'var(--ln-fg-muted)', borderColor: 'var(--ln-border-light)' }}>
                {results.length} result{results.length !== 1 ? 's' : ''}
              </div>
            </>
          )}
        </>
      )}
    </SidePanel>
  );
});
