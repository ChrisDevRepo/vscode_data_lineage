import { memo, useMemo, useState } from 'react';
import {
  useFloating,
  useHover,
  useInteractions,
  FloatingPortal,
  offset,
  flip,
  shift,
  autoUpdate,
} from '@floating-ui/react';
import type { CatalogEntry, NeighborIndex, ParseStats } from '../engine/types';
import { TYPE_COLORS } from '../utils/schemaColors';
import { Tooltip } from './ui/Tooltip';

/**
 * Props for the {@link NodeInfoBar} component.
 */
interface NodeInfoBarProps {
  /** ID of the node currently under inspection. */
  nodeId: string;
  /** Full catalog of all objects in the model. */
  catalog: Record<string, CatalogEntry>;
  /** Index of all input/output edges in the graph. */
  neighborIndex: NeighborIndex;
  /** Set of node IDs currently visible in the graph view. */
  visibleNodeIds: Set<string>;
  /** Optional parsing statistics for SP dependency analysis. */
  parseStats?: ParseStats;
  /** Callback fired when the user closes the info bar. */
  onClose: () => void;
}


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
  const [isOpen, setIsOpen] = useState(false);

  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'top-start',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(6),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
    ],
  });

  const hover = useHover(context, { delay: { open: 150, close: 100 }, move: false });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover]);

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
    <>
      <span
        ref={refs.setReference}
        {...getReferenceProps()}
        className="ln-text cursor-default"
      >
        {label}: {count}
      </span>

      <FloatingPortal>
        {isOpen && (
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className="z-50 min-w-[260px] rounded shadow-lg py-1.5 px-2 text-xs ln-popover"
            {...getFloatingProps()}
          >
            {sortedSchemas.map(([schema, items]) => (
              <div key={schema}>
                <div className="text-[10px] uppercase tracking-wide ln-text pt-1.5 pb-0.5 first:pt-0 border-b ln-border">
                  {schema || 'External'}
                </div>
                {items.map(({ id, entry }) => {
                  const icon = (entry.externalType === 'file' || entry.externalType === 'db')
                    ? '⬡'
                    : entry.externalType === 'et' ? '⬢'
                    : (TYPE_COLORS[entry.type]?.icon ?? '?');
                  const hidden = !visibleNodeIds.has(id);
                  return (
                    <div key={id} className={`py-0.5 flex items-center gap-1 whitespace-nowrap ${hidden ? 'ln-text-dim' : 'ln-text'}`}>
                      <span className="opacity-60 select-none">{icon}</span>
                      <span className={`flex-1${hidden ? ' opacity-50' : ''}`}>{entry.name}</span>
                      {hidden && (
                        <Tooltip content="Not visible in current graph view">
                          <span className="ml-2 opacity-50 text-[10px] select-none">⊘</span>
                        </Tooltip>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </FloatingPortal>
    </>
  );
}


function SimpleHoverList({ label, count, items }: { label: string; count: number; items: string[] }) {
  const [isOpen, setIsOpen] = useState(false);

  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'top-start',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(6),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
    ],
  });

  const hover = useHover(context, { delay: { open: 150, close: 100 }, move: false });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover]);

  if (count === 0) return <span className="ln-text-dim">{label}: 0</span>;

  return (
    <>
      <span
        ref={refs.setReference}
        {...getReferenceProps()}
        className="ln-text cursor-default"
      >
        {label}: {count}
      </span>

      <FloatingPortal>
        {isOpen && (
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className="z-50 min-w-[240px] rounded shadow-lg py-1.5 px-2 text-xs ln-popover"
            {...getFloatingProps()}
          >
            {items.map((item) => (
              <div key={item} className="py-0.5 ln-text whitespace-nowrap">{item}</div>
            ))}
          </div>
        )}
      </FloatingPortal>
    </>
  );
}


/**
 * A horizontal bar that displays detailed technical metadata for a selected node.
 * 
 * The bar provides:
 * - **Identity**: Icon and qualified name (schema.object) of the node.
 * - **Connectivity**: Interactive counts for 'In' and 'Out' neighbors with schema-grouped hover lists.
 * - **Analysis**: Hoverable lists for unresolved references (e.g., missing tables) and excluded 
 *   references (filtered by user patterns).
 * 
 * Architectural Remark: This component is designed to be highly responsive, updating 
 * immediately as the user clicks different nodes in the graph. It uses `@floating-ui` 
 * for the hover popovers to ensure they remain visible regardless of the bar's position.
 */
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
    <div className="flex items-center gap-4 px-3 py-1.5 text-xs ln-infobar w-full">
      <span className="font-medium ln-text truncate">
        {icon} {entry.schema ? `${entry.schema}.${entry.name}` : entry.name}
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
      <Tooltip content="Close details">
        <button
          onClick={onClose}
          aria-label="Close details"
          className="ml-auto ln-text-dim hover:opacity-80 text-sm leading-none"
        >
          ✕
        </button>
      </Tooltip>
    </div>
  );
});
