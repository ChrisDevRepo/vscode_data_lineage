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
  /**
   * IDs of nodes currently rendered in the graph after all active filters.
   * When provided, results whose node ID is absent are rendered dimmed with a
   * "Not in current view" separator — matching Quick Jump behavior.
   */
  visibleNodeIds?: Set<string>;
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

/** Props for a single Detail Search result row. */
interface ResultRowProps {
  result: SearchResult;
  term: string;
  onResultClick: (nodeId: string, searchTerm: string) => void;
  /** When true, renders at reduced opacity with a ⊘ out-of-scope indicator. */
  dimmed?: boolean;
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

/** Groups search results by display label, preserving insertion order. */
function groupByType(items: SearchResult[]): Map<string, SearchResult[]> {
  const map = new Map<string, SearchResult[]>();
  for (const r of items) {
    const label = TYPE_LABELS[r.node.type] ?? r.node.type;
    const arr = map.get(label) ?? [];
    arr.push(r);
    map.set(label, arr);
  }
  return map;
}

/**
 * Wraps every occurrence of `term` within `snippet` with a `<mark>` element.
 *
 * @param snippet - The text to annotate.
 * @param term - The search term to highlight (case-insensitive).
 * @returns An array of strings and `<mark>` React nodes.
 */
function highlightSnippet(snippet: string, term: string): React.ReactNode[] {
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

/**
 * Single Detail Search result row.
 *
 * @remarks
 * When `dimmed` is true the row renders at 0.5 opacity with a ⊘ prefix,
 * indicating the node is outside the active graph filter — matching the
 * Quick Jump (`SuggestionRow`) treatment.
 */
function ResultRow({ result, term, onResultClick, dimmed = false }: ResultRowProps) {
  return (
    <div
      className="ln-detail-search-result"
      style={dimmed ? { opacity: 0.5 } : undefined}
      onClick={() => onResultClick(result.node.id, term)}
    >
      <div className="text-xs font-medium" style={{ color: 'var(--ln-fg)' }}>
        {dimmed && (
          <span
            className="text-[10px] ln-text-dim select-none mr-1"
            title="Not visible in current view"
          >
            {'⊘'}
          </span>
        )}
        {highlightText(`[${result.node.schema}].${result.node.name}`, term)}
      </div>
      <div className="ln-detail-search-snippet">
        {highlightSnippet(result.snippet, term)}
      </div>
    </div>
  );
}

/**
 * A specialized sidebar component for performing full-text searches across object definitions
 * and column metadata.
 *
 * @remarks
 * Searches within stored procedure / view body scripts and column names. Results from nodes
 * outside the active graph filter are rendered dimmed with a "Not in current view" separator
 * when `visibleNodeIds` is supplied — consistent with Quick Jump behavior.
 *
 * Performance: `useDeferredValue` prevents UI lock during heavy searches.
 */
export const DetailSearchSidebar = memo(function DetailSearchSidebar({
  onClose,
  allNodes,
  onResultClick,
  visibleNodeIds,
}: DetailSearchSidebarProps) {
  const [input, setInput] = useState('');
  const deferredInput = useDeferredValue(input);
  const term = deferredInput.trim();

  const results = useMemo<SearchResult[]>(() => {
    const q = term;
    const bodyResults = searchBodyScripts(allNodes, q, BODY_TYPES);
    const colResults = searchColumns(allNodes, q);
    return [...bodyResults, ...colResults];
  }, [term, allNodes]);

  // Split flat results on filter visibility, then group each partition by type.
  const { inScope, outOfScope } = useMemo(() => {
    if (!visibleNodeIds) return { inScope: results, outOfScope: [] as SearchResult[] };
    const inScope: SearchResult[] = [];
    const outOfScope: SearchResult[] = [];
    for (const r of results) {
      (visibleNodeIds.has(r.node.id) ? inScope : outOfScope).push(r);
    }
    return { inScope, outOfScope };
  }, [results, visibleNodeIds]);

  const groupedInScope  = useMemo(() => groupByType(inScope),   [inScope]);
  const groupedOutScope = useMemo(() => groupByType(outOfScope), [outOfScope]);

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
                {[...groupedInScope.entries()].map(([label, items]) => (
                  <div key={label} className="mb-2">
                    <div
                      className="text-[10px] font-semibold uppercase tracking-wide py-1.5 mb-1"
                      style={{ color: 'var(--ln-fg-muted)', borderBottom: '1px solid var(--ln-border-light)' }}
                    >
                      {label} ({items.length})
                    </div>
                    {items.map(r => (
                      <ResultRow key={r.node.id} result={r} term={term} onResultClick={onResultClick} />
                    ))}
                  </div>
                ))}

                {outOfScope.length > 0 && (
                  <>
                    <div
                      className="px-2 py-1 text-[10px] uppercase tracking-wide border-t ln-text-dim ln-border"
                      style={{ marginTop: groupedInScope.size > 0 ? '4px' : undefined }}
                    >
                      Not in current view {'⊘'}
                    </div>
                    {[...groupedOutScope.entries()].map(([label, items]) => (
                      <div key={label} className="mb-2">
                        <div
                          className="text-[10px] font-semibold uppercase tracking-wide py-1.5 mb-1"
                          style={{ color: 'var(--ln-fg-muted)', borderBottom: '1px solid var(--ln-border-light)', opacity: 0.5 }}
                        >
                          {label} ({items.length})
                        </div>
                        {items.map(r => (
                          <ResultRow key={r.node.id} result={r} term={term} onResultClick={onResultClick} dimmed />
                        ))}
                      </div>
                    ))}
                  </>
                )}
              </div>

              <div
                className="px-3 py-2 text-[11px] border-t"
                style={{ color: 'var(--ln-fg-muted)', borderColor: 'var(--ln-border-light)' }}
              >
                {results.length} result{results.length !== 1 ? 's' : ''}
              </div>
            </>
          )}
        </>
      )}
    </SidePanel>
  );
});
