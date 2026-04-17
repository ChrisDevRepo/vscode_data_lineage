import { useState, useMemo, useDeferredValue, memo } from 'react';
import type { ObjectType, ColumnDef } from '../engine/types';
import { SidePanel } from './SidePanel';
import { searchBodyScripts, searchColumns } from '../utils/modelSearch';
import { highlightText } from './highlight';

/**
 * A specialized node representation used for high-performance detail searching.
 */
export interface DetailSearchNode {
  /** The unique ID of the object. */
  id: string;
  /** The human-readable name of the object. */
  name: string;
  /** The schema the object belongs to. */
  schema: string;
  /** The classification of the object. */
  type: ObjectType;
  /** The raw SQL body script (stored procedure definition, view definition, etc.). */
  bodyScript?: string;
  /** The array of column definitions for the object. */
  columns?: ColumnDef[];
}

/**
 * Props for the `DetailSearchSidebar` component.
 */
interface DetailSearchSidebarProps {
  /** Callback triggered to close the sidebar. */
  onClose: () => void;
  /** The complete set of searchable nodes. */
  allNodes: DetailSearchNode[];
  /** 
   * Callback triggered when a search result is clicked.
   * @param nodeId - The ID of the target node.
   * @param searchTerm - The term that was searched for.
   */
  onResultClick: (nodeId: string, searchTerm: string) => void;
}

/**
 * Internal representation of a search match.
 */
interface SearchResult {
  /** The node that matched the query. */
  node: DetailSearchNode;
  /** A textual snippet containing the match. */
  snippet: string;
}

/** Display labels for grouped search results. */
const TYPE_LABELS: Partial<Record<ObjectType, string>> = {
  procedure: 'Procedures',
  view: 'Views',
  table: 'Tables',
  external: 'External Tables',
};

/** Set of object types that typically contain a SQL body script. */
const BODY_TYPES = new Set<ObjectType>(['procedure', 'view']);

/**
 * A specialized sidebar component for performing full-text searches across object definitions
 * and column metadata.
 * 
 * @remarks
 * This component implements a high-performance "Detail Search" that goes beyond simple node titles.
 * It searches within:
 * - Stored Procedure and View body scripts.
 * - Column names and types.
 * 
 * Performance features:
 * - Uses `useDeferredValue` to prevent the UI from locking during heavy search operations.
 * - Implements result grouping by object type.
 * - Provides snippet-based highlighting of the search term.
 * 
 * @param props - The component props.
 */
export const DetailSearchSidebar = memo(function DetailSearchSidebar({
  onClose,
  allNodes,
  onResultClick,
}: DetailSearchSidebarProps) {
  const [input, setInput] = useState('');
  const deferredInput = useDeferredValue(input);

  /**
   * Calculates search results based on the current input.
   * Searches both body scripts and column metadata.
   */
  const results = useMemo<SearchResult[]>(() => {
    const q = deferredInput.trim();
    const bodyResults = searchBodyScripts(allNodes, q, BODY_TYPES);
    const colResults = searchColumns(allNodes, q);
    return [...bodyResults, ...colResults];
  }, [deferredInput, allNodes]);

  /**
   * Groups search results by their object type for better readability.
   */
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

  /**
   * Wraps matching substrings within a snippet with `<mark>` tags for highlighting.
   * 
   * @param snippet - The text snippet to process.
   * @returns An array of strings and React nodes.
   */
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
