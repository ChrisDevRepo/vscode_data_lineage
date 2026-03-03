import { memo, useMemo } from 'react';
import type { CatalogEntry, NeighborIndex, ParseStats } from '../engine/types';
import { TYPE_COLORS } from '../utils/schemaColors';

interface NodeInfoBarProps {
  nodeId: string;
  catalog: Record<string, CatalogEntry>;
  neighborIndex: NeighborIndex;
  visibleNodeIds: Set<string>;
  parseStats?: ParseStats;
  onClose: () => void;
}

// ─── Neighbor Hover List ──────────────────────────────────────────────────────

/**
 * Hoverable badge showing In or Out count.
 * On hover: schema-grouped, alphabetically sorted list.
 * ⊘ suffix = object is known but not rendered in the current graph
 *   (filtered out by type-filter, focus-schema, search, or maxNodes cap).
 */
function NeighborHoverList({
  label, count, ids, catalog, visibleNodeIds,
}: {
  label: string;
  count: number;
  ids: string[];
  catalog: Record<string, CatalogEntry>;
  visibleNodeIds: Set<string>;
}) {
  if (count === 0) return <span className="ln-text-dim">{label}: 0</span>;

  // Group by schema, sorted alphabetically
  const bySchema = new Map<string, Array<{ id: string; entry: CatalogEntry }>>();
  for (const id of ids) {
    const entry = catalog[id];
    if (!entry) continue;
    const schema = entry.schema;
    if (!bySchema.has(schema)) bySchema.set(schema, []);
    bySchema.get(schema)!.push({ id, entry });
  }
  const sortedSchemas = Array.from(bySchema.entries()).sort(([a], [b]) => a.localeCompare(b));
  for (const [, items] of sortedSchemas) {
    items.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
  }

  return (
    <span className="relative group cursor-default">
      <span className="ln-text">{label}: {count}</span>
      <div className="absolute bottom-full left-0 mb-1 hidden group-hover:block z-50 min-w-[260px] rounded shadow-lg py-1.5 px-2 text-xs ln-modal">
        {sortedSchemas.map(([schema, items]) => (
          <div key={schema}>
            <div className="text-[10px] uppercase tracking-wide ln-text pt-1.5 pb-0.5 first:pt-0 border-b ln-border">
              {schema}
            </div>
            {items.map(({ id, entry }) => {
              const icon = TYPE_COLORS[entry.type]?.icon ?? '?';
              const hidden = !visibleNodeIds.has(id);
              return (
                <div key={id} className={`py-0.5 flex items-center gap-1 whitespace-nowrap ${hidden ? 'ln-text-dim' : 'ln-text'}`}>
                  <span className="opacity-60 select-none">{icon}</span>
                  <span className={`flex-1${hidden ? ' opacity-50' : ''}`}>{entry.name}</span>
                  {hidden && (
                    <span className="ml-2 opacity-50 text-[10px] select-none" title="Not visible in current graph view">⊘</span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </span>
  );
}

// ─── Simple Plain-text Hover List ─────────────────────────────────────────────

function SimpleHoverList({ label, count, items }: { label: string; count: number; items: string[] }) {
  if (count === 0) return <span className="ln-text-dim">{label}: 0</span>;
  return (
    <span className="relative group cursor-default">
      <span className="ln-text">{label}: {count}</span>
      <div className="absolute bottom-full left-0 mb-1 hidden group-hover:block z-50 min-w-[240px] rounded shadow-lg py-1.5 px-2 text-xs ln-modal">
        {items.map((item) => (
          <div key={item} className="py-0.5 ln-text whitespace-nowrap">{item}</div>
        ))}
      </div>
    </span>
  );
}

// ─── NodeInfoBar ──────────────────────────────────────────────────────────────

export const NodeInfoBar = memo(function NodeInfoBar({
  nodeId, catalog, neighborIndex, visibleNodeIds, parseStats, onClose,
}: NodeInfoBarProps) {
  const entry = catalog[nodeId];
  const neighbors = neighborIndex[nodeId] ?? { in: [], out: [] };

  const spDetail = useMemo(() => {
    if (!entry || !parseStats) return null;
    const spLabel = `${entry.schema}.${entry.name}`;
    return parseStats.spDetails.find(
      sp => sp.name.toLowerCase() === spLabel.toLowerCase()
    ) ?? null;
  }, [entry, parseStats]);

  const unresolvedItems = spDetail?.unrelated ?? [];
  const excludedItems = spDetail?.excluded ?? [];

  if (!entry) return null;

  const icon = TYPE_COLORS[entry.type]?.icon ?? '?';

  return (
    <div className="flex items-center gap-4 px-3 py-1.5 text-xs ln-infobar">
      <span className="font-medium ln-text truncate">
        {icon} {entry.schema}.{entry.name}
      </span>
      <span className="ln-text-dim">|</span>
      <NeighborHoverList
        label="In" count={neighbors.in.length} ids={neighbors.in}
        catalog={catalog} visibleNodeIds={visibleNodeIds}
      />
      <span className="ln-text-dim">|</span>
      <NeighborHoverList
        label="Out" count={neighbors.out.length} ids={neighbors.out}
        catalog={catalog} visibleNodeIds={visibleNodeIds}
      />
      <span className="ln-text-dim">|</span>
      <SimpleHoverList label="Unresolved" count={unresolvedItems.length} items={unresolvedItems} />
      <span className="ln-text-dim">|</span>
      <SimpleHoverList label="Excluded" count={excludedItems.length} items={excludedItems} />
      <button
        onClick={onClose}
        className="ml-auto ln-text-dim hover:opacity-80 text-sm leading-none"
        title="Close details"
      >
        ✕
      </button>
    </div>
  );
});
