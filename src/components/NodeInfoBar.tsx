import { memo, useMemo } from 'react';
import type Graph from 'graphology';
import type { DacpacModel, ObjectType } from '../engine/types';
import { TYPE_COLORS } from '../utils/schemaColors';

interface NodeInfoBarProps {
  nodeId: string;
  model: DacpacModel;
  graph: Graph;
  onClose: () => void;
}

function HoverList({ label, count, items }: { label: string; count: number; items: string[] }) {
  if (count === 0) return <span className="ln-text-dim">{label}: 0</span>;
  return (
    <span className="relative group cursor-default">
      <span className="ln-text">{label}: {count}</span>
      <div className="absolute bottom-full left-0 mb-1 hidden group-hover:block z-50 min-w-[240px] rounded shadow-lg py-1.5 px-2 text-xs ln-modal">
        {items.map((item, i) => (
          <div key={i} className="py-0.5 ln-text whitespace-nowrap">{item}</div>
        ))}
      </div>
    </span>
  );
}

export const NodeInfoBar = memo(function NodeInfoBar({ nodeId, model, graph, onClose }: NodeInfoBarProps) {
  const node = useMemo(() => model.nodes.find(n => n.id === nodeId), [model, nodeId]);

  const inItems = useMemo(() => {
    if (!graph || !graph.hasNode(nodeId)) return [];
    return graph.inNeighbors(nodeId).map(nId => {
      const n = model.nodes.find(nd => nd.id === nId);
      if (!n) return nId;
      const icon = TYPE_COLORS[n.type]?.icon || '?';
      return `${icon} ${n.schema}.${n.name}`;
    });
  }, [graph, nodeId, model]);

  const outItems = useMemo(() => {
    if (!graph || !graph.hasNode(nodeId)) return [];
    return graph.outNeighbors(nodeId).map(nId => {
      const n = model.nodes.find(nd => nd.id === nId);
      if (!n) return nId;
      const icon = TYPE_COLORS[n.type]?.icon || '?';
      return `${icon} ${n.schema}.${n.name}`;
    });
  }, [graph, nodeId, model]);

  const spDetail = useMemo(() => {
    if (!node || !model.parseStats) return null;
    const spLabel = `${node.schema}.${node.name}`;
    return model.parseStats.spDetails.find(
      sp => sp.name.toLowerCase() === spLabel.toLowerCase()
    ) || null;
  }, [node, model]);

  const unresolvedItems = spDetail?.unrelated || [];
  const excludedItems = spDetail?.excluded || [];

  if (!node) return null;

  const icon = TYPE_COLORS[node.type]?.icon || '?';

  return (
    <div className="flex items-center gap-4 px-3 py-1.5 text-xs ln-infobar">
      <span className="font-medium ln-text truncate">
        {icon} {node.schema}.{node.name}
      </span>
      <span className="ln-text-dim">|</span>
      <HoverList label="In" count={inItems.length} items={inItems} />
      <span className="ln-text-dim">|</span>
      <HoverList label="Out" count={outItems.length} items={outItems} />
      <span className="ln-text-dim">|</span>
      <HoverList label="Unresolved" count={unresolvedItems.length} items={unresolvedItems} />
      <span className="ln-text-dim">|</span>
      <HoverList label="Excluded" count={excludedItems.length} items={excludedItems} />
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
