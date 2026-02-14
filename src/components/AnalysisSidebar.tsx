import { memo, useCallback } from 'react';
import type Graph from 'graphology';
import type { AnalysisMode, AnalysisType, AnalysisGroup } from '../engine/types';
import { SidePanel } from './SidePanel';
import { ANALYSIS_TYPE_INFO } from '../utils/analysisInfo';

interface AnalysisSidebarProps {
  analysis: AnalysisMode;
  graph?: Graph | null;
  onSelectGroup: (groupId: string) => void;
  onClearGroup: () => void;
  onClose: () => void;
}

export const AnalysisSidebar = memo(function AnalysisSidebar({
  analysis,
  graph,
  onSelectGroup,
  onClearGroup,
  onClose,
}: AnalysisSidebarProps) {
  const info = ANALYSIS_TYPE_INFO[analysis.type];
  const { result, activeGroupId } = analysis;

  const handleGroupClick = useCallback(
    (groupId: string) => {
      if (activeGroupId === groupId) {
        onClearGroup();
      } else {
        onSelectGroup(groupId);
      }
    },
    [activeGroupId, onSelectGroup, onClearGroup]
  );

  const icon = (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4" style={{ color: 'var(--ln-sidebar-header-fg)' }}>
      <path strokeLinecap="round" strokeLinejoin="round" d={info.icon} />
    </svg>
  );

  return (
    <SidePanel title={info.title} icon={icon} onClose={onClose}>
      {/* Description */}
      <div className="px-3 py-2 text-[11px]" style={{ color: 'var(--ln-fg-muted)', borderBottom: '1px solid var(--ln-border-light)' }}>
        {info.description}
      </div>

      {/* Summary */}
      <div className="px-3 py-1.5 text-xs font-medium" style={{ color: 'var(--ln-fg)' }}>
        {result.summary}
      </div>

      {/* Groups list */}
      <div className="ln-analysis-groups">
        {result.groups.length === 0 ? (
          <div className="px-3 py-4 text-xs text-center" style={{ color: 'var(--ln-fg-muted)' }}>
            None found.
          </div>
        ) : (
          result.groups.map((group) => (
            <AnalysisGroupItem
              key={group.id}
              group={group}
              analysisType={analysis.type}
              isActive={activeGroupId === group.id}
              onClick={() => handleGroupClick(group.id)}
              graph={graph}
            />
          ))
        )}
      </div>

      {/* Active filter indicator */}
      {activeGroupId && (
        <div className="px-3 py-2 text-[11px] border-t flex items-center justify-between" style={{ color: 'var(--ln-fg-muted)', borderColor: 'var(--ln-border-light)' }}>
          <span>Viewing subset</span>
          <button
            onClick={onClearGroup}
            className="text-[11px] px-1.5 py-0.5 rounded hover:opacity-80"
            style={{ color: 'var(--ln-text-link)' }}
          >
            Show all
          </button>
        </div>
      )}
    </SidePanel>
  );
});

// ─── Individual Group Item ──────────────────────────────────────────────────

interface AnalysisGroupItemProps {
  group: AnalysisGroup;
  analysisType: AnalysisType;
  isActive: boolean;
  onClick: () => void;
  graph?: Graph | null;
}

const AnalysisGroupItem = memo(function AnalysisGroupItem({
  group,
  analysisType,
  isActive,
  onClick,
  graph,
}: AnalysisGroupItemProps) {
  return (
    <div
      className={`ln-analysis-group-item ${isActive ? 'ln-analysis-group-active' : ''}`}
      onClick={onClick}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium truncate" style={{ color: 'var(--ln-fg)' }}>
          {group.label}
        </span>
        <span className="text-[11px] ml-2 flex-shrink-0" style={{ color: 'var(--ln-fg-muted)' }}>
          {group.nodeIds.length} node{group.nodeIds.length !== 1 ? 's' : ''}
        </span>
      </div>
      {group.meta && (
        <div className="text-[11px] mt-0.5" style={{ color: 'var(--ln-fg-muted)' }}>
          {renderMeta(group.meta, analysisType, group.nodeIds, graph)}
        </div>
      )}
    </div>
  );
});

function renderMeta(
  meta: Record<string, string | number>,
  type: AnalysisType,
  nodeIds: string[],
  graph?: Graph | null
): string {
  switch (type) {
    case 'islands':
      return `Schemas: ${meta.schemas}`;
    case 'hubs': {
      // Use live graph data when available (consistent with NodeInfoBar)
      if (graph && nodeIds.length === 1 && graph.hasNode(nodeIds[0])) {
        const id = nodeIds[0];
        return `${meta.type} — in: ${graph.inDegree(id)}, out: ${graph.outDegree(id)}`;
      }
      return `${meta.type} — in: ${meta.inDegree}, out: ${meta.outDegree}`;
    }
    case 'orphans':
      return `${meta.count} ${meta.type}${Number(meta.count) !== 1 ? 's' : ''}`;
    case 'longest-path':
      return `${meta.from} → ${meta.to}`;
    case 'cycles':
      return `${meta.count} node${Number(meta.count) !== 1 ? 's' : ''}`;
  }
}
