import { useState, useMemo, useDeferredValue, memo } from 'react';
import type { ObjectType } from '../engine/types';
import { SidePanel } from './SidePanel';

export interface DetailSearchNode {
  id: string;
  name: string;
  schema: string;
  type: ObjectType;
  bodyScript?: string;
}

interface DetailSearchSidebarProps {
  onClose: () => void;
  allNodes: DetailSearchNode[];
  onResultClick: (nodeId: string) => void;
}

interface SearchResult {
  node: DetailSearchNode;
  snippet: string;
}

const TYPE_LABELS: Partial<Record<ObjectType, string>> = {
  procedure: 'Procedures',
  view: 'Views',
};

const SEARCHABLE_TYPES = new Set<ObjectType>(['procedure', 'view']);

function buildSnippet(body: string, term: string): string {
  const lower = body.toLowerCase();
  const idx = lower.indexOf(term.toLowerCase());
  if (idx < 0) return '';

  const lines = body.split('\n');
  let charCount = 0;
  let matchLine = 0;
  for (let i = 0; i < lines.length; i++) {
    charCount += lines[i].length + 1;
    if (charCount > idx) { matchLine = i; break; }
  }

  const start = Math.max(0, matchLine - 1);
  const end = Math.min(lines.length, matchLine + 2);
  return lines.slice(start, end).map(l => l.trimEnd()).join('\n');
}

export const DetailSearchSidebar = memo(function DetailSearchSidebar({
  onClose,
  allNodes,
  onResultClick,
}: DetailSearchSidebarProps) {
  const [input, setInput] = useState('');
  const deferredInput = useDeferredValue(input);

  const results = useMemo(() => {
    const term = deferredInput.trim();
    if (term.length < 2) return [];

    const matches: SearchResult[] = [];
    for (const node of allNodes) {
      if (!SEARCHABLE_TYPES.has(node.type) || !node.bodyScript) continue;
      if (node.bodyScript.toLowerCase().includes(term.toLowerCase())) {
        matches.push({ node, snippet: buildSnippet(node.bodyScript, term) });
      }
    }
    return matches;
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
          <div className="px-3 pb-1">
            {[...grouped.entries()].map(([label, items]) => (
              <details key={label} open>
                <summary>{label} ({items.length})</summary>
                {items.map(r => (
                  <div
                    key={r.node.id}
                    className="ln-detail-search-result"
                    onClick={() => onResultClick(r.node.id)}
                  >
                    <div className="text-xs font-medium" style={{ color: 'var(--ln-fg)' }}>
                      [{r.node.schema}].{r.node.name}
                    </div>
                    <div className="ln-detail-search-snippet">
                      {highlightSnippet(r.snippet)}
                    </div>
                  </div>
                ))}
              </details>
            ))}
          </div>
          <div className="px-3 py-2 text-[11px] border-t" style={{ color: 'var(--ln-fg-muted)', borderColor: 'var(--ln-border-light)' }}>
            {results.length} result{results.length !== 1 ? 's' : ''}
          </div>
        </>
      )}
    </SidePanel>
  );
});
